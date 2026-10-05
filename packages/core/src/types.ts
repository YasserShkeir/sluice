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
   * Page-load correlation, filled where the engine knows it; flow clustering
   * prefers these over wall-clock gaps. `loaderId` is CDP's
   * Network.requestWillBeSent.loaderId, `pageLoadId` one document load (often =
   * loaderId), `navigationId` a coarser navigation epoch.
   */
  loaderId?: string | null;
  pageLoadId?: string | null;
  navigationId?: string | null;
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
   * What this exchange DOES (`conversations.history`, `boards/:id/cards`): the
   * traffic table's Operation column and what `op:` filters match. Derived once
   * at ingest, for unclassified traffic too.
   */
  classification?: string | null;
  /** Epoch ms this capture was last parsed into entities; null means never (so parsing resumes after a restart). */
  parsedAt?: number | null;
  /**
   * Set only on a PREVIEW of a capture — a list or WebSocket copy whose
   * `reqBody`/`resBody` were cut to 64 KiB so a backfill does not ship (and pin)
   * up to 5 MB per row — so its presence marks the preview. Holds the full
   * stored bodies' lengths in chars (0 for none). The stored row is always whole
   * and fetched by id; the store never writes or reads this field.
   */
  bodyLengths?: { req: number; res: number };
}

/** Minimal shape an adapter needs to decide "is this mine?" */
export type RequestMatchInput = Pick<Capture, 'host' | 'path' | 'method' | 'url'>;

// ─────────────────────────────────────────────────────────────────────────────
// Normalized entities — what all adapters emit into, regardless of service.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `thread` is a container only because its messages need somewhere to live, not
 * a place a reader browses to; marking it keeps hundreds of conversations from
 * burying the real structure. Adapters emitting one container per conversation
 * should use it.
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
   * The SERVICE's own totals (items held, unread) — not what Sluice captured — so
   * completeness is checkable against them. Absent means unknown; never inferred
   * from captures. Distinct from `memberCount`, which counts people.
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
 * A relationship beyond containment (membership, authorship, a mention, a
 * reaction). Endpoints are (kind, id) pairs, not foreign keys: captures routinely
 * name entities Sluice has never seen, so a dangling edge is expected.
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
// Store queries — part of the contract, since {@link ReadOnlyStore} is typed by them.
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
   * Oldest-first instead of the default newest-first — what REBUILDING state from
   * the log needs, since entity upserts are last-writer-wins. Ties break on `id`,
   * so {@link CaptureQuery.after} can page it.
   */
  order?: 'asc' | 'desc';
  /**
   * Only captures strictly after this `(ts, id)` key: the keyset for paging an
   * `order: 'asc'` walk (a `ts` bound alone cannot page — rows share a millisecond).
   */
  after?: { ts: number; id: string };
  /** Look up these capture ids (result order not guaranteed; capped by the store). */
  ids?: string[];
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
  /** Skip this many rows — for a reader holding a page number rather than a timestamp. */
  offset?: number;
}

/** An {@link ItemQuery} that is not pinned to one container. */
export interface ItemFilter extends ItemQuery {
  containerId?: string;
  adapterId?: string;
  workspaceId?: string;
  /** One item's id — a filter, not a key: items are keyed by `(containerId, id)`. */
  id?: string;
  /**
   * `true` → only items with a `threadId`; `false` → only those without. Gmail
   * emits one item per THREAD (no threadId) and one per MESSAGE (with one), so
   * counting both overstates conversations.
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
 * A READ-ONLY projection of the capture store — what an app's MCP tools get: no
 * writer, no Session, no capture bodies (counts and timestamps answer coverage).
 * `readOnlyStore()` binds exactly these methods, so handing over the store itself
 * never happens by accident.
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
 * Live-session credentials. `values` is SECRET — it must never be written to
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

/** A candidate credential the auth-reconstructor spotted in a capture. */
export interface CredentialHint {
  adapterId: string;
  location: 'header' | 'cookie' | 'query' | 'body' | 'localStorage' | 'keychain';
  name: string;
  /** redacted preview from `previewSecret`, e.g. 'abc123…(+40)' — never the full secret */
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

/** What a parser may know beyond the capture itself. Optional everywhere. */
export interface ParseContext {
  /**
   * Request params from the query, a form body or a JSON body. Slack's channel id
   * exists only here for `conversations.history`/`replies`.
   */
  reqParams?: Record<string, string>;
  /** The already-resolved workspace, when the caller knows it. */
  workspaceId?: string;
  /** The clock to use, so fixture replays are deterministic. */
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
 * The store operations {@link Adapter.reconcile} may use, structural so it can be
 * tested in memory. Deliberately no way to delete a capture: entities can be
 * rebuilt, the evidence cannot.
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
   * What kind of exchange this is, and what to call it, without parsing it. Runs
   * on every capture at ingest (the Operation column, `op:` filters, skipping
   * binaries), so like `parse` it MUST NOT throw.
   */
  classify?(capture: Capture, ctx?: ParseContext): { class: CaptureClass; operation?: string };
  /** More pages to fetch given a just-parsed response ([] is the common answer). MUST NOT throw. */
  nextCursors?(capture: Capture, ctx?: ParseContext): CursorSeed[];
  /**
   * Settle identities no single capture could establish, from the store — e.g.
   * Gmail's `/u/N/` slots, which only the message-fetch endpoint ties to a
   * mailbox. MUST be idempotent and MUST NOT delete captures: it runs
   * opportunistically, and a wrong guess must stay redoable.
   */
  reconcile?(store: ReconcileStore): ReconcileOutcome;
  /** the parameterizable calls the webapp can re-issue */
  listReplayActions(): ReplayAction[];
  /** build a concrete request from an action + params + a session's credentials */
  buildReplayRequest(action: ReplayAction, params: Record<string, string>, session: Session): ReplayRequest;
  /**
   * Optional hand-authored companion hints when capture clustering is weak.
   * Data-learned templates always win over these at replay time.
   */
  listFlowHints?(): FlowHint[];
  /** Surface credential candidates seen in a capture. */
  extractCredentialHints?(capture: Capture): CredentialHint[];
}

/** Adapter-authored sketch of companions that usually ride with a primary action. */
export interface FlowHint {
  /** Primary ReplayAction id or semantic operation key. */
  primaryKey: string;
  label?: string;
  /** Companion operations (or method+path keys) expected alongside the primary. */
  companions: string[];
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
 * What the MCP server hands an app tool so its network calls get the learned
 * fingerprint, the replay rails and capture recording like every other Sluice
 * request, instead of a bare `fetch`.
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
   * Run one of THIS app's declared replay actions (`listReplayActions()`) under
   * a real session the host acquires, with the same rails and auth-failure
   * retry as `sluice_replay`, and resolve with the stored, redacted Capture.
   * Use it when the request needs the app's credentials: `replay` sends only
   * what the tool built and injects no session. Optional — hosts that only
   * wire `replay` may omit it; a tool that needs it must say so when absent.
   */
  replayAction?(
    actionId: string,
    params?: Record<string, string>,
    opts?: { workspaceId?: string },
  ): Promise<Capture>;
  /**
   * Run a learned multi-step flow template through the same rails as
   * `sluice_replay_flow`. Prefer this over chaining bare `fetch` calls.
   * Optional — hosts that only wire single-request replay may omit it.
   */
  replayFlow?(
    templateId: string,
    params?: Record<string, string>,
    opts?: { workspaceId?: string },
  ): Promise<unknown>;
  /**
   * What this app has already captured, read-only. Optional: a tool that needs it
   * must say so when absent.
   */
  readonly store?: ReadOnlyStore;
}

/**
 * An MCP tool an app contributes to the Sluice MCP server. `run` executes the
 * tool's action (which MAY touch the network) and returns a JSON-serializable
 * result; the server registers it under `name` and renders the result to the
 * client. Errors thrown from `run` are caught by the server and surfaced as tool
 * errors.
 */
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
 * `restarting`: crashed and being retried by the supervisor (the capture has a
 * hole). `stopping`: deliberate teardown, so a health probe does not mistake the
 * closing port for a crash and restart what the user stopped. Never conflate them.
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

// ─────────────────────────────────────────────────────────────────────────────
// Interaction flows — a primary capture + the companions that rode with it: the
// burst a real client fires (history + members + emoji), one model shared by
// clustering, UI grouping and multi-step replay.
// ─────────────────────────────────────────────────────────────────────────────

/** How a capture participates in a flow. */
export type FlowStepRole = 'primary' | 'companion' | 'auth' | 'unknown';

/**
 * Where a flow row came from.
 *   - `observed`  — clustered from real mitm/cdp/ext captures
 *   - `pinned`    — a person marked these captures as one flow
 *   - `replay`    — produced by a multi-step flow replay (later phase)
 *   - `learned`   — template materialization (later phase); reserved
 */
export type FlowSource = 'observed' | 'pinned' | 'replay' | 'learned';

/** One hop inside a flow. */
export interface FlowStep {
  captureId: string;
  /** 0-based order within the flow (usually capture time order). */
  seq: number;
  role: FlowStepRole;
  /** Semantic op when known (`conversations.history`), else undefined. */
  operation?: string;
  /**
   * Whether automated replay should treat a missing/failing step as fatal.
   * Clustering defaults companions to false; the primary is always true.
   */
  required: boolean;
}

export interface InteractionFlow {
  id: string;
  adapterId: string;
  label?: string;
  primaryCaptureId: string;
  startedAt: number;
  endedAt: number;
  source: FlowSource;
  steps: FlowStep[];
}

export interface FlowQuery {
  adapterId?: string;
  source?: FlowSource;
  /** Substring match on label or primary operation. */
  q?: string;
  sinceTs?: number;
  limit?: number;
}

/** What `upsertFlow` accepts — id optional (minted when omitted). */
export interface FlowInput extends Omit<InteractionFlow, 'id'> {
  id?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow templates — the stable shape across many observed bursts sharing a primary
// operation: companions, order, request fingerprints and param bindings.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a value on a later step is filled.
 *   - `literal` — stable across observations; baked into the template
 *   - `flowParam` — supplied by the caller at replay time (channel id, cursor…)
 *   - `bind` — taken from an earlier step's response (json path)
 *   - `session` — filled from live credentials at build time
 *   - `unreproducible` — observed but derivation unknown; step may be skipped
 */
export type FlowParamSource =
  | { kind: 'literal'; value: string }
  | { kind: 'flowParam'; name: string }
  | { kind: 'bind'; fromStep: number; jsonPath: string }
  | { kind: 'session' }
  | { kind: 'unreproducible'; reason: string };

/** One endpoint inside a learned flow template. */
export interface FlowTemplateStep {
  /** 0-based order (chronological in observations). */
  seq: number;
  role: FlowStepRole;
  method: string;
  /**
   * Path template for build/replay. Id-like segments are named placeholders
   * (`/1/cards/{cardId}`) so build can substitute caller/bind values. Legacy
   * templates may still use `:id`.
   */
  path: string;
  /**
   * Most common request host observed for this step (e.g. `www.loom.com`).
   * Build uses it when the path is relative and the adapter has no fixed host.
   * Absent on templates learned before FLOW_TEMPLATE_VERSION 2.
   */
  host?: string;
  /** Semantic op when known. */
  operation?: string;
  /**
   * Whether automated replay fails the whole flow if this step cannot run.
   * Primary is always true; companions become true only at high support.
   */
  required: boolean;
  /**
   * Fraction of observed flows of this primary that included this step
   * (0..1). Useful for UI and for soft vs required decisions.
   */
  support: number;
  /**
   * Median ms after the **previous template step** in observations (0 for first).
   * Used when a primary-anchored schedule is unavailable (e.g. steps before the
   * primary, or templates learned before offset fields existed).
   */
  delayMsP50: number;
  /**
   * Median ms from the **primary** capture's `ts` to this step's `ts` across
   * observations of the same burst (0 for the primary itself).
   *
   * Negative when the companion fired before the primary (auth/bootstrap).
   * Replay prefers this over chained `delayMsP50` so siblings keep the same
   * spacing relative to the main call even if an earlier soft step is skipped.
   */
  offsetFromPrimaryMsP50?: number;
  /**
   * How tightly the primary→step offset clustered (p90 − p10 of observed
   * offsets, ms). Small values mean the client fires this sibling on a stable
   * cadence and pacing should be honored; large values mean wall-clock noise.
   */
  offsetSpreadMs?: number;
  /**
   * Endpoint fingerprint (headers + stable body params). Same shape as
   * cartographer's RequestTemplate, stored as plain data so core stays free
   * of a cartographer import.
   */
  request?: {
    headers: Record<string, string>;
    bodyParams: Record<string, string>;
    volatileParams: string[];
  };
  /**
   * Named params on this step and how to fill them. Keys are form/query names
   * and path placeholder names (`cardId` for `/1/cards/{cardId}`).
   */
  params?: Record<string, FlowParamSource>;
  /** True when no automated build is possible (HMAC, etc.). */
  unreproducible?: boolean;
  unreproducibleReason?: string;
}

export interface FlowTemplate {
  id: string;
  adapterId: string;
  /** Primary semantic op, or `${method} ${path}` when unclassified. */
  primaryKey: string;
  label?: string;
  /** How many observed flows contributed to this template. */
  sampleCount: number;
  /** Schema/learning rule version — bump when learning rules change. */
  version: number;
  learnedAt: number;
  steps: FlowTemplateStep[];
  /** Caller-supplied params the primary (and bound companions) need. */
  flowParams: Array<{ name: string; required: boolean }>;
}

export interface FlowTemplateQuery {
  adapterId?: string;
  primaryKey?: string;
  q?: string;
  limit?: number;
}

/** What `upsertFlowTemplate` accepts — id optional. */
export interface FlowTemplateInput extends Omit<FlowTemplate, 'id'> {
  id?: string;
}
