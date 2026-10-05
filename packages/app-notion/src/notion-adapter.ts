// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Notion Adapter.
 *
 * Auth contract: Notion's private web API (`https://app.notion.com/api/v3/…`)
 * is authorized by the BROWSER SESSION COOKIE — `token_v2`, sent in the
 * `Cookie:` header. There is no bearer token, no query param, and no public
 * integration token involved. `buildReplayRequest` therefore sets `Cookie` from
 * `credentials.values.cookieHeader` (minted by chrome-cookies.ts) and adds the
 * three headers Notion's own client sends alongside it:
 *
 *   notion-audit-log-platform: web      — sent on every call
 *   x-notion-active-user-header: <uuid> — which signed-in account to act as
 *   x-notion-space-id: <uuid>           — which workspace the call is scoped to
 *
 * Only the first is constant. The account header decides the answer when one
 * cookie jar holds several Notion logins, so omitting it on a multi-account
 * machine silently returns another account's data rather than failing.
 *
 * Four facts about Notion shape everything below:
 *
 *   1. **Every read endpoint returns the same envelope** — a `recordMap` of
 *      table → id → record. The endpoints differ only in which tables they
 *      fill, so `parse` is one recordMap walk and not one branch per path.
 *      See record-map.ts.
 *
 *   2. **There is no page cursor anywhere in the read API.** `loadPageChunk`
 *      has a `cursor.stack` for *long single pages*, `queryCollection` answers
 *      the whole view up to `limit`, and quick-find `search` returns a
 *      `paginationToken` that is a session timestamp, not an offset — passing it
 *      back returns the identical first page (verified against a live
 *      workspace). So, as with Trello, the real "next work" is FAN-OUT: a page
 *      names its child pages, a database view names its rows, and each of those
 *      is one more `loadPageChunk`. Two traps inside that, both verified live:
 *      `queryCollection` applies NOTHING from the view unless the view's own
 *      `query2.filter` / `query2.sort` are sent in the loader (a board filtered
 *      to one assignee otherwise returns the whole database), and it inlines at
 *      most 1,000 row records however large the limit, while
 *      `reducerResults.*.blockIds` names every row and `hasMore` stays false —
 *      1,462 named against 1,000 delivered on one database here. The rest have
 *      to be asked for by id via `syncRecordValues`.
 *
 *   3. **A database row IS a page.** Rows come back as `type: 'page'` blocks
 *      with `parent_table: 'collection'`, so the same code path yields both, and
 *      `containerId` is simply the parent id whatever table it points at.
 *
 *   4. **It serves its SPA and its API from the same host.** `app.notion.com`
 *      carries `/api/v3/*` alongside every JS bundle and SVG icon, so
 *      `matchRequest` is host-only and `classify` is what keeps the traffic
 *      table readable.
 *
 * Parsing is deliberately defensive — record shapes vary by table and fields go
 * missing — so unknown shapes yield an empty ParseResult rather than throwing.
 * `classify` and `nextCursors` run in the same ingest funnel for every capture
 * and are held to the same rule: they must never throw.
 */
import { operationName } from '@sluice/core';
import type {
  Actor,
  Adapter,
  Capture,
  CaptureClass,
  Container,
  CursorSeed,
  Edge,
  Item,
  ParseContext,
  ParseResult,
  ReconcileOutcome,
  ReconcileStore,
  ReplayAction,
  ReplayRequest,
  Session,
  Workspace,
} from '@sluice/core';
import {
  actionParam,
  arr,
  CHROME_UA,
  compact,
  num,
  obj,
  requestParams,
  requireActionParam,
  safeJson,
  safeJsonObject,
  str,
} from '@sluice/adapter-sdk';
import {
  recordMaps,
  recordTitle,
  recordTs,
  tableRecords,
  plainText,
  type NotionRecord,
} from './record-map.js';

export const ADAPTER_ID = 'notion';

/** A string that is actually there — Notion writes `''` where a field is absent. */
function nonEmpty(v: unknown): string | undefined {
  const t = str(v);
  return t !== undefined && t.length > 0 ? t : undefined;
}

/** Where the private API lives. `www.notion.so` still redirects here. */
export const API_ORIGIN = 'https://app.notion.com';

/**
 * The header set Notion's own web client sends (its API rejects non-browser
 * agents), plus the session cookie and the active-user header when there are
 * values for them. Shared by `buildReplayRequest` and the MCP tools so the two
 * cannot drift. The result carries the SECRET cookie — never log it.
 */
export function notionHeaders(cookieHeader?: string, activeUserId?: string): Record<string, string> {
  return {
    'User-Agent': CHROME_UA,
    Accept: '*/*',
    'Content-Type': 'application/json',
    Origin: API_ORIGIN,
    Referer: `${API_ORIGIN}/`,
    'notion-audit-log-platform': 'web',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(activeUserId ? { 'x-notion-active-user-header': activeUserId } : {}),
  };
}

// ── Matching ─────────────────────────────────────────────────────────────────────

/**
 * Notion owns two registrable domains and uses both at once: the app moved to
 * `notion.com`, while file attachments, the marketing site and a good deal of
 * older link surface are still on `notion.so`. Claim both.
 */
function matchesNotion(host: string): boolean {
  return (
    host === 'notion.com' ||
    host === 'notion.so' ||
    host.endsWith('.notion.com') ||
    host.endsWith('.notion.so')
  );
}

// ── Path shapes ──────────────────────────────────────────────────────────────────

/**
 * Notion's API path shapes, written down once.
 *
 * Every read is `POST /api/v3/<operation>` — there are no path parameters and no
 * REST nouns, so these are exact names rather than patterns. `parse`, `classify`
 * and `nextCursors` all consult the same sets; three private copies of the same
 * name list is exactly how three guards drift.
 */
const API_PREFIX = '/api/v3/';

/** The operation name, or '' for anything that is not an `/api/v3/` call. */
function apiOperation(path: string): string {
  if (!path.startsWith(API_PREFIX)) return '';
  return path.slice(API_PREFIX.length).split(/[/?]/)[0] ?? '';
}

/** Reads that describe the shape of the account. */
const STRUCTURE_OPS = new Set([
  'getSpaces',
  'getSpacesInitial',
  'getSpacesFanout',
  'loadUserContent',
  'getTeamsV2',
  'getSidebarSections',
  'getUserHomePages',
  'getUserSharedPagesInSpace',
  'getVisibleUsers',
  'getExtendedUserProfiles',
  'syncRecordValues',
  'syncRecordValuesMain',
  'syncRecordValuesSpaceInitial',
  'search',
  'getPublicSpaceData',
  'getAllSpacePermissionGroupsWithMemberCount',
]);

/** Reads that carry the contents of a container. */
const CONTENT_OPS = new Set([
  'loadPageChunk',
  'loadCachedPageChunkV2',
  'queryCollection',
  'getBacklinksForBlockInitial',
  'getPublicPageData',
  'getUserSignals',
]);

/**
 * Telemetry, experiment and presence chatter. Notion emits a great deal of it —
 * `ping` alone was 64 of the first 2,885 captures — and none of it describes the
 * account. Marked `asset` so it stays out of the traffic table's signal and out
 * of recorded fixtures.
 */
const NOISE_OPS = new Set([
  'ping',
  'etClient',
  'getUserAnalyticsSettings',
  'recordActivity',
  'getRecentPageVisits',
  'getInferenceTranscriptsUnreadCount',
  'getUnreadInAppMessagesForUser',
  'getCreditRateLimitStatus',
]);

// ── Entity builders ──────────────────────────────────────────────────────────────

function spaceToWorkspace(record: NotionRecord): Workspace | undefined {
  const id = str(record.id);
  if (!id) return undefined;
  return {
    id,
    adapterId: ADAPTER_ID,
    name: recordTitle(record) || id,
    domain: str(record.domain),
    raw: record,
  };
}

function userToActor(record: NotionRecord, workspaceId: string): Actor | undefined {
  const id = str(record.id);
  if (!id) return undefined;
  // `email` is "" on every notion_user but the signed-in user's own (see nonEmpty).
  const email = nonEmpty(record.email);
  const given = str(record.given_name);
  const family = str(record.family_name);
  const composed = [given, family].filter(Boolean).join(' ');
  return {
    id,
    workspaceId,
    adapterId: ADAPTER_ID,
    // Email is the handle people actually use to identify a colleague here, and
    // it is the join key against Slack and Trello. Falling back to the uuid
    // keeps the entity rather than dropping a user with a hidden email.
    handle: email ?? id,
    displayName: str(record.name) ?? (composed || undefined),
    avatarUrl: str(record.profile_photo),
    raw: record,
  };
}

/**
 * A teamspace. `kind: 'group'` rather than 'project': a teamspace is a
 * membership boundary that holds many unrelated pages, which is what 'group'
 * means in the shared vocabulary.
 */
function teamToContainer(record: NotionRecord, workspaceId: string): Container | undefined {
  const id = str(record.id);
  if (!id) return undefined;
  const pages = arr(record.team_pages);
  const membership = obj(record.membership);
  return {
    id,
    workspaceId,
    adapterId: ADAPTER_ID,
    kind: 'group',
    name: recordTitle(record) || id,
    isPrivate: str(obj(record.settings)?.access_level) === 'private' ? true : undefined,
    memberCount: arr(membership?.members)?.length,
    itemCount: pages?.length,
    raw: record,
  };
}

/**
 * A database. `kind: 'board'` because that is what a Notion database is in the
 * shared vocabulary — a named collection of items with a schema, whatever view
 * (table, board, calendar, gallery) happens to be rendering it.
 *
 * `itemCount` is deliberately NOT set: a `collection` record names its schema,
 * not its rows. The row count only exists in a `queryCollection` answer, and
 * inferring it from however many rows a capture happened to carry is exactly
 * the "I have all of it" lie `itemCount` exists to prevent.
 */
function collectionToContainer(record: NotionRecord, workspaceId: string): Container | undefined {
  const id = str(record.id);
  if (!id) return undefined;
  return {
    id,
    workspaceId,
    adapterId: ADAPTER_ID,
    kind: 'board',
    name: recordTitle(record) || id,
    raw: record,
  };
}

/** Page-ish block types. Everything else is in-page content, not an item. */
const PAGE_TYPES = new Set(['page', 'collection_view_page']);

/**
 * A page — including a database row, which Notion stores as a `page` block whose
 * `parent_table` is `collection`.
 *
 * `containerId` is the parent id whatever table it points at (a page, a
 * database, a teamspace, or the space itself). That is honest about Notion's
 * actual containment, and it is what makes the tree reconstructable without a
 * second lookup.
 */
function blockToItem(
  record: NotionRecord,
  workspaceId: string,
  captureId: string,
): Item | undefined {
  const id = str(record.id);
  if (!id) return undefined;
  if (!PAGE_TYPES.has(str(record.type) ?? '')) return undefined;
  return {
    id,
    containerId: str(record.parent_id) ?? workspaceId,
    workspaceId,
    adapterId: ADAPTER_ID,
    kind: 'page',
    authorId: str(record.created_by_id),
    ts: recordTs(record),
    text: recordTitle(record),
    sourceCaptureIds: [captureId],
    raw: record,
  };
}

/**
 * A comment. `containerId` is the DISCUSSION, not the page: a discussion is the
 * thread, and `threadId` pointing at it is what lets replies group. The page the
 * discussion hangs off is one hop further up (`discussion.parent_id`) and is not
 * in every capture that carries the comment.
 */
function commentToItem(
  record: NotionRecord,
  workspaceId: string,
  captureId: string,
): Item | undefined {
  const id = str(record.id);
  if (!id) return undefined;
  const discussion = str(record.parent_id);
  return {
    id,
    containerId: discussion ?? workspaceId,
    workspaceId,
    adapterId: ADAPTER_ID,
    kind: 'message',
    authorId: str(record.created_by_id),
    ts: recordTs(record),
    text: plainText(record.text),
    threadId: discussion,
    sourceCaptureIds: [captureId],
    raw: record,
  };
}

// ── Parser ───────────────────────────────────────────────────────────────────────

/**
 * `getVisibleUsers` — the workspace roster.
 *
 * Two things make it unlike every other read. It answers a plain array rather
 * than a recordMap, and the space it describes appears only in the REQUEST, so
 * the workspace id is recovered with `requestParams` — the same reason Slack's
 * `conversations.history` parser has to.
 *
 * A row carries `aliases` (the person's email addresses) and `membershipType`,
 * but no display name: names live in `notion_user` records, which arrive from
 * other endpoints. So this emits an Actor keyed on the email with NO
 * displayName rather than inventing one, and the name fills in when a
 * `notion_user` record for the same id is parsed.
 */
function parseVisibleUsers(capture: Capture, body: unknown, ctx?: ParseContext): ParseResult {
  const workspaceId = ctx?.workspaceId ?? str(requestParams(capture).spaceId);
  if (!workspaceId) return {};
  const rows = arr(obj(body)?.users);
  if (!rows) return {};

  const actors: Actor[] = [];
  const edges: Edge[] = [];
  for (const row of rows) {
    const r = obj(row);
    const id = str(r?.userId);
    if (!r || !id) continue;
    const email = str(arr(r.aliases)?.[0]);
    actors.push({
      id,
      workspaceId,
      adapterId: ADAPTER_ID,
      handle: email ?? id,
      raw: r,
    });
    edges.push({
      srcKind: 'actor',
      srcId: id,
      rel: 'member-of',
      dstKind: 'workspace',
      dstId: workspaceId,
      adapterId: ADAPTER_ID,
      workspaceId,
      // A page guest is not a colleague. Keeping the distinction here is what
      // lets a reader tell 27 teammates from 97 people with a share link.
      raw: { membershipType: r.membershipType, isPageGuest: r.isPageGuest, isTeamGuest: r.isTeamGuest },
    });
  }
  return compact({
    actors: actors.length ? actors : undefined,
    edges: edges.length ? edges : undefined,
  });
}

/**
 * Turn one Notion capture into normalized entities.
 *
 * One walk over every recordMap in the body, dispatching per table. No path
 * branching: the endpoint decides which tables are present, not what they mean.
 *
 * The workspace id comes from the wrapper Notion stamps on each record
 * (`{ spaceId, value }`), falling back to the record's own `space_id` and then
 * to `ctx.workspaceId`. Records that yield none are skipped rather than filed
 * under a guessed workspace — merging two spaces is not recoverable, and this
 * account has two.
 */
export function parseNotionCapture(capture: Capture, ctx?: ParseContext): ParseResult {
  if (!matchesNotion(capture.host)) return {};
  if (!capture.path.startsWith(API_PREFIX)) return {};
  const body = safeJson(capture.resBody);
  if (body === undefined) return {};
  const op = apiOperation(capture.path);

  const workspaces = new Map<string, Workspace>();
  const actors = new Map<string, Actor>();
  const containers = new Map<string, Container>();
  const items = new Map<string, Item>();
  const edges: Edge[] = [];

  // The one non-recordMap endpoint, and the only one naming every member: a
  // `notion_user` record rides along only when that person wrote something.
  if (op === 'getVisibleUsers') return parseVisibleUsers(capture, body, ctx);

  for (const map of recordMaps(body)) {
    for (const { record } of tableRecords(map, 'space')) {
      const w = spaceToWorkspace(record);
      if (w) workspaces.set(w.id, w);
    }

    const scopeOf = (recordSpaceId?: string, record?: NotionRecord): string | undefined =>
      recordSpaceId ??
      str(record?.space_id) ??
      ctx?.workspaceId ??
      // A single-space response (a page chunk from one workspace) is unambiguous
      // even when the wrapper omits spaceId; several spaces are not, so only the
      // one-space case is inferred.
      (workspaces.size === 1 ? [...workspaces.keys()][0] : undefined);

    for (const { record, spaceId } of tableRecords(map, 'notion_user')) {
      const ws = scopeOf(spaceId, record);
      if (!ws) continue;
      const a = userToActor(record, ws);
      if (a) actors.set(a.id, a);
    }

    // space_user is the membership row, not a profile — it carries no name or
    // email, so it becomes an EDGE and never an Actor. Parsing it as one is how
    // a workspace ends up full of uuid-handled ghosts shadowing real profiles.
    for (const { record, spaceId } of tableRecords(map, 'space_user')) {
      const ws = str(record.space_id) ?? spaceId;
      const userId = str(record.user_id);
      if (!ws || !userId) continue;
      edges.push({
        srcKind: 'actor',
        srcId: userId,
        rel: 'member-of',
        dstKind: 'workspace',
        dstId: ws,
        adapterId: ADAPTER_ID,
        workspaceId: ws,
        raw: record,
      });
    }

    for (const [table, toContainer] of [['team', teamToContainer], ['collection', collectionToContainer]] as const) {
      for (const { record, spaceId } of tableRecords(map, table)) {
        const ws = scopeOf(spaceId, record);
        const c = ws ? toContainer(record, ws) : undefined;
        if (c) containers.set(c.id, c);
      }
    }

    for (const [table, toItem] of [['block', blockToItem], ['comment', commentToItem]] as const) {
      for (const { record, spaceId } of tableRecords(map, table)) {
        const ws = scopeOf(spaceId, record);
        const item = ws ? toItem(record, ws, capture.id) : undefined;
        if (!item) continue;
        items.set(item.id, item);
        if (item.authorId) {
          edges.push({
            srcKind: 'actor',
            srcId: item.authorId,
            rel: 'authored',
            dstKind: 'item',
            dstId: item.id,
            adapterId: ADAPTER_ID,
            workspaceId: item.workspaceId,
          });
        }
      }
    }

    // A discussion is the thread anchor: it is the only record that names the
    // page a comment hangs off. Without this edge a comment's container is a
    // discussion id that appears in no other table.
    for (const { id, record, spaceId } of tableRecords(map, 'discussion')) {
      const ws = scopeOf(spaceId, record);
      const parent = str(record.parent_id);
      if (!ws || !parent) continue;
      edges.push({
        srcKind: 'item',
        srcId: id,
        rel: 'discussion-on',
        dstKind: 'item',
        dstId: parent,
        adapterId: ADAPTER_ID,
        workspaceId: ws,
        raw: record,
      });
    }

    for (const { record, spaceId } of tableRecords(map, 'reaction')) {
      const ws = scopeOf(spaceId, record);
      const target = str(record.parent_id);
      if (!ws || !target) continue;
      for (const a of arr(record.actors) ?? []) {
        const actorId = str(obj(a)?.id);
        if (!actorId) continue;
        edges.push({
          srcKind: 'actor',
          srcId: actorId,
          rel: 'reacted-to',
          dstKind: 'item',
          dstId: target,
          adapterId: ADAPTER_ID,
          workspaceId: ws,
          raw: { icon: record.icon },
        });
      }
    }
  }

  // `compact`: an empty result must be `{}`, not five undefined keys.
  return compact({
    workspaces: workspaces.size ? [...workspaces.values()] : undefined,
    actors: actors.size ? [...actors.values()] : undefined,
    containers: containers.size ? [...containers.values()] : undefined,
    items: items.size ? [...items.values()] : undefined,
    edges: edges.length ? edges : undefined,
  });
}

// ── Reconciliation ───────────────────────────────────────────────────────────────

/**
 * Give every person both halves of their identity.
 *
 * No single Notion capture carries both. `getVisibleUsers` knows the EMAIL (as
 * `aliases`) and not the name; a `notion_user` record knows the NAME and sends
 * `email: ""`. Whichever is parsed last wins the row, so on this workspace a
 * roster of 124 people ended up with 122 names and 2 emails — and email is the
 * key that joins a Notion person to the same person in Slack, Trello and the
 * HR system, so losing it costs more than it looks.
 *
 * This is the case `reconcile` exists for: the answer is in the neighbouring
 * captures, not in any one of them. It re-derives both halves and re-applies
 * the merge, so running it twice writes the same rows.
 *
 * Deliberately NOT solved by having `parse` skip the poorer record: the name is
 * only ever in the poorer one.
 */
export function reconcileNotion(store: ReconcileStore): ReconcileOutcome {
  // listCaptures returns newest-first, and the 20k window should be the newest;
  // walk it oldest→newest so the latest name, avatar, email and membership win.
  // Sorting `asc` in the query instead would select the OLDEST 20k.
  const captures = store.listCaptures({ adapterId: ADAPTER_ID, limit: 20_000 }).sort((a, b) => a.ts - b.ts);
  const emails = new Map<string, string>();
  const profiles = new Map<string, { name?: string; avatar?: string; workspaceId?: string }>();
  const memberships = new Map<string, Record<string, unknown>>();

  for (const capture of captures) {
    const op = apiOperation(capture.path);
    const body = safeJson(capture.resBody);
    if (body === undefined) continue;

    if (op === 'getVisibleUsers') {
      const workspaceId = str(requestParams(capture).spaceId);
      for (const row of arr(obj(body)?.users) ?? []) {
        const r = obj(row);
        const id = str(r?.userId);
        if (!r || !id) continue;
        const email = nonEmpty(arr(r.aliases)?.[0]);
        if (email) emails.set(id, email);
        if (workspaceId) {
          memberships.set(id, {
            workspaceId,
            membershipType: r.membershipType,
            isPageGuest: r.isPageGuest,
            isTeamGuest: r.isTeamGuest,
          });
        }
      }
      continue;
    }

    for (const map of recordMaps(body)) {
      for (const { id, record, spaceId } of tableRecords(map, 'notion_user')) {
        const email = nonEmpty(record.email);
        if (email) emails.set(id, email);
        const prev = profiles.get(id);
        profiles.set(id, {
          name: nonEmpty(record.name) ?? prev?.name,
          avatar: nonEmpty(record.profile_photo) ?? prev?.avatar,
          workspaceId: spaceId ?? str(record.space_id) ?? prev?.workspaceId,
        });
      }
    }
  }

  const actors: Actor[] = [];
  const ids = new Set([...emails.keys(), ...profiles.keys()]);
  for (const id of ids) {
    const membership = memberships.get(id);
    const workspaceId = str(membership?.workspaceId) ?? profiles.get(id)?.workspaceId;
    if (!workspaceId) continue;
    const profile = profiles.get(id);
    actors.push({
      id,
      workspaceId,
      adapterId: ADAPTER_ID,
      handle: emails.get(id) ?? id,
      displayName: profile?.name,
      avatarUrl: profile?.avatar,
      raw: { ...(membership ?? {}), email: emails.get(id), name: profile?.name },
    });
  }
  if (actors.length === 0) return { changed: 0 };

  store.applyParseResult({ actors }, Date.now());
  const withEmail = actors.filter((a) => a.handle.includes('@')).length;
  const withName = actors.filter((a) => a.displayName).length;
  return {
    changed: actors.length,
    note: `merged ${actors.length} people — ${withEmail} with an email, ${withName} with a name`,
  };
}

// ── Classification ───────────────────────────────────────────────────────────────

/**
 * What kind of exchange this is, without parsing it.
 *
 * Two Notion-specific rules do the work. First, `app.notion.com` serves the SPA
 * and the API from one host, so anything outside `/api/v3/` is an `asset` —
 * that is what keeps the traffic table and `sluice apidoc` readable. Second,
 * Notion signals some failures as **HTTP 200 with `isNotionError: true`** in the
 * body (a bad `queryCollection` reducer key returns exactly that), so status
 * alone under-reports errors, the same way Slack's `{ ok: false }` does.
 */
export function classifyNotionCapture(capture: Capture): { class: CaptureClass; operation?: string } {
  const op = apiOperation(capture.path);
  const operation = op || operationName(capture.path);

  if (typeof capture.status === 'number' && capture.status >= 400) {
    return { class: 'error', operation };
  }
  if (!op) return { class: 'asset', operation };
  if (obj(safeJson(capture.resBody))?.isNotionError === true) {
    return { class: 'error', operation };
  }
  if (NOISE_OPS.has(op)) return { class: 'asset', operation };
  if (CONTENT_OPS.has(op)) return { class: 'messages', operation };
  if (STRUCTURE_OPS.has(op)) return { class: 'structure', operation };
  if (op.startsWith('getSession') || op.startsWith('sessionSync') || op === 'loginWithEmail') {
    return { class: 'auth', operation };
  }
  return { class: 'unknown', operation };
}

// ── Pagination ───────────────────────────────────────────────────────────────────

/**
 * How many seeds one capture may enqueue.
 *
 * Not a safety valve against a runaway API — Notion's fan-out is bounded by the
 * workspace, as Trello's is by the account. It is a bound on ONE capture: a
 * `queryCollection` over a large database names every row, and a single seed
 * burst that large is harder to reason about in the worklist than the same rows
 * arriving over several drains. Enqueue is deduped on
 * (adapter, action, container, cursor), so anything trimmed here is re-seeded by
 * the next capture of the same view rather than lost.
 */
const MAX_SEEDS_PER_CAPTURE = 200;

function pageSeed(pageId: string): CursorSeed {
  return {
    adapterId: ADAPTER_ID,
    actionId: 'notion.page.chunk',
    containerId: pageId,
    params: { pageId },
    reason: 'fanout',
    depth: 1,
  };
}

/** The part of a `collection_view` record that decides which rows a view shows. */
interface ViewQuery {
  filter?: Record<string, unknown>;
  sort?: unknown[];
}

/**
 * A view's `query2`, reduced to what `queryCollection` needs.
 *
 * A filter with no clauses and an empty sort are omitted rather than sent as
 * `{}` / `[]`: Notion treats them the same as absent, and a seed whose params
 * differ only by an empty object would look like a different request in the
 * worklist.
 */
function viewQueryOf(record: NotionRecord | undefined): ViewQuery | undefined {
  const q = obj(record?.query2);
  if (!q) return undefined;
  const filter = obj(q.filter);
  const clauses = arr(filter?.filters);
  const sort = arr(q.sort);
  const out: ViewQuery = {};
  if (filter && clauses && clauses.length > 0) out.filter = filter;
  if (sort && sort.length > 0) out.sort = sort;
  return out.filter || out.sort ? out : undefined;
}

function collectionSeed(
  collectionId: string,
  viewId: string,
  spaceId?: string,
  query?: ViewQuery,
): CursorSeed {
  return {
    adapterId: ADAPTER_ID,
    actionId: 'notion.collection.query',
    containerId: collectionId,
    params: {
      collectionId,
      viewId,
      ...(spaceId ? { spaceId } : {}),
      // JSON in string params (CursorSeed.params is string-typed); see fact 2 in the header.
      ...(query?.filter ? { filter: JSON.stringify(query.filter) } : {}),
      ...(query?.sort ? { sort: JSON.stringify(query.sort) } : {}),
    },
    reason: 'fanout',
    depth: 1,
  };
}

/** How many row ids one `syncRecordValues` call asks for. */
const RECORD_BATCH = 50;

/**
 * Seeds that fetch rows a `queryCollection` answer NAMED but did not DELIVER.
 *
 * Notion inlines at most 1,000 row records however large the requested limit,
 * while `reducerResults.*.blockIds` lists every row and `hasMore` still says
 * false. Those ids are pages this parser never sees unless something asks for
 * them by id — and `syncRecordValues` is the only read that does.
 *
 * `cursor` is the first id of the batch: the worklist dedupes on
 * (adapter, action, container, cursor), and without a distinct cursor every
 * batch for one database would collapse into a single seed.
 */
function recordSeeds(collectionId: string | undefined, ids: string[], spaceId?: string): CursorSeed[] {
  const seeds: CursorSeed[] = [];
  for (let i = 0; i < ids.length; i += RECORD_BATCH) {
    const batch = ids.slice(i, i + RECORD_BATCH);
    seeds.push({
      adapterId: ADAPTER_ID,
      actionId: 'notion.records.sync',
      ...(collectionId ? { containerId: collectionId } : {}),
      cursor: batch[0],
      params: { ids: batch.join(','), table: 'block', ...(spaceId ? { spaceId } : {}) },
      reason: 'cursor',
      depth: 1,
    });
  }
  return seeds;
}

/**
 * Row ids a `queryCollection` response names in its reducer results.
 *
 * Read from `result.reducerResults.<reducer>.blockIds` — the ONLY place the
 * full row inventory appears. The recordMap is a subset of it.
 */
function namedRowIds(body: unknown): string[] {
  const results = obj(obj(obj(body)?.result)?.reducerResults);
  if (!results) return [];
  const out = new Set<string>();
  for (const reducer of Object.values(results)) {
    for (const id of arr(obj(reducer)?.blockIds) ?? []) {
      const s = str(id);
      if (s) out.add(s);
    }
  }
  return [...out];
}

/**
 * The same request again, addressed from what it was made WITH.
 *
 * A rate-limited response has no body to read, so the only record of what was
 * being fetched is the request — which is why this reads `reqBody` rather than
 * the recordMap every other branch walks.
 */
function retrySeeds(capture: Capture, op: string): CursorSeed[] {
  const req = safeJsonObject(capture.reqBody);
  if (!req) return [];
  if (op === 'loadPageChunk') {
    const pageId = str(req.pageId);
    return pageId ? [{ ...pageSeed(pageId), reason: 'cursor' }] : [];
  }
  if (op === 'queryCollection') {
    const collectionId = str(obj(req.source)?.id);
    const viewId = str(obj(req.collectionView)?.id);
    const spaceId = str(obj(req.source)?.spaceId) ?? str(obj(req.collectionView)?.spaceId);
    if (!collectionId || !viewId) return [];
    // Keep the filter and sort the refused request carried, or the retry reads
    // a different (wider) set of rows than the request it stands in for.
    const loader = obj(req.loader);
    const query = viewQueryOf({ query2: { filter: loader?.filter, sort: loader?.sort } });
    return [{ ...collectionSeed(collectionId, viewId, spaceId, query), reason: 'cursor' }];
  }
  if (op === 'syncRecordValues') {
    const ids: string[] = [];
    let spaceId: string | undefined;
    for (const r of arr(req.requests) ?? []) {
      const pointer = obj(obj(r)?.pointer);
      const id = str(pointer?.id);
      if (id) ids.push(id);
      spaceId ??= str(pointer?.spaceId);
    }
    // The request does not name the database the rows belong to; the ids are
    // the work, and the container is filled in when the rows arrive.
    return recordSeeds(undefined, ids, spaceId);
  }
  return [];
}

/**
 * What is left to fetch after this response.
 *
 * Fan-out only, and deliberately so — see fact 2 in the file header. Every
 * branch keys on a block id and the set de-duplicates, so re-capturing the same
 * page costs nothing.
 */
export function notionNextCursors(capture: Capture, _ctx?: ParseContext): CursorSeed[] {
  const op = apiOperation(capture.path);
  if (!op) return [];

  // A 429 is "ask again", not "nothing here": it carries no records, so dropping it
  // discards the whole subtree. A browser-captured 429 is re-seeded here as pending for
  // the next `replay --all`; one hit by the drain dedupes onto the item being drained,
  // which is released back to pending.
  if (capture.status === 429) return retrySeeds(capture, op);
  if (typeof capture.status === 'number' && capture.status >= 400) return [];

  const body = safeJson(capture.resBody);
  if (body === undefined) return [];
  if (obj(body)?.isNotionError === true) return [];

  const pages = new Set<string>();
  const views = new Map<string, { viewId: string; spaceId?: string }>();
  // Every `collection_view` record in the response, by id, so a view seed can
  // carry the filter and sort the view itself applies.
  const viewRecords = new Map<string, NotionRecord>();
  const presentBlocks = new Set<string>();

  for (const map of recordMaps(body)) {
    for (const { id, record } of tableRecords(map, 'collection_view')) viewRecords.set(id, record);
    // A space or teamspace names its root pages; those are the only entry points
    // into a workspace that no page chunk reaches on its own.
    for (const [table, key] of [['space', 'pages'], ['team', 'team_pages']] as const) {
      for (const { record } of tableRecords(map, table)) {
        for (const p of arr(record[key]) ?? []) {
          const id = str(p);
          if (id) pages.add(id);
        }
      }
    }
    for (const { id, record, spaceId } of tableRecords(map, 'block')) {
      presentBlocks.add(id);
      const type = str(record.type) ?? '';
      if (PAGE_TYPES.has(type)) pages.add(id);
      if (type.startsWith('collection_view')) {
        const collectionId = str(record.collection_id);
        const viewId = str(arr(record.view_ids)?.[0]);
        // An empty view id would build a request Notion answers with an error,
        // and a seed that can only fail is worse than no seed.
        if (collectionId && viewId && !views.has(collectionId)) {
          views.set(collectionId, { viewId, spaceId: spaceId ?? str(record.space_id) });
        }
      }
    }
  }

  // The page this capture WAS: re-seeding it would re-fetch what we just read.
  const req = safeJsonObject(capture.reqBody);
  const self = str(req?.pageId);
  if (self) pages.delete(self);

  const seeds: CursorSeed[] = [];
  // Rows this answer named but did not carry come first: they are the rest of
  // the read that just happened, not new fan-out.
  if (op === 'queryCollection') {
    const collectionId = str(obj(req?.source)?.id);
    const spaceId = str(obj(req?.source)?.spaceId) ?? str(obj(req?.collectionView)?.spaceId);
    const missing = namedRowIds(body).filter((id) => !presentBlocks.has(id));
    if (collectionId && missing.length > 0) seeds.push(...recordSeeds(collectionId, missing, spaceId));
  }
  for (const [collectionId, v] of views) {
    if (seeds.length >= MAX_SEEDS_PER_CAPTURE) break;
    seeds.push(collectionSeed(collectionId, v.viewId, v.spaceId, viewQueryOf(viewRecords.get(v.viewId))));
  }
  for (const pageId of pages) {
    if (seeds.length >= MAX_SEEDS_PER_CAPTURE) break;
    seeds.push(pageSeed(pageId));
  }
  return seeds;
}

// ── Replay ───────────────────────────────────────────────────────────────────────

/**
 * APPEND-ONLY. The seeds emitted by `nextCursors` address these by id, and
 * notion.test.ts asserts the ids — reordering is free, but renaming one silently
 * produces work nothing can run.
 *
 * Every action is a POST with a JSON body; Notion's private API has no GET reads
 * and no path or query parameters at all, so `urlTemplate` is a constant per
 * action and the params become body fields in `buildReplayRequest`.
 *
 * The two param-free actions are first, and that matters: `sluice sync` runs
 * only actions with no required params, and both of these parse into Workspaces,
 * Containers and Actors — so sync reconstructs the shape of the account rather
 * than reporting "+0 users" while quietly inserting pages.
 */
const NOTION_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'notion.user.content',
    adapterId: ADAPTER_ID,
    label: 'Workspaces, teamspaces and root pages',
    method: 'POST',
    urlTemplate: `${API_ORIGIN}/api/v3/loadUserContent`,
    params: [],
  },
  {
    id: 'notion.spaces',
    adapterId: ADAPTER_ID,
    label: 'Every signed-in space, with its members',
    method: 'POST',
    urlTemplate: `${API_ORIGIN}/api/v3/getSpaces`,
    params: [],
  },
  {
    id: 'notion.page.chunk',
    adapterId: ADAPTER_ID,
    label: "A page's blocks, comments and child pages",
    method: 'POST',
    urlTemplate: `${API_ORIGIN}/api/v3/loadPageChunk`,
    params: [
      { name: 'pageId', label: 'Page id', kind: 'containerId', required: true },
      { name: 'limit', label: 'Blocks per chunk', kind: 'number', default: '100' },
    ],
  },
  {
    id: 'notion.collection.query',
    adapterId: ADAPTER_ID,
    label: "A database view's rows",
    method: 'POST',
    urlTemplate: `${API_ORIGIN}/api/v3/queryCollection`,
    params: [
      { name: 'collectionId', label: 'Database id', kind: 'containerId', required: true },
      { name: 'viewId', label: 'View id', kind: 'string', required: true },
      { name: 'spaceId', label: 'Space id', kind: 'string' },
      { name: 'limit', label: 'Rows', kind: 'number', default: '200' },
      { name: 'filter', label: 'View filter (JSON)', kind: 'string' },
      { name: 'sort', label: 'View sort (JSON array)', kind: 'string' },
    ],
  },
  {
    id: 'notion.search',
    adapterId: ADAPTER_ID,
    label: 'Search a space',
    method: 'POST',
    urlTemplate: `${API_ORIGIN}/api/v3/search`,
    params: [
      { name: 'spaceId', label: 'Space id', kind: 'string', required: true },
      { name: 'query', label: 'Query', kind: 'string', default: '' },
      { name: 'limit', label: 'Results', kind: 'number', default: '100' },
    ],
  },
  {
    id: 'notion.records.sync',
    adapterId: ADAPTER_ID,
    label: 'Re-read one record by id',
    method: 'POST',
    urlTemplate: `${API_ORIGIN}/api/v3/syncRecordValues`,
    params: [
      // `id` stays required so `sluice sync` (which runs only param-free
      // actions) keeps skipping this one; `ids` is the batch form the
      // truncation seeds use and satisfies the requirement on its own.
      { name: 'id', label: 'Record id', kind: 'containerId', required: true },
      { name: 'ids', label: 'Record ids, comma-separated', kind: 'string' },
      { name: 'table', label: 'Table', kind: 'string', default: 'block' },
      { name: 'spaceId', label: 'Space id', kind: 'string' },
    ],
  },
];

/** A required param that is missing THROWS by name rather than sending `undefined`. */
function requireParam(action: ReplayAction, params: Record<string, string>, name: string): string {
  return requireActionParam(action, params, name, ' — it is a required body field, not an optional one');
}

/**
 * The JSON body for one action.
 *
 * These shapes were taken from a live client, not guessed, and two of them have
 * a trap worth naming:
 *
 *   - `queryCollection`'s `loader` must be `{ type: 'reducer', reducers: { … } }`
 *     with a reducer Notion recognises. A reducer key it does not know comes back
 *     as HTTP 200 with `isNotionError: true` and an empty `recordMap` — which
 *     reads exactly like an empty database.
 *   - `search`'s `paginationToken` is a session timestamp, not an offset. It is
 *     deliberately not sent: passing one back returns the identical first page.
 */
function replayBody(action: ReplayAction, params: Record<string, string>): unknown {
  switch (action.id) {
    case 'notion.user.content':
    case 'notion.spaces':
      return {};
    case 'notion.page.chunk':
      return {
        pageId: requireParam(action, params, 'pageId'),
        limit: num(actionParam(action, params, 'limit')) ?? 100,
        cursor: { stack: [] },
        chunkNumber: 0,
        verticalColumns: false,
      };
    case 'notion.collection.query': {
      const collectionId = requireParam(action, params, 'collectionId');
      const viewId = requireParam(action, params, 'viewId');
      const spaceId = params.spaceId;
      const filter = obj(safeJson(params.filter));
      const sort = arr(safeJson(params.sort));
      return {
        source: { type: 'collection', id: collectionId, ...(spaceId ? { spaceId } : {}) },
        collectionView: { id: viewId, ...(spaceId ? { spaceId } : {}) },
        loader: {
          type: 'reducer',
          reducers: {
            collection_group_results: {
              type: 'results',
              limit: num(actionParam(action, params, 'limit')) ?? 200,
            },
          },
          ...(filter ? { filter } : {}),
          sort: sort ?? [],
          searchQuery: '',
          userTimeZone: 'UTC',
        },
      };
    }
    case 'notion.search':
      return {
        type: 'BlocksInSpace',
        query: params.query ?? '',
        spaceId: requireParam(action, params, 'spaceId'),
        limit: num(actionParam(action, params, 'limit')) ?? 100,
        filters: {
          isDeletedOnly: false,
          excludeTemplates: false,
          isNavigableOnly: true,
          requireEditPermissions: false,
          ancestors: [],
          createdBy: [],
          editedBy: [],
          lastEditedTime: {},
          createdTime: {},
          inTeams: [],
          navigableBlockContentOnly: true,
        },
        sort: { field: 'lastEdited', direction: 'desc' },
        source: 'quick_find_input_change',
      };
    case 'notion.records.sync': {
      const spaceId = params.spaceId;
      const table = params.table ?? 'block';
      const batch = (params.ids ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const ids = batch.length > 0 ? batch : [requireParam(action, params, 'id')];
      return {
        requests: ids.map((id) => ({
          pointer: { table, id, ...(spaceId ? { spaceId } : {}) },
          version: -1,
        })),
      };
    }
    default:
      return {};
  }
}

/**
 * Build the concrete request: the browser session cookie rides in the `Cookie`
 * header, and the three `notion-*` client headers ride with it.
 *
 * `x-notion-active-user-header` is read from the session rather than a param
 * because it identifies the ACCOUNT, not the call. One Chrome cookie jar can
 * hold several Notion logins; without this header Notion picks one, so a
 * missing value does not fail — it silently answers as somebody else.
 */
function buildReplayRequest(
  action: ReplayAction,
  params: Record<string, string>,
  session: Session,
): ReplayRequest {
  const { cookieHeader, activeUserId } = session.credentials.values;
  const headers = notionHeaders(cookieHeader, activeUserId);
  const spaceId = params.spaceId;
  if (spaceId) headers['x-notion-space-id'] = spaceId;

  return {
    method: action.method,
    url: action.urlTemplate,
    headers,
    body: JSON.stringify(replayBody(action, params)),
  };
}

// ── The adapter ────────────────────────────────────────────────────────────────

export const notionAdapter: Adapter = {
  id: ADAPTER_ID,
  displayName: 'Notion',
  // Parent domains only: the intercept list expands each entry to `*.host` on
  // its own, and the conformance lookalike probe generates `notnotion.com` from
  // a narrower entry — which `matchesNotion` correctly refuses.
  hosts: ['notion.com', 'notion.so'],
  matchRequest(input) {
    return matchesNotion(input.host);
  },
  parse: parseNotionCapture,
  classify: classifyNotionCapture,
  nextCursors: notionNextCursors,
  reconcile: reconcileNotion,
  listReplayActions() {
    return NOTION_REPLAY_ACTIONS;
  },
  buildReplayRequest,
};
