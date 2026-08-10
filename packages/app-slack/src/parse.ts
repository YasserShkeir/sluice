// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Slack Web API → normalized entities.
 *
 * Every parser here is deliberately defensive: Slack payloads vary by client
 * version, workspace tier (Grid vs. single team), and endpoint shape, and fields
 * routinely go missing. A parser that throws would poison the ingest funnel, so
 * we coerce everything through the small `str`/`num`/`bool`/`arr`/`obj` helpers
 * and simply omit anything we can't understand.
 *
 * Response bodies are the already-decoded JSON string on `Capture.resBody`.
 * Request bodies are almost always `application/x-www-form-urlencoded`, but we
 * also tolerate a URL query string and a JSON body when hunting for `channel`.
 *
 * Three readers of the same payload live here rather than in three files, so
 * `slackMethod` and `safeJson` stay single copies: `parseSlackCapture` (entities),
 * `classifySlackCapture` (what kind of exchange this was) and `slackNextCursors`
 * (what to fetch next).
 */
import { requestParams } from '@sluice/adapter-sdk';
import type {
  Actor,
  Capture,
  CaptureClass,
  Container,
  ContainerKind,
  CursorSeed,
  Item,
  ParseContext,
  ParseResult,
  Workspace,
} from '@sluice/core';

/** The one true id for this adapter; shared with slack-adapter.ts. */
export const ADAPTER_ID = 'slack';

// ── Coercion helpers (never throw on odd shapes) ────────────────────────────────

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

function compact<T>(items: (T | undefined)[]): T[] {
  return items.filter((x): x is T => x !== undefined);
}

/** Parse a JSON object body; returns null for empty / non-object / invalid input. */
function safeJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extract the Slack method name from a path like `/api/conversations.history`. */
export function slackMethod(path: string): string | undefined {
  const m = /\/api\/([A-Za-z0-9._]+)/.exec(path);
  return m ? m[1] : undefined;
}

/**
 * What the request was made WITH. `channel` (history), `ts` (replies) and
 * `types`/`limit` (conversations.list) appear NOWHERE in the response, so
 * anything that has to name or re-issue the call reads them here. They are not
 * secrets, so they survive redaction untouched.
 *
 * `ctx.reqParams` wins when the caller already did the decoding; this used to be
 * a private three-encoding scanner, which is exactly the copy the adapter SDK
 * exists to delete.
 */
function reqParamsOf(capture: Capture, ctx?: ParseContext): Record<string, string> {
  return ctx?.reqParams ?? requestParams(capture);
}

/**
 * Resolve the workspace/team id for a capture. A caller that already knows the
 * workspace wins outright; otherwise prefer a real Slack team id (`T…`) from
 * anywhere it appears; failing that, a stable host-derived synthetic so
 * normalized entities always have a non-null `workspaceId` to hang off of.
 */
function resolveTeamId(
  capture: Capture,
  body: Record<string, unknown>,
  ctx?: ParseContext,
): string {
  const known = str(ctx?.workspaceId);
  if (known) return known;

  const direct = [
    str(obj(body.team).id),
    str(body.team_id),
    str(obj(body.self).team_id),
    str(obj(body.user).team_id),
  ];
  for (const c of direct) if (c) return c;

  for (const raw of arr(body.channels)) {
    const ch = obj(raw);
    const t = str(ch.context_team_id) ?? str(arr(ch.shared_team_ids)[0]);
    if (t) return t;
  }

  // `members[].team_id` is the ONLY carrier of the team on a `users.list`
  // response. Without it those actors were filed under `slack:<host>` while
  // containers from the SAME workspace were filed under `T…`, so the webapp's
  // `listActors(container.workspaceId)` returned [] and every message rendered
  // as a bare `U…` with no handle — despite users.list having been captured.
  for (const raw of arr(body.members)) {
    const t = str(obj(raw).team_id);
    if (t) return t;
  }
  return `slack:${capture.host}`;
}

// ── Entity builders ─────────────────────────────────────────────────────────────

function channelToContainer(
  raw: Record<string, unknown>,
  workspaceId: string,
  fallbackKind?: ContainerKind,
): Container | undefined {
  const id = str(raw.id);
  if (!id) return undefined;

  let kind: ContainerKind = fallbackKind ?? 'other';
  if (bool(raw.is_im)) kind = 'dm';
  else if (bool(raw.is_mpim)) kind = 'group';
  else if (bool(raw.is_group)) kind = 'group';
  else if (bool(raw.is_channel)) kind = 'channel';

  const name =
    str(raw.name) ?? (kind === 'dm' && str(raw.user) ? `dm:${str(raw.user)}` : undefined) ?? id;

  return {
    id,
    workspaceId,
    adapterId: ADAPTER_ID,
    kind,
    name,
    topic: str(obj(raw.topic).value),
    isPrivate: bool(raw.is_private),
    memberCount: num(raw.num_members),
    raw,
  };
}

function userToActor(raw: Record<string, unknown>, workspaceId: string): Actor | undefined {
  const id = str(raw.id);
  if (!id) return undefined;
  const profile = obj(raw.profile);
  return {
    id,
    workspaceId,
    adapterId: ADAPTER_ID,
    handle: str(raw.name) ?? id,
    displayName: str(profile.display_name) ?? str(profile.real_name) ?? str(raw.real_name),
    avatarUrl: str(profile.image_48),
    raw,
  };
}

function messageToItem(
  raw: Record<string, unknown>,
  containerId: string,
  workspaceId: string,
  captureId: string,
): Item | undefined {
  const tsStr = str(raw.ts);
  if (!tsStr) return undefined;
  const tsMs = Math.round(parseFloat(tsStr) * 1000);
  if (!Number.isFinite(tsMs)) return undefined;

  return {
    id: tsStr,
    containerId,
    workspaceId,
    adapterId: ADAPTER_ID,
    kind: 'message',
    authorId: str(raw.user) ?? str(raw.bot_id),
    ts: tsMs,
    text: str(raw.text) ?? '',
    threadId: str(raw.thread_ts),
    sourceCaptureIds: [captureId],
    raw,
  };
}

function workspaceFromTeam(
  team: Record<string, unknown>,
  fallbackId: string,
): Workspace | undefined {
  const id = str(team.id) ?? (fallbackId.startsWith('T') ? fallbackId : undefined);
  if (!id) return undefined;
  return {
    id,
    adapterId: ADAPTER_ID,
    name: str(team.name) ?? str(team.domain) ?? id,
    domain: str(team.domain),
    raw: team,
  };
}

/**
 * Where a boot / counts payload keeps its channel-like arrays, and what each one
 * defaults to when the entries carry no `is_*` flags. Written down ONCE: both the
 * entity builder and the fan-out seeder walk the same four lists, and a payload
 * shape learned in one of them was previously invisible to the other.
 */
function bootChannelLists(
  body: Record<string, unknown>,
): Array<[unknown[], ContainerKind | undefined]> {
  return [
    [arr(body.channels), undefined],
    [arr(body.ims), 'dm'],
    [arr(body.groups), 'group'],
    [arr(body.mpims), 'group'],
  ];
}

/** Pull channel-like arrays out of a client.boot / client.userBoot payload. */
function collectBootContainers(
  body: Record<string, unknown>,
  workspaceId: string,
): Container[] {
  const out: (Container | undefined)[] = [];
  for (const [list, kind] of bootChannelLists(body)) {
    for (const c of list) out.push(channelToContainer(obj(c), workspaceId, kind));
  }
  return compact(out);
}

/** Just the ids, de-duplicated — a boot payload lists the same channel twice. */
function collectBootChannelIds(body: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  for (const [list] of bootChannelLists(body)) {
    for (const c of list) {
      const id = str(obj(c).id);
      if (id) seen.add(id);
    }
  }
  return [...seen];
}

// ── Entry point ─────────────────────────────────────────────────────────────────

/**
 * Turn one Slack capture into normalized entities. Returns an empty result for
 * anything we don't recognize or that Slack flagged as an error (`ok: false`).
 */
export function parseSlackCapture(capture: Capture, ctx?: ParseContext): ParseResult {
  const method = slackMethod(capture.path);
  if (!method) return {};

  const body = safeJson(capture.resBody);
  if (!body || body.ok === false) return {};

  const teamId = resolveTeamId(capture, body, ctx);

  switch (method) {
    case 'conversations.list':
    case 'users.conversations': {
      const containers = compact(
        arr(body.channels).map((c) => channelToContainer(obj(c), teamId)),
      );
      return containers.length ? { containers } : {};
    }

    case 'users.list': {
      const actors = compact(arr(body.members).map((m) => userToActor(obj(m), teamId)));
      return actors.length ? { actors } : {};
    }

    case 'users.info': {
      const a = userToActor(obj(body.user), teamId);
      return a ? { actors: [a] } : {};
    }

    case 'conversations.history':
    case 'conversations.replies': {
      const channel = reqParamsOf(capture, ctx).channel;
      if (!channel) return {};
      const items = compact(
        arr(body.messages).map((m) => messageToItem(obj(m), channel, teamId, capture.id)),
      );
      return items.length ? { items } : {};
    }

    case 'client.boot':
    case 'client.userBoot': {
      const ws = workspaceFromTeam(obj(body.team), teamId);
      const containers = collectBootContainers(body, teamId);
      const result: ParseResult = {};
      if (ws) result.workspaces = [ws];
      if (containers.length) result.containers = containers;
      return result;
    }

    case 'client.counts': {
      // Counts payloads carry channel ids but usually no names — only surface a
      // container when it has a real name, so we never clobber a good name (from
      // conversations.list) with a bare id on upsert.
      const named = [...arr(body.channels), ...arr(body.mpims), ...arr(body.ims)]
        .map((c) => obj(c))
        .filter((c) => str(c.name) !== undefined);
      const containers = compact(named.map((c) => channelToContainer(c, teamId)));
      const ws = workspaceFromTeam(obj(body.team), teamId);
      const result: ParseResult = {};
      if (ws) result.workspaces = [ws];
      if (containers.length) result.containers = containers;
      return result;
    }

    default:
      return {};
  }
}

// ── Classification ──────────────────────────────────────────────────────────────

/** Endpoints that describe the SHAPE of an account rather than its contents. */
const STRUCTURE_METHODS = new Set([
  'conversations.list',
  'users.conversations',
  'users.list',
  'users.info',
  'client.boot',
  'client.userBoot',
  'client.counts',
  'team.info',
  'emoji.list',
]);

const MESSAGE_METHODS = new Set(['conversations.history', 'conversations.replies']);

/** Token checks. `api.test` takes no credentials; `auth.test` is the real one. */
const AUTH_METHODS = new Set(['auth.test', 'api.test']);

/**
 * What kind of exchange this was, without parsing it.
 *
 * The error arm is the whole reason this exists. Slack reports a logical failure
 * as HTTP **200** with `{ok:false,"error":"not_authed"}`, and `parseSlackCapture`
 * collapses that to `{}` — byte-identical to what an endpoint we simply don't
 * recognise produces. Without a class, an expired session is indistinguishable
 * from a quiet workspace. Rate limiting arrives the same two ways (HTTP 429, or
 * a 200 carrying `error: 'ratelimited'`) and lands here too.
 *
 * `operation` is the Slack method name rather than the derived path default:
 * `conversations.history` reads far better in the traffic table than
 * `POST /api/conversations.history`.
 *
 * MUST NOT throw — this runs in the ingest funnel for every capture.
 */
export function classifySlackCapture(capture: Capture): {
  class: CaptureClass;
  operation?: string;
} {
  const method = slackMethod(capture.path);
  const body = safeJson(capture.resBody);
  const status = capture.status;

  if ((typeof status === 'number' && status >= 400) || body?.ok === false) {
    return { class: 'error', operation: method };
  }
  if (!method) return { class: 'unknown' };
  if (STRUCTURE_METHODS.has(method)) return { class: 'structure', operation: method };
  if (MESSAGE_METHODS.has(method)) return { class: 'messages', operation: method };
  if (AUTH_METHODS.has(method)) return { class: 'auth', operation: method };
  return { class: 'unknown', operation: method };
}

// ── Pagination ──────────────────────────────────────────────────────────────────

/**
 * Which replay action re-issues a paged method, and which REQUEST params it needs
 * carried forward. `channel`, `ts`, `types` and `limit` are absent from every
 * response body, so a seed built from the body alone replays a different call
 * than the one that produced the cursor.
 *
 * `require` names the params without which the replay is meaningless rather than
 * merely broader: `conversations.history` with no channel is not a wider query,
 * it is an error.
 *
 * A Map, not an object literal, because `method` is attacker-supplied path text.
 * `ROUTES['__proto__']` on a literal returns `Object.prototype` — truthy, so the
 * route branch was taken — and `for (const name of route.carry)` then threw
 * `carry is not iterable` out of a hook forbidden to throw. `/api/constructor`,
 * `/api/toString`, `/api/valueOf` and `/api/hasOwnProperty` did the same.
 */
const CURSOR_ROUTES = new Map<
  string,
  { actionId: string; carry: string[]; require?: string[] }
>([
  ['conversations.list', { actionId: 'slack.conversations.list', carry: ['types', 'limit'] }],
  ['users.conversations', { actionId: 'slack.users.conversations', carry: ['types', 'limit'] }],
  ['users.list', { actionId: 'slack.users.list', carry: ['limit'] }],
  [
    'conversations.history',
    {
      actionId: 'slack.conversations.history',
      carry: ['channel', 'limit'],
      require: ['channel'],
    },
  ],
  [
    'conversations.replies',
    {
      actionId: 'slack.conversations.replies',
      carry: ['channel', 'ts', 'limit'],
      require: ['channel', 'ts'],
    },
  ],
]);

/** Boot-shaped payloads: no cursor anywhere, but they name every channel. */
const BOOT_METHODS = new Set(['client.boot', 'client.userBoot', 'client.counts']);

/**
 * What is left to fetch after this response.
 *
 * Two different kinds of "more work", which is why `CursorSeed.reason` exists:
 *
 *   - `cursor` — `response_metadata.next_cursor`, one seed for the next page.
 *     An EMPTY STRING there means EXHAUSTED, not "start from the beginning", and
 *     Slack sends it far more often than it omits the field; emitting `cursor: ''`
 *     re-fetches page one forever.
 *   - `fanout` — a boot response carries no cursor at all. Its next work is one
 *     `conversations.history` call PER channel it named.
 *
 * MUST NOT throw, same reason as `parse`.
 */
export function slackNextCursors(capture: Capture, ctx?: ParseContext): CursorSeed[] {
  const method = slackMethod(capture.path);
  if (!method) return [];

  const body = safeJson(capture.resBody);
  // A failed call's cursor is not a page, it is whatever the previous call said.
  if (!body || body.ok === false) return [];

  const route = CURSOR_ROUTES.get(method);
  if (route) {
    // `str` rejects the empty string, which is precisely Slack's "exhausted".
    const cursor = str(obj(body.response_metadata).next_cursor);
    if (!cursor) return [];

    const params = reqParamsOf(capture, ctx);
    const carried: Record<string, string> = {};
    for (const name of route.carry) {
      const v = str(params[name]);
      if (v) carried[name] = v;
    }
    for (const name of route.require ?? []) if (carried[name] === undefined) return [];

    const seed: CursorSeed = {
      adapterId: ADAPTER_ID,
      actionId: route.actionId,
      cursor,
      reason: 'cursor',
      depth: 1,
    };
    if (Object.keys(carried).length > 0) seed.params = carried;
    if (carried.channel) seed.containerId = carried.channel;
    return [seed];
  }

  if (BOOT_METHODS.has(method)) {
    return collectBootChannelIds(body).map((id) => ({
      adapterId: ADAPTER_ID,
      actionId: 'slack.conversations.history',
      containerId: id,
      params: { channel: id },
      reason: 'fanout',
      depth: 1,
    }));
  }

  return [];
}
