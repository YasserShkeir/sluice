// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Trello Adapter.
 *
 * Auth contract: Trello's web API (`https://trello.com/1/…`) is authorized by the
 * BROWSER SESSION COOKIE — the `Cookie:` request header. There is NO `token`
 * query param. `buildReplayRequest` therefore sets `Cookie` from the session's
 * `credentials.values.cookieHeader` (read from Chrome by the credential provider) plus the
 * browser-like headers Trello expects (User-Agent / Accept / Referer).
 *
 * Two facts about Trello shape everything below:
 *
 *   1. `matchRequest` is HOST-only, so the entire SPA — the HTML shell,
 *      /app-*.js, CSS, images — is already attributed to `trello` and pushed
 *      through parse(). Labelling it `asset` in `classify` is the non-breaking
 *      fix; narrowing the match is the other one, and it would change the
 *      attribution of every capture already sitting in a store.
 *
 *   2. Trello's REST API has NO opaque pagination token — there is no
 *      next_cursor / nextPageToken field anywhere in it. The action feeds page by
 *      id window (`before=<id of the last row>`), /1/search takes an integer page
 *      index, and the card/board/list endpoints are not paged at all. So the real
 *      "next work" is FAN-OUT: after "my boards" comes one call per board.
 *
 * Parsing is deliberately defensive — Trello payloads vary by endpoint and fields
 * routinely go missing — so unknown shapes yield an empty ParseResult rather than
 * throwing. `classify` and `nextCursors` run in the same ingest funnel for every
 * capture and are held to the same rule: they must never throw.
 */
import { operationName } from '@sluice/core';
import type {
  Adapter,
  Capture,
  CaptureClass,
  Container,
  CursorSeed,
  Item,
  ParseContext,
  ParseResult,
  ReplayAction,
  ReplayRequest,
  Session,
  Workspace,
} from '@sluice/core';
import { actionUrl, arr, CHROME_UA, num, obj, requestParam, safeJson, str } from '@sluice/adapter-sdk';

export const ADAPTER_ID = 'trello';
const WORKSPACE_ID = 'trello';
/**
 * Trello has no workspace in its REST payloads that every card and board hangs
 * off, so the parent is a constant — the same one the credential provider names.
 */
const TRELLO_WORKSPACE: Workspace = {
  id: WORKSPACE_ID,
  adapterId: ADAPTER_ID,
  name: 'Trello',
  domain: 'trello.com',
};

/**
 * The browser-like header set Trello's web API expects (it rejects non-browser
 * agents), plus the session cookie when there is one. Shared by `buildReplayRequest` and the MCP tool so the two
 * cannot drift. The result carries the SECRET cookie — never log it.
 */
export function trelloHeaders(cookieHeader?: string): Record<string, string> {
  return {
    'User-Agent': CHROME_UA,
    Accept: 'application/json',
    Referer: 'https://trello.com/',
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
  };
}

// ── Matching ─────────────────────────────────────────────────────────────────────

function matchesTrello(host: string): boolean {
  return host === 'trello.com' || host === 'api.trello.com' || host.endsWith('.trello.com');
}

// ── Path shapes ──────────────────────────────────────────────────────────────────

/**
 * Trello's REST path shapes, written down once.
 *
 * `parse`, `classify` and `nextCursors` all need the same guards, and three
 * private copies of `/^\/1\/boards?\/[^/]+$/` is exactly how three guards drift.
 * Both spellings are accepted (`/1/board/x` and `/1/boards/x`): Trello serves the
 * singular form, and the parser has always taken it.
 *
 * No `g` flags. `.test()` on a global regex is stateful, so a table walked twice
 * would skip matches on alternate calls.
 */
const P = {
  me: /^\/1\/members\/me$/,
  myBoards: /^\/1\/members\/me\/boards$/,
  myCards: /^\/1\/members\/me\/cards$/,
  myOrgs: /^\/1\/members\/me\/organizations$/,
  board: /^\/1\/boards?\/([^/]+)$/,
  boardLists: /^\/1\/boards?\/([^/]+)\/lists$/,
  boardCards: /^\/1\/boards?\/([^/]+)\/cards$/,
  boardActions: /^\/1\/boards?\/([^/]+)\/actions$/,
  listCards: /^\/1\/lists?\/([^/]+)\/cards$/,
  card: /^\/1\/cards?\/([^/]+)$/,
  cardActions: /^\/1\/cards?\/([^/]+)\/actions$/,
  /** Any collection-of-cards endpoint, whichever parent it hangs off. */
  anyCards: /\/cards$/,
  /**
   * Atlassian gateway (GraphQL, session, gasv3, …). These are real API surface
   * on trello.com — not SPA bundles. Must win over `notApi` so flow learning
   * does not treat `gateway/api/graphql` as a generic `asset`.
   */
  gateway: /^\/gateway\/api(\/|$)/,
  /** Not the REST API at all — the SPA shell, its bundles, its images. */
  notApi: /^(?!\/1\/)/,
} as const;

// ── Coercion helpers (never throw on odd shapes) ─────────────────────────────────

function parseTrelloDate(v: unknown): number | undefined {
  const ms = Date.parse(str(v) ?? '');
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * A card object carries a string `id` and a string `idBoard` (a board does not).
 *
 * A WEAK test, and only usable where the path cannot decide: lists, checklists
 * and labels carry `idBoard` too. See the embedded-array branch in the parser.
 */
function looksLikeCard(v: unknown): boolean {
  const o = obj(v);
  return o !== undefined && Boolean(str(o.id)) && typeof o.idBoard === 'string';
}

// ── Entity builders ──────────────────────────────────────────────────────────────

function cardToItem(raw: Record<string, unknown> | undefined, captureId: string): Item | undefined {
  if (!raw) return undefined;
  const id = str(raw.id);
  if (!id) return undefined;
  const ts = parseTrelloDate(raw.dateLastActivity) ?? parseTrelloDate(raw.due) ?? 0;
  return {
    id,
    containerId: str(raw.idBoard) || 'trello',
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'other',
    ts,
    text: str(raw.name) ?? '',
    sourceCaptureIds: [captureId],
    raw,
  };
}

function boardToContainer(raw: Record<string, unknown> | undefined): Container | undefined {
  if (!raw) return undefined;
  // Guard against a card slipping in — cards carry idBoard, boards do not.
  if (typeof raw.idBoard === 'string') return undefined;
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return undefined;
  const prefs = obj(raw.prefs);
  return {
    id,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'board',
    name,
    isPrivate: prefs && str(prefs.permissionLevel) === 'private' ? true : undefined,
    raw,
  };
}

/**
 * A board COLUMN (`/1/boards/<id>/lists`). `kind: 'other'`: it is neither the
 * board nor a card, and the board it sits on stays in `raw.idBoard`.
 */
function listToContainer(raw: Record<string, unknown> | undefined): Container | undefined {
  if (!raw) return undefined;
  const id = str(raw.id);
  const name = str(raw.name);
  if (!id || !name) return undefined;
  return { id, workspaceId: WORKSPACE_ID, adapterId: ADAPTER_ID, kind: 'other', name, raw };
}

/**
 * A card comment from an action feed. Every other action type (moves, edits,
 * label changes) is activity about an entity, not content, and is skipped.
 *
 * The comment lives on the card's board, and `threadId` is the card: the card
 * Item is what its comments reply to.
 */
function commentToItem(
  raw: Record<string, unknown> | undefined,
  pathBoardId: string | undefined,
  captureId: string,
): Item | undefined {
  if (!raw || str(raw.type) !== 'commentCard') return undefined;
  const id = str(raw.id);
  if (!id) return undefined;
  const data = obj(raw.data);
  return {
    id,
    containerId: str(obj(data?.board)?.id) ?? pathBoardId ?? WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'message',
    authorId: str(raw.idMemberCreator),
    ts: parseTrelloDate(raw.date) ?? 0,
    text: str(data?.text) ?? '',
    threadId: str(obj(data?.card)?.id),
    sourceCaptureIds: [captureId],
    raw,
  };
}

// ── Parser ───────────────────────────────────────────────────────────────────────

/**
 * Turn one Trello capture into normalized entities:
 *   - a cards endpoint (`/1/members/*​/cards`, `/1/cards/<id>`, `…/cards`) → Items;
 *   - a boards endpoint (`/1/members/me/boards`, `/1/board/<id>`, `/1/boards/<id>`)
 *     or an embedded `boards` array → Containers;
 *   - a board's lists (`/1/boards/<id>/lists`) → Containers;
 *   - an action feed (`/1/boards/<id>/actions`, `/1/cards/<id>/actions`) → one
 *     Item per `commentCard`.
 * Anything unrecognized yields an empty ParseResult. Whenever something is
 * recognized the constant `trello` Workspace rides along, so its children never
 * arrive without their parent.
 *
 * Routing is by PATH, not body shape: boards, lists, checklists and cards are all
 * `{id, name, …}`, and most non-boards carry a string `idBoard`.
 */
export function parseTrelloCapture(capture: Capture): ParseResult {
  const body = safeJson(capture.resBody);
  if (body === undefined) return {};

  const path = str(capture.path) ?? '';
  const items: Item[] = [];
  const containers: Container[] = [];
  const seenCards = new Set<string>();

  const pushCard = (raw: unknown): void => {
    const item = cardToItem(obj(raw), capture.id);
    if (item && !seenCards.has(item.id)) {
      seenCards.add(item.id);
      items.push(item);
    }
  };
  const pushBoard = (raw: unknown): void => {
    const c = boardToContainer(obj(raw));
    if (c) containers.push(c);
  };

  if (Array.isArray(body)) {
    // A board row, a list row and a card row are all `{id, name, …}`; only the
    // path separates them.
    if (P.anyCards.test(path)) for (const c of body) pushCard(c);
    else if (P.myBoards.test(path)) for (const b of body) pushBoard(b);
    else if (P.boardLists.test(path)) {
      for (const l of body) {
        const c = listToContainer(obj(l));
        if (c) containers.push(c);
      }
    } else if (P.boardActions.test(path) || P.cardActions.test(path)) {
      const pathBoardId = P.boardActions.exec(path)?.[1];
      for (const a of body) {
        const item = commentToItem(obj(a), pathBoardId, capture.id);
        if (item) items.push(item);
      }
    }
  } else {
    const o = obj(body);
    if (o) {
      // Keyed, not pathed: a board endpoint may inline its cards, so the element
      // shape is the only discriminator left here.
      if (Array.isArray(o.cards)) for (const c of o.cards) if (looksLikeCard(c)) pushCard(c);
      if (P.card.test(path)) pushCard(o);
      if (P.board.test(path)) pushBoard(o);
      if (Array.isArray(o.boards)) for (const b of o.boards) pushBoard(b);
    }
  }

  const result: ParseResult = {};
  if (containers.length) result.containers = containers;
  if (items.length) result.items = items;
  if (containers.length || items.length) result.workspaces = [{ ...TRELLO_WORKSPACE }];
  return result;
}

// ── Classification ───────────────────────────────────────────────────────────────

interface ClassifyRule {
  re: RegExp;
  class: CaptureClass;
  /** Spelled the way core's `operationName()` spells it, so rows group alike; omitted → operationName(path). */
  operation?: string;
}

/**
 * Ordered, first match wins.
 *
 * Every /1/ rule is `$`-anchored, so the one piece of ordering that carries
 * meaning is the last entry: `notApi` is the SPA catch-all and must be reached
 * only after the API rules have all missed. Assets collapse to a single
 * operation on purpose — naming them per file (`app-1a2b3c.js`) would bury the
 * dozen calls that matter under a few hundred that never will.
 */
const CLASSIFY_RULES: readonly ClassifyRule[] = [
  { re: P.myBoards, class: 'structure', operation: 'members/me/boards' },
  { re: P.myOrgs, class: 'structure', operation: 'members/me/organizations' },
  { re: P.boardLists, class: 'structure', operation: 'boards/:id/lists' },
  { re: P.board, class: 'structure', operation: 'boards/:id' },
  { re: P.myCards, class: 'messages', operation: 'members/me/cards' },
  { re: P.boardCards, class: 'messages', operation: 'boards/:id/cards' },
  { re: P.listCards, class: 'messages', operation: 'lists/:id/cards' },
  { re: P.boardActions, class: 'messages', operation: 'boards/:id/actions' },
  { re: P.cardActions, class: 'messages', operation: 'cards/:id/actions' },
  { re: P.card, class: 'messages', operation: 'cards/:id' },
  { re: P.me, class: 'auth', operation: 'members/me' },
  // Gateway before notApi; unnamed so each op (graphql, session/heartbeat, gasv3/…) is named from its path.
  { re: P.gateway, class: 'unknown' },
  { re: P.notApi, class: 'asset', operation: 'asset' },
];

/**
 * What kind of exchange this is, without parsing it. Never throws.
 *
 * A 4xx/5xx keeps the operation it would otherwise have had: the traffic table
 * still has to say WHICH call failed, and `error` on its own does not.
 */
export function classifyTrelloCapture(capture: Capture): {
  class: CaptureClass;
  operation?: string;
} {
  const path = str(capture.path) ?? '';
  const rule = CLASSIFY_RULES.find((r) => r.re.test(path));
  const operation = rule?.operation ?? operationName(path);
  const status = capture.status;
  if (typeof status === 'number' && status >= 400) return { class: 'error', operation };
  return { class: rule?.class ?? 'unknown', operation };
}

// ── Pagination and fan-out ───────────────────────────────────────────────────────

/**
 * Trello's action feeds default to 50 rows and cap at 1000, and a SHORT PAGE is
 * the only exhaustion signal they give.
 *
 * The cap is applied to the requested limit too: `limit=5000` still returns 1000
 * rows, and comparing 1000 < 5000 would declare a full feed exhausted on its
 * first page.
 */
const ACTIONS_DEFAULT_LIMIT = 50;
const ACTIONS_MAX_LIMIT = 1000;

/**
 * One board-scoped follow-up call. `reason: 'fanout'` because this is not a next
 * page of anything — see the file header.
 *
 * `depth: 1` is one hop from the captured call. The worklist has no column for
 * it and a parse is handed no running total, so a seed's own children restart the
 * count — the bound is honest for the first hop, which is all anything emits.
 */
function fanoutSeed(actionId: string, boardId: string): CursorSeed {
  return {
    adapterId: ADAPTER_ID,
    actionId,
    containerId: boardId,
    params: { boardId },
    reason: 'fanout',
    depth: 1,
  };
}

/**
 * The next page of an action feed, expressed the only way Trello can express it:
 * `before=<id of the last row returned>`. That id goes in `cursor` — it is this
 * service's pagination token even though it is not opaque.
 */
function actionFeedSeeds(
  actionId: string,
  idParam: string,
  containerId: string | undefined,
  rows: unknown[],
  capture: Capture,
  ctx: ParseContext | undefined,
): CursorSeed[] {
  if (!containerId) return [];
  const asked = num(ctx?.reqParams?.limit ?? requestParam(capture, 'limit'));
  const limit = Math.min(asked ?? ACTIONS_DEFAULT_LIMIT, ACTIONS_MAX_LIMIT);
  if (rows.length < limit) return [];
  const before = str(obj(rows[rows.length - 1])?.id);
  // No id on the last row means no window to ask for. An empty cursor means
  // EXHAUSTED, so emitting one here would be a lie either way.
  if (!before) return [];
  return [
    {
      adapterId: ADAPTER_ID,
      actionId,
      containerId,
      cursor: before,
      params: { [idParam]: containerId, limit: String(limit) },
      reason: 'cursor',
      depth: 1,
    },
  ];
}

/**
 * What is left to fetch after this response. Never throws; `[]` is the common and
 * perfectly good answer.
 *
 * Trello's fan-out is bounded by the account itself — both branches key on board
 * id and de-duplicate — so there is no cap here beyond "how many boards you are
 * a member of".
 */
export function trelloNextCursors(capture: Capture, ctx?: ParseContext): CursorSeed[] {
  const status = capture.status;
  if (typeof status === 'number' && status >= 400) return [];

  const path = str(capture.path) ?? '';
  const rows = arr(safeJson(capture.resBody));
  if (!rows || rows.length === 0) return [];

  if (P.myBoards.test(path)) {
    const ids = new Set<string>();
    for (const row of rows) {
      const o = obj(row);
      // boardToContainer's discriminator, applied again: a card carries idBoard,
      // a board does not. Fanning out from a card id would fetch nothing.
      if (!o || typeof o.idBoard === 'string') continue;
      const id = str(o.id);
      if (id) ids.add(id);
    }
    return [...ids].map((id) => fanoutSeed('trello.board.cards', id));
  }

  if (P.myCards.test(path)) {
    const ids = new Set<string>();
    for (const row of rows) {
      const id = str(obj(row)?.idBoard);
      if (id) ids.add(id);
    }
    return [...ids].map((id) => fanoutSeed('trello.board.lists', id));
  }

  const boardFeed = P.boardActions.exec(path);
  if (boardFeed) {
    return actionFeedSeeds('trello.board.actions', 'boardId', boardFeed[1], rows, capture, ctx);
  }
  const cardFeed = P.cardActions.exec(path);
  if (cardFeed) {
    return actionFeedSeeds('trello.card.actions', 'cardId', cardFeed[1], rows, capture, ctx);
  }

  return [];
}

// ── Replay ───────────────────────────────────────────────────────────────────────

const CARD_FIELDS = 'id,name,url,idBoard,idList,dateLastActivity,due,dueComplete,closed';

/**
 * APPEND-ONLY. `listReplayActions()[0]` is asserted in trello.test.ts, and the
 * seeds emitted by `nextCursors` address these by id — reordering is free, but
 * renaming one silently produces work nothing can run.
 */
const TRELLO_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'trello.my.cards',
    adapterId: ADAPTER_ID,
    label: 'My open cards',
    method: 'GET',
    urlTemplate: 'https://trello.com/1/members/me/cards',
    params: [
      { name: 'filter', label: 'Filter', kind: 'string', default: 'open' },
      {
        name: 'fields',
        label: 'Fields',
        kind: 'string',
        default: 'id,name,url,idBoard,dateLastActivity,due,dueComplete,closed',
      },
    ],
  },
  {
    // The one STRUCTURE action with no required params: `sluice sync` runs only
    // param-free actions and counts containers, which this parses into.
    id: 'trello.my.boards',
    adapterId: ADAPTER_ID,
    label: 'My boards',
    method: 'GET',
    urlTemplate: 'https://trello.com/1/members/me/boards',
    params: [
      { name: 'fields', label: 'Fields', kind: 'string', default: 'id,name,url,closed,idOrganization' },
    ],
  },
  {
    id: 'trello.board.cards',
    adapterId: ADAPTER_ID,
    label: "A board's cards",
    method: 'GET',
    urlTemplate: 'https://trello.com/1/boards/{boardId}/cards',
    params: [
      { name: 'boardId', label: 'Board id', kind: 'containerId', required: true },
      { name: 'fields', label: 'Fields', kind: 'string', default: CARD_FIELDS },
    ],
  },
  {
    id: 'trello.board.lists',
    adapterId: ADAPTER_ID,
    label: "A board's lists",
    method: 'GET',
    urlTemplate: 'https://trello.com/1/boards/{boardId}/lists',
    params: [
      { name: 'boardId', label: 'Board id', kind: 'containerId', required: true },
      { name: 'fields', label: 'Fields', kind: 'string', default: 'id,name' },
    ],
  },
  {
    id: 'trello.board.actions',
    adapterId: ADAPTER_ID,
    label: "A board's activity feed",
    method: 'GET',
    urlTemplate: 'https://trello.com/1/boards/{boardId}/actions',
    params: [
      { name: 'boardId', label: 'Board id', kind: 'containerId', required: true },
      { name: 'before', label: 'Before (action id)', kind: 'cursor' },
      { name: 'limit', label: 'Limit', kind: 'number', default: String(ACTIONS_MAX_LIMIT) },
    ],
  },
  {
    id: 'trello.card.actions',
    adapterId: ADAPTER_ID,
    label: "A card's comments and activity",
    method: 'GET',
    urlTemplate: 'https://trello.com/1/cards/{cardId}/actions',
    params: [
      { name: 'cardId', label: 'Card id', kind: 'containerId', required: true },
      { name: 'before', label: 'Before (action id)', kind: 'cursor' },
      { name: 'limit', label: 'Limit', kind: 'number', default: String(ACTIONS_MAX_LIMIT) },
    ],
  },
];

/**
 * Build the concrete request: the browser session cookie rides in the `Cookie`
 * header (there is no token query param), alongside the browser-like headers
 * Trello requires. Trello scopes by path segment (`{boardId}`), which
 * `actionUrl` substitutes, throwing by name when one is missing.
 */
function buildReplayRequest(
  action: ReplayAction,
  params: Record<string, string>,
  session: Session,
): ReplayRequest {
  const headers = trelloHeaders(session.credentials.values.cookieHeader);
  return { method: action.method, url: actionUrl(action, params), headers };
}

// ── The adapter ────────────────────────────────────────────────────────────────

export const trelloAdapter: Adapter = {
  id: ADAPTER_ID,
  displayName: 'Trello',
  // Parent domain only: tlsInterceptList derives *.trello.com, and listing api.trello.com
  // made the lookalike probe test notapi.trello.com, which matchRequest rightly claims.
  hosts: ['trello.com'],
  matchRequest(input) {
    return matchesTrello(input.host);
  },
  parse: parseTrelloCapture,
  classify: classifyTrelloCapture,
  nextCursors: trelloNextCursors,
  listReplayActions() {
    return TRELLO_REPLAY_ACTIONS;
  },
  buildReplayRequest,
};
