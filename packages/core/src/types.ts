// SPDX-License-Identifier: Apache-2.0
import type { AppRedaction } from './redact.js';

/**
 * @sluice/core — the frozen contract every package compiles against.
 *
 * Two worlds, kept strictly apart:
 *   1. Captures + normalized entities  → persisted in SQLite, streamed to the webapp.
 *   2. Credentials (Session/CredentialBundle) → in-memory only, NEVER persisted or streamed.
 *      Only a RedactedSession (no secret values) ever crosses those boundaries.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Captures — one normalized HTTP exchange, engine-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

export type CaptureSource = 'mitm' | 'cdp' | 'replay' | 'import' | 'ws' | 'ext';

/** Which way a WebSocket frame travelled. Absent on ordinary HTTP exchanges. */
export type FrameDirection = 'sent' | 'received';

export interface Capture {
  id: string;
  /** epoch milliseconds when the request was observed */
  ts: number;
  source: CaptureSource;
  /** which adapter claimed this capture, or null if unclassified */
  adapterId: string | null;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  durationMs: number | null;
  /** header maps are already secret-redacted before a Capture is constructed */
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  resHeaders: Record<string, string>;
  /** decoded (un-gzipped) response text; JSON is stored as-is */
  resBody: string | null;
  /** per-app attribution (Phase B / mitmproxy power mode only) */
  pid?: number | null;
  processName?: string | null;
  /**
   * Which browser tab produced this (Engine C only — the CDP target id, stable
   * for the life of the tab), and that tab's URL at capture time. Lets the UI
   * separate concurrent tabs instead of showing one undifferentiated stream.
   */
  tabId?: string | null;
  tabUrl?: string | null;
  /**
   * WebSocket frames (`source: 'ws'`). `direction` says which way the frame
   * went; `wsId` groups every frame of one socket. The payload lives in
   * `reqBody` for a sent frame and `resBody` for a received one, so the existing
   * inspector tabs show it without special-casing. `status` is null and `method`
   * is 'WS' — a frame has neither.
   */
  direction?: FrameDirection | null;
  wsId?: string | null;
  /**
   * A stable name for what this exchange DOES — `conversations.history` rather
   * than `POST /api/conversations.history`, `boards/:id/cards` rather than one
   * distinct row per board.
   *
   * This is the traffic table's Operation column and what `op:` filters match,
   * and deriving it once at ingest is what makes those cheap. It is populated
   * for unclassified traffic too: "which endpoints does this service call?" is
   * precisely the question being asked when no adapter exists yet.
   */
  classification?: string | null;
  /**
   * Epoch ms when this capture was last parsed into entities; null means never.
   * Parsing is resumable across restarts because of this column — the previous
   * high-water mark lived in memory and reset with the process.
   */
  parsedAt?: number | null;
}

/** Minimal shape an adapter needs to decide "is this mine?" */
export type RequestMatchInput = Pick<Capture, 'host' | 'path' | 'method' | 'url'>;

// ─────────────────────────────────────────────────────────────────────────────
// Normalized entities — what all adapters emit into, regardless of service.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `thread` is the one that is not a place you browse to.
 *
 * A channel, a board, a label — those are structure: a reader picks one and
 * looks inside it. A thread is a container only because its messages need
 * somewhere to live, and there is one per conversation, so a store holding a few
 * hundred captured conversations has a few hundred of them. Listed as peers of
 * the labels they came from, they bury the structure completely: the recorded
 * mailbox showed 24 labels among 94 threads, alphabetically interleaved.
 *
 * So this exists to let a reader tell "somewhere to go" from "somewhere things
 * are", which no combination of the other kinds could express. Adapters that
 * emit one container per conversation should use it.
 */
export type ContainerKind =
  | 'channel'
  | 'dm'
  | 'group'
  | 'board'
  | 'project'
  | 'thread'
  | 'other';
export type ItemKind = 'message' | 'page' | 'issue' | 'other';

export interface Workspace {
  id: string;
  adapterId: string;
  name: string;
  domain?: string;
  /** original service payload, for lossless inspection */
  raw?: unknown;
}

export interface Actor {
  id: string;
  workspaceId: string;
  adapterId: string;
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  raw?: unknown;
}

export interface Container {
  id: string;
  workspaceId: string;
  adapterId: string;
  kind: ContainerKind;
  name: string;
  topic?: string;
  isPrivate?: boolean;
  memberCount?: number;
  /**
   * How many items the SERVICE says this container holds, and how many of them
   * are unread — not how many Sluice has captured.
   *
   * The distinction is the whole point of storing them. A local store is always
   * a sample: Gmail's Inbox reported 14,061 conversations against the 50 a single
   * thread-list response carried. Without the service's own number there is
   * nothing to compare a capture against, so "I have all of it" and "I have the
   * first page" look identical — and the second one silently answers questions
   * about a mailbox using a fiftieth of it.
   *
   * Distinct from `memberCount`, which counts PEOPLE. Both are optional and both
   * mean "unknown" when absent; neither is ever inferred from what was captured.
   */
  itemCount?: number;
  unreadCount?: number;
  raw?: unknown;
}

export interface Item {
  id: string;
  containerId: string;
  workspaceId: string;
  adapterId: string;
  kind: ItemKind;
  authorId?: string;
  /** epoch milliseconds (adapters normalize service-native timestamps) */
  ts: number;
  text: string;
  /** thread root id, if this item is a threaded reply */
  threadId?: string;
  /** provenance: capture ids this entity was derived from */
  sourceCaptureIds?: string[];
  raw?: unknown;
}

/** Which entity table an edge endpoint lives in. */
export type EntityKind = 'workspace' | 'actor' | 'container' | 'item';

/**
 * A relationship between two entities — membership, authorship, a mention, a
 * reaction. Containment (item→container→workspace) is already a column on the
 * entity itself; an edge is for everything else, which previously had nowhere to
 * go at all.
 *
 * Endpoints are (kind, id) pairs, not foreign keys: an edge may point at any
 * entity table, and captures routinely name an entity Sluice has never seen — a
 * message mentioning a user whose profile appeared in no response. A dangling
 * edge is expected, not an error.
 */
export interface Edge {
  srcKind: EntityKind;
  srcId: string;
  /** e.g. 'member-of', 'authored', 'mentions', 'reacted-to', 'replies-to' */
  rel: string;
  dstKind: EntityKind;
  dstId: string;
  adapterId: string;
  workspaceId?: string;
  raw?: unknown;
}

/** The result of parsing one capture into normalized entities. */
export interface ParseResult {
  workspaces?: Workspace[];
  actors?: Actor[];
  containers?: Container[];
  items?: Item[];
  edges?: Edge[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Store queries — what a reader asks for.
//
// These live here rather than next to the SQLite implementation because they are
// part of the contract: {@link ReadOnlyStore} is what an app's MCP tools are
// handed, and a type in the contract cannot be typed by one in the engine.
// ─────────────────────────────────────────────────────────────────────────────

export interface CaptureQuery {
  adapterId?: string;
  host?: string;
  sinceTs?: number;
  limit?: number;
  /** Restrict to one browser tab (Engine C's CDP target id). */
  tabId?: string;
  /** Exact match on the adapter's semantic operation name. */
  classification?: string;
  /** Only captures that have never been parsed into entities. */
  unparsed?: boolean;
  /** Only captures no adapter claimed (`adapter_id IS NULL`) — the pre-scoping noise. */
  unattributed?: boolean;
  /**
   * FTS5 query over request + response bodies. This is a MATCH expression, not a
   * substring: `not_in_channel`, `"rate limited"`, `channel AND error`. Callers
   * taking user input should go through `ftsQuery` — an unbalanced quote or a
   * bare `*` is a syntax error inside SQLite, not a zero-result search.
   */
  bodyMatch?: string;
}

export interface ItemQuery {
  limit?: number;
  beforeTs?: number;
  /**
   * Skip this many rows. Deliberately alongside `beforeTs` rather than replacing
   * it: a live feed walks backwards from a timestamp it already holds, but an
   * agent asking for "the next 50" holds nothing but a page number, and telling
   * it to synthesize a cursor from the last row it saw is how a reader ends up
   * unable to walk past the first page at all.
   */
  offset?: number;
}

/** An {@link ItemQuery} that is not pinned to one container. */
export interface ItemFilter extends ItemQuery {
  containerId?: string;
  adapterId?: string;
  workspaceId?: string;
  /**
   * One item's own id. Not a primary key on its own — items are keyed by
   * `(containerId, id)`, so the same id can legitimately appear under two
   * containers — which is exactly why this is a filter and not a `getItem`.
   */
  id?: string;
  /**
   * `true` → only items carrying a `threadId`; `false` → only those without one.
   * Omitted matches both.
   *
   * This is the one structural distinction a generic reader cannot make for
   * itself, and adapters lean on it: Gmail's batch view emits one item per THREAD
   * and sets no `threadId`, while its thread fetcher emits one per MESSAGE and
   * sets the thread it belongs to. Counting them together reports a mailbox with
   * more conversations than it has.
   */
  threaded?: boolean;
}

export interface ItemSearchQuery {
  containerId?: string;
  adapterId?: string;
  limit?: number;
  offset?: number;
}

export interface EdgeQuery {
  srcKind?: EntityKind;
  srcId?: string;
  dstKind?: EntityKind;
  dstId?: string;
  rel?: string;
  workspaceId?: string;
  limit?: number;
}

/**
 * A READ-ONLY projection of the capture store.
 *
 * There is no write method here and no way to reach a Session, and both are the
 * point: an app's MCP tool must be able to answer from what was captured without
 * being able to change it or to touch a credential. `readOnlyStore()` in
 * `@sluice/core` builds one by binding exactly these methods off a SqliteStore,
 * so handing over the store itself — which does have writers, and a raw `db`
 * handle — is a different act and not one that happens by accident.
 *
 * Nothing here returns a Capture. Coverage questions ("how much is captured, how
 * stale is it") are answerable with a count and a timestamp; handing over capture
 * BODIES would hand back the un-normalized traffic an adapter exists to
 * interpret, at up to 5 MB a row.
 */
export interface ReadOnlyStore {
  listWorkspaces(): Workspace[];
  listContainers(workspaceId?: string): Container[];
  /** Items in one container, newest first. */
  listItems(containerId: string, q?: ItemQuery): Item[];
  /** Items across containers — the read `listItems` cannot express. */
  queryItems(q?: ItemFilter): Item[];
  /** How many items match, ignoring `limit`/`offset`. */
  countItems(q?: ItemFilter): number;
  /** Full-text search over item text. */
  searchItems(text: string, q?: ItemSearchQuery): Item[];
  listEdges(q?: EdgeQuery): Edge[];
  countCaptures(q?: CaptureQuery): number;
  /** When the newest matching capture landed, or null if there is none. */
  newestCaptureTs(q?: CaptureQuery): number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination worklist — what `sluice replay --all` drains.
// ─────────────────────────────────────────────────────────────────────────────

export type CursorState = 'pending' | 'running' | 'done' | 'failed';

/**
 * One more page to fetch. An adapter emits these when it sees a paged response;
 * the drainer turns each into a replay of `actionId` with `cursor` applied.
 */
export interface CursorSeed {
  adapterId: string;
  /** A ReplayAction id from the adapter's listReplayActions(). */
  actionId: string;
  /** The container this page belongs to, when the action is container-scoped. */
  containerId?: string;
  /** The service's own opaque pagination token. */
  cursor?: string;
  /** Any other params the action needs, verbatim. */
  params?: Record<string, string>;
  /**
   * Why this exists. Not all "more work" is pagination: Slack's boot response
   * carries no cursor at all, but names every channel, so the next work is one
   * history call PER channel. Trello has no opaque cursor anywhere in its REST
   * API and is fan-out only.
   */
  reason?: 'cursor' | 'fanout';
  /**
   * How many hops from the originally-captured call. A boot response fans out to
   * every channel, each of which paginates, each page of which can fan out
   * again — without a depth bound that is unbounded work against a live API.
   */
  depth?: number;
}

/** A CursorSeed once it is in the worklist, with its bookkeeping. */
export interface WorkItem extends CursorSeed {
  id: string;
  state: CursorState;
  attempts: number;
  lastError?: string;
  createdTs: number;
  updatedTs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Credentials & sessions — SECRET. In-memory only.
// ─────────────────────────────────────────────────────────────────────────────

/** How to apply a credential bundle to an outgoing replay request. */
export interface CredentialInjection {
  /** e.g. a service sends the token as a `token` form field */
  tokenFormField?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  query?: Record<string, string>;
}

/**
 * Full-session credentials. `values` is SECRET — it must never be written to
 * the store, logged, or streamed. Persist only a RedactedSession.
 */
export interface CredentialBundle {
  /** e.g. an app session kind */
  kind: string;
  /** SECRET key/value pairs, e.g. { token: '…', cookie: '…' } */
  values: Record<string, string>;
  injection: CredentialInjection;
}

export interface Session {
  id: string;
  adapterId: string;
  workspaceId?: string;
  label: string;
  credentials: CredentialBundle;
  /** epoch ms */
  discoveredAt: number;
  source: 'local-store' | 'capture' | 'manual';
}

/** Safe-to-persist / safe-to-stream projection of a Session (no secret values). */
export interface RedactedSession {
  id: string;
  adapterId: string;
  workspaceId?: string;
  label: string;
  source: Session['source'];
  discoveredAt: number;
  /** the credential kinds present, — names only, no values */
  credentialKinds: string[];
}

export function redactSession(s: Session): RedactedSession {
  return {
    id: s.id,
    adapterId: s.adapterId,
    workspaceId: s.workspaceId,
    label: s.label,
    source: s.source,
    discoveredAt: s.discoveredAt,
    credentialKinds: [s.credentials.kind],
  };
}

/**
 * A candidate credential the auth-reconstructor spotted in a capture.
 * This is the seed of the Phase-B differentiator; Phase A only needs the type.
 */
export interface CredentialHint {
  adapterId: string;
  location: 'header' | 'cookie' | 'query' | 'body' | 'localStorage' | 'keychain';
  name: string;
  /** redacted preview, e.g. 'abc123…（40 more）' — never the full secret */
  valuePreview: string;
  /** 0..1 */
  confidence: number;
  role: 'bearer' | 'session-cookie' | 'csrf' | 'refresh' | 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay — re-issuing a captured call with edited params via a Session.
// ─────────────────────────────────────────────────────────────────────────────

export type ReplayParamKind = 'string' | 'number' | 'cursor' | 'containerId';

export interface ReplayParam {
  name: string;
  label: string;
  kind: ReplayParamKind;
  default?: string;
  required?: boolean;
}

export interface ReplayAction {
  id: string;
  adapterId: string;
  label: string;
  method: string;
  /** e.g. 'https://api.example.com/v1/messages' */
  urlTemplate: string;
  params: ReplayParam[];
}

export interface ReplayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter — the pluggable per-service seam.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a parser is allowed to know beyond the capture itself.
 *
 * Every adapter was re-deriving this per call: Slack lifts `channel` out of the
 * REQUEST because `conversations.history` responses do not contain it, and
 * re-guesses the team id per capture; Trello and Fast hardcode a workspace id.
 *
 * Optional everywhere, and `parse(capture)` still works without it — the three
 * shipped adapters and five call sites predate it.
 */
export interface ParseContext {
  /**
   * Request parameters, however the service sent them: query string, urlencoded
   * form body, or JSON body. Slack's channel id exists ONLY here for
   * `conversations.history` and `conversations.replies`, so a parser that loses
   * the request silently produces zero items rather than an error.
   */
  reqParams?: Record<string, string>;
  /** The already-resolved workspace, when the caller knows it. */
  workspaceId?: string;
  /**
   * The clock to use. Exists so a fixture replay is deterministic: callers
   * otherwise fall back to `Date.now()` whenever `capture.ts` is falsy, which
   * defeats any snapshot assertion over a mock run.
   */
  now?: number;
}

/**
 * What kind of exchange a capture is, independent of which entities it yields.
 *
 * The distinction that matters most is ERROR: Slack signals a logical failure as
 * HTTP 200 with `{ ok: false }`, and every parser collapses that to an empty
 * result — identical to "endpoint I don't recognise". Without a class, a
 * `not_authed` or `ratelimited` response is indistinguishable from success.
 */
export type CaptureClass =
  /** Workspaces, actors, containers — the shape of the account. */
  | 'structure'
  /** Messages, cards, pages — the contents of a container. */
  | 'messages'
  /** Sign-in / token-check calls. */
  | 'auth'
  /** The service said no: HTTP 4xx/5xx, or a 200 whose body says otherwise. */
  | 'error'
  /** Static assets — the SPA shell, JS bundles, images. Never parseable. */
  | 'asset'
  /** Large binary payloads that must not be persisted at all. */
  | 'binary'
  /** Claimed by this adapter but not recognised. */
  | 'unknown';

/**
 * The store operations {@link Adapter.reconcile} is allowed, spelled out
 * structurally so an adapter can be tested against a few rows in memory and so
 * the contract is a list of what reconciliation may do rather than a handle to
 * everything. `SqliteStore` satisfies it as written.
 *
 * Note what is NOT here: no way to delete a capture. That is the guardrail —
 * entities are one reading of the evidence and can be rebuilt, the evidence
 * cannot.
 */
export interface ReconcileStore {
  listWorkspaces(): Workspace[];
  listCaptures(q: { adapterId?: string; limit?: number }): Capture[];
  queryItems(q?: ItemFilter): Item[];
  applyParseResult(pr: ParseResult, ts: number): unknown;
  deleteWorkspace(workspaceId: string): unknown;
}

/** What a reconciliation did, in terms the CLI and the UI can report. */
export interface ReconcileOutcome {
  /** How many workspaces changed identity. Zero means "nothing to settle". */
  changed: number;
  /** One line for a human — what moved where, and what could not be settled. */
  note?: string;
}

export interface Adapter {
  id: string;
  displayName: string;
  /** hostnames this adapter cares about, used by the default matchRequest */
  hosts: string[];
  /** does this capture belong to this adapter? */
  matchRequest(input: RequestMatchInput): boolean;
  /** turn one capture into normalized entities (empty result if nothing useful) */
  parse(capture: Capture, ctx?: ParseContext): ParseResult;
  /**
   * What kind of exchange this is, and what to call it — without parsing it.
   *
   * Cheap enough to run on every capture in the ingest funnel, which is what
   * makes the traffic table's Operation column and `op:` filters possible, and
   * what lets a recorder skip a 25 MB binary instead of storing it.
   *
   * Like `parse`, this MUST NOT throw: it runs for every capture, and a throw
   * poisons the whole pipeline.
   */
  classify?(capture: Capture, ctx?: ParseContext): { class: CaptureClass; operation?: string };
  /**
   * More pages to fetch, given a response that was just parsed.
   *
   * Returning [] is a perfectly good answer and the common one — Trello has no
   * opaque cursor anywhere in its REST API, and fast.com has no pagination at
   * all. MUST NOT throw, same reason as `parse`.
   */
  nextCursors?(capture: Capture, ctx?: ParseContext): CursorSeed[];
  /**
   * Settle identities that no single capture could establish, given the store.
   *
   * `parse` sees one exchange at a time, and some services do not put an
   * identity in every exchange. Gmail is the case that forced this: it addresses
   * accounts by a `/u/N/` path slot, the slot is reassigned whenever the
   * signed-in set changes, and only the message-fetch endpoint names the mailbox
   * behind it — so a thread-list response genuinely cannot say whose mail it is
   * describing. Parsing it as though it could is how two mailboxes ended up
   * merged into one workspace with nothing reporting a conflict.
   *
   * So the parser is allowed to say "unresolved", and this is where the answer
   * is worked out from the neighbouring captures. Optional, and absent for the
   * three shipped adapters that put a workspace id in every response.
   *
   * MUST be idempotent, and MUST NOT delete captures: it is run opportunistically
   * (after a sync, on MCP startup) and the evidence has to outlive any reading
   * of it, or a reconciliation that guesses wrong cannot be redone.
   */
  reconcile?(store: ReconcileStore): ReconcileOutcome;
  /** the parameterizable calls the webapp can re-issue */
  listReplayActions(): ReplayAction[];
  /** build a concrete request from an action + params + a session's credentials */
  buildReplayRequest(action: ReplayAction, params: Record<string, string>, session: Session): ReplayRequest;
  /** Phase-B seed: surface credential candidates seen in a capture */
  extractCredentialHints?(capture: Capture): CredentialHint[];
}

// ─────────────────────────────────────────────────────────────────────────────
// App plugin — an Adapter plus an optional credential seam.
//
// The engine (interceptor/runner/mcp) knows only about `App`; the concrete apps
// live in their own packages and are wired in through `@sluice/apps`. This keeps
// each service out of the generic spine.
// ─────────────────────────────────────────────────────────────────────────────

/** A signed-in workspace as seen by an app's credential provider — secret-free. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  domain?: string;
  url?: string;
}

/**
 * How an app discovers and mints in-memory Sessions from local state.
 * Everything it returns is SECRET (a Session's `credentials.values`) except
 * `listWorkspaces`, which is passive and secret-free.
 */
export interface CredentialProvider {
  /** Discover every locally signed-in Session for this app (macOS local-store). */
  extractSessions(opts?: { appSupportDir?: string }): Promise<Session[]>;
  /** Passively enumerate signed-in workspaces without touching secrets/Keychain. */
  listWorkspaces?(opts?: { appSupportDir?: string }): Promise<WorkspaceInfo[]>;
  /**
   * Build a Session from user-supplied raw credential material (paste-in);
   * returns undefined when the input is insufficient for this app.
   */
  sessionFromInput?(input: Record<string, string>): Session | undefined;
}

/**
 * An MCP tool an app contributes to the Sluice MCP server. `run` executes the
 * tool's action (which MAY touch the network) and returns a JSON-serializable
 * result; the server registers it under `name` and renders the result to the
 * client. Errors thrown from `run` are caught by the server and surfaced as tool
 * errors.
 */
/**
 * What the MCP server hands an app tool so its network calls behave like every
 * other Sluice request.
 *
 * Without this, an app tool could only reach the network with a bare `fetch`:
 * its traffic bypassed the learned client fingerprint (making it MORE anomalous
 * than a normal replay) and never entered the capture store, so it was invisible
 * to the cartographer, the dashboard and the audit trail — while `sluice_replay`
 * calls were fully recorded.
 */
export interface AppToolContext {
  /**
   * Issue a request the way `sluice_replay` does: overlay the real client's
   * learned fingerprint for this endpoint, enforce the replay safety rails,
   * record the result as a Capture attributed to this app, and parse it.
   * Resolves with the stored, secret-redacted Capture.
   */
  replay(req: ReplayRequest): Promise<Capture>;
  /**
   * What this app has already captured, read-only.
   *
   * Without it, `replay` was the ONLY thing on this context — so an app tool that
   * wanted to answer from the store had nowhere to live, and Gmail's four
   * store-backed tools were written into the MCP server's own spine instead,
   * where `@sluice/apps` is supposed to be the only module that names a concrete
   * adapter. This is what let them move back.
   *
   * OPTIONAL, and it stays optional: the two apps that already implement
   * `mcpTools()` and every existing caller that constructs a context compile
   * unchanged. A tool that needs it must say so when it is absent rather than
   * assume a host provides it.
   */
  readonly store?: ReadOnlyStore;
}

export interface AppMcpTool {
  name: string;
  description: string;
  /**
   * The tool's parameters as a zod raw shape, e.g. `{ boardId: z.string() }`.
   * Kept structurally typed so `@sluice/core` stays zod-free; the MCP server
   * passes it straight to `registerTool`. Omit it only for genuinely
   * argument-less tools — a tool that declares nothing here is advertised to
   * clients as taking no parameters, so `run` would never receive any.
   */
  inputSchema?: Record<string, unknown>;
  /**
   * Execute the tool. `ctx` is optional so a tool that touches no network (or a
   * caller that cannot provide one) still works; prefer `ctx.replay` over a bare
   * `fetch` whenever the call goes to the service this app adapts.
   */
  run(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown>;
}

/** An installed app: the pluggable adapter plus an optional credential seam. */
export interface App extends Adapter {
  credentials?: CredentialProvider;
  /** Zero or more MCP tools this app contributes to the MCP server. */
  mcpTools?(): AppMcpTool[];
  /**
   * Service-specific redaction this app contributes to the global policy: its
   * own token shapes, and any query params of its that are public and must
   * survive redaction. Applied to ALL traffic, since redaction runs before a
   * capture is attributed to an adapter.
   */
  redaction?: AppRedaction;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine status — reported to the webapp.
// ─────────────────────────────────────────────────────────────────────────────

export type EngineKind = 'mitm' | 'cdp' | 'replay';
/**
 * `restarting` is the one that was missing, and its absence was not cosmetic.
 *
 * An engine that died and is being brought back is neither `starting` (which
 * reads as a first start, so the UI shows a fresh boot and nobody learns the
 * capture had a hole in it) nor `error` (which reads as given up, when it has
 * not). The supervisor needs to say "this fell over and I am retrying", because
 * the honest thing to report about a capture session is that it was interrupted.
 */
/**
 * `stopping` is the deliberate-teardown signal. Without it a `stop()` that awaits
 * its async server shutdown still read `running` throughout, so a supervisor
 * health probe firing during teardown mistook the closing port for a crash and
 * restarted the engine the user had just stopped. `restarting` is the crash-then-
 * retry state (see the supervisor); the two are distinct and must not be
 * conflated — one is "I am winding down", the other "I fell over and am coming
 * back".
 */
export type EngineState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'restarting'
  | 'error';

export interface EngineStatus {
  engine: EngineKind;
  state: EngineState;
  detail?: string;
  proxyPort?: number;
}
