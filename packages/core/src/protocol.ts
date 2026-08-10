// SPDX-License-Identifier: Apache-2.0
/**
 * WebSocket protocol between the runner (server) and the webapp (client).
 * Loopback only; the client must present the per-session bearer token first.
 *
 * Secrets never appear here — only Capture / normalized entities / RedactedSession.
 */
import type {
  Actor,
  Capture,
  Container,
  EngineStatus,
  Item,
  ParseResult,
  RedactedSession,
  Workspace,
} from './types.js';

export const WS_PROTOCOL_VERSION = 1;

// ── Server → client ──────────────────────────────────────────────────────────

/**
 * What every server frame carries beyond its own payload.
 *
 * `seq` is stamped on BROADCAST frames only — the ones the server holds in a
 * ring so a reconnecting client can resume. Frames addressed to one connection
 * (the hello, the subscribe-time priming, a replay result) answer something that
 * connection asked for and mean nothing to replay, so they carry none.
 *
 * The counter is per-RUNNER, not per-connection. A subscriber with a filter
 * therefore sees gaps — 5, 7, 8, 12 — and that is deliberate: renumbering per
 * connection would mean re-serializing every frame for every subscriber, and one
 * `JSON.stringify` per broadcast is worth more than contiguous numbering. A
 * resume replays the ring through the same filter, so the gaps come out the same.
 */
export interface ServerFrame {
  seq?: number;
}

export interface HelloMsg extends ServerFrame {
  type: 'hello';
  protocolVersion: number;
  appVersion: string;
  adapters: { id: string; displayName: string }[];
  /**
   * Whether this runner was started with `--terminal`. A static server
   * capability, not runtime state — the embedded Claude Code terminal is off
   * unless the operator opted in at launch, so the dashboard only shows the
   * terminal affordance when this is true. It lives on `hello` (always sent,
   * once) rather than in the environment frame because it never changes for the
   * life of the process.
   */
  terminalEnabled?: boolean;
}

/**
 * The `/pty` socket's wire protocol — deliberately NOT part of the zod-validated
 * {@link ClientMsg}/{@link ServerMsg} unions.
 *
 * `/pty` is a second, separately-gated WebSocket (its own capability secret) that
 * carries a raw terminal byte stream to and from an embedded Claude Code session.
 * It has nothing to do with capture traffic, so it stays off the main channel:
 * folding a high-frequency keystroke/redraw stream into the broadcast ring — which
 * pins bodies for resume — would be actively wrong. These frames are small and
 * hand-validated at the boundary in server.ts.
 */
export type PtyClientFrame =
  | { t: 'stdin'; d: string }
  | { t: 'resize'; cols: number; rows: number }
  /** Explicitly end the session (kill the child). A reload/close does NOT — the
   *  session persists so it can be re-attached; only this tears it down. */
  | { t: 'end' };

export type PtyServerFrame =
  | { t: 'ready' }
  | { t: 'data'; d: string }
  | { t: 'exit'; code: number | null }
  | { t: 'error'; message: string };

export interface CaptureNewMsg extends ServerFrame {
  type: 'capture.new';
  capture: Capture;
}

export interface EntityUpsertMsg extends ServerFrame {
  type: 'entity.upsert';
  workspaces?: Workspace[];
  actors?: Actor[];
  containers?: Container[];
  items?: Item[];
}

export interface ReplayResultMsg extends ServerFrame {
  type: 'replay.result';
  requestId: string;
  capture: Capture;
  parsed?: ParseResult;
}

export interface ReplayErrorMsg extends ServerFrame {
  type: 'replay.error';
  requestId: string;
  error: string;
}

export interface SessionDiscoveredMsg extends ServerFrame {
  type: 'session.discovered';
  session: RedactedSession;
}

/**
 * The replay rate budget as a value, so the UI can SHOW it.
 *
 * The bucket used to be write-only: the one signal it produced was a refusal, at
 * the moment it was already exhausted. That is the worst time to learn about a
 * rate limit — someone watching a meter drain slows down, someone who gets a
 * refusal has already spent the budget on the request that was refused.
 */
export interface ReplayBudgetState {
  /** Replays available right now. */
  tokens: number;
  /** Replays per window. */
  capacity: number;
  /** How long the window is, in ms. */
  refillMs: number;
  /**
   * How long until at least one token exists, in ms; 0 when one already does.
   *
   * Named for the HTTP header it plays the part of, and sent as a DURATION
   * rather than a deadline: the page's clock is not the runner's, and a wall
   * time computed on one and counted down on the other is wrong by the skew
   * between them.
   */
  retryAfterMs: number;
}

export interface StatusMsg extends ServerFrame {
  type: 'status';
  engines: EngineStatus[];
  /**
   * Optional because the field is newer than the frame and an older runner
   * simply will not send it — the UI hides the meter rather than rendering a
   * budget of zero, which would read as "exhausted" instead of "not reported".
   */
  replayBudget?: ReplayBudgetState;
}

/** A transient toast for the UI (sync progress, errors). */
export interface NoticeMsg extends ServerFrame {
  type: 'notice';
  level: 'info' | 'error';
  text: string;
}

/** How far an app has been "built" locally — the dashboard's per-app checklist. */
export interface AppBuildStatus {
  /** an adapter is registered for this app */
  adapter: boolean;
  /** captured / parsed data exists locally */
  data: boolean;
  /** a per-app database has been materialized (Cartographer) */
  db: boolean;
  /** exposed as an MCP server */
  mcp: boolean;
}

/** One MCP tool an app contributes, as the catalog describes it. */
export interface AppCatalogMcpTool {
  name: string;
  description: string;
  /**
   * Parameter names, in declaration order. Names only: the tool's schema is a
   * zod raw shape, and zod objects do not survive JSON.
   */
  params: string[];
}

/** One replay action an app exposes, as the catalog describes it. */
export interface AppCatalogReplayAction {
  id: string;
  label: string;
  method: string;
  /**
   * `kind` is the ReplayParam kind as a plain string rather than the enum, so
   * adding a param kind to the adapter contract is not also a protocol change.
   *
   * `label` and `default` used to be dropped here, which was fine while the
   * catalog only had to render chips and became wrong the moment a form was
   * generated from it: a field labelled `types` instead of "Channel types", and
   * an adapter's own `limit=200` default silently not applied, are both the
   * adapter's stated intent being thrown away in transit.
   */
  params: { name: string; kind: string; required?: boolean; label?: string; default?: string }[];
}

export interface AppCatalogEntry {
  id: string;
  displayName: string;
  /** an engine is actively capturing this app right now */
  capturing: boolean;
  build: AppBuildStatus;
  /**
   * The hostnames the adapter claims — and therefore exactly what the proxy
   * decrypts for this app. The one field on this entry that is about privacy
   * rather than progress, which is why it is worth showing.
   */
  hosts: string[];
  /**
   * The app's full capabilities, not just whether it has any.
   *
   * `build.mcp` is a boolean and stays one: it drives a checklist tick. It
   * cannot answer "what did Sluice collect for this app, and what can I do with
   * it?", which is the whole of the per-app page — so the inventory travels with
   * the catalog instead of forcing a second round trip per app.
   */
  mcpTools: AppCatalogMcpTool[];
  replayActions: AppCatalogReplayAction[];
  stats: {
    captures: number;
    endpoints: number;
    workspaces: number;
    containers: number;
    actors: number;
    items: number;
  };
}

/** The launcher catalog: every interceptable app + its local build status. */
export interface AppsMsg extends ServerFrame {
  type: 'apps';
  apps: AppCatalogEntry[];
}

/**
 * A chunk of recent captures sent when a client subscribes, oldest-first.
 * Priming used to send one `capture.new` frame per capture — 2000 separate
 * JSON.stringify calls and socket writes, each carrying a body up to 5 MB, on
 * every page reload. Batching keeps a refresh cheap.
 */
export interface CaptureBackfillMsg extends ServerFrame {
  type: 'capture.backfill';
  captures: Capture[];
  /** True on the final chunk, so a client can show "primed" exactly once. */
  done: boolean;
  /**
   * How this client was primed: `full` is everything recent from the store,
   * `resume` is only what it missed while disconnected.
   *
   * Stated rather than inferred. A client that asked to resume and was given a
   * full backfill instead cannot tell from the frames — they are the same shape
   * — so it would fold 2000 rows into a buffer it should have replaced, and end
   * up with a view stitched together from two eras. A silent partial resume is
   * the same bug with quieter symptoms.
   */
  mode?: 'full' | 'resume';
}

/**
 * The lifecycle of ONE named, possibly-long-running operation the dashboard
 * triggered — a sync, a prune, a vacuum, a rematerialize, an engine start.
 *
 * Exists because the `notice` model cannot carry this. There is one notice slot
 * and a 4.5s toast, so `onSync` firing a notice per failed action clobbers
 * itself — you see the last of five and nothing that finished. An operation is
 * keyed by its `requestId`, so successive frames for the same op UPDATE one row
 * rather than replacing an unrelated message; the client keeps a small map and
 * renders running/done/error distinctly, and an error persists until dismissed
 * instead of vanishing in 4.5s.
 *
 * Broadcast, not answered: two dashboards watching one runner should both see a
 * vacuum in progress, the same reason `capture.state` is broadcast.
 */
export interface OpProgress {
  /** Correlates the frames of one operation. Minted by whoever starts it. */
  requestId: string;
  /** What KIND of operation — 'sync', 'prune', 'vacuum', … — for the label. */
  kind: string;
  state: 'running' | 'ok' | 'error';
  /** Human line: what it is doing, or why it failed. Already redacted. */
  detail?: string;
  /** An optional running/final tally (rows pruned, actions synced, …). */
  count?: number;
}

export interface OpProgressMsg extends ServerFrame {
  type: 'op.progress';
  op: OpProgress;
}

/**
 * The runner's environment: the system-proxy state, and whether the CA exists.
 *
 * Broadcast on change (engine started/stopped, proxy toggled) and at subscribe,
 * so the control page renders the real OS state rather than a guess. Kept
 * separate from `status` (which is the engine's own state) because these are
 * facts about the MACHINE — a proxy someone else set, a CA that exists but is not
 * trusted — that the engine does not know about.
 */
export interface SystemProxyReport {
  supported: boolean;
  enabled: boolean;
  host?: string;
  port?: number;
  /** Whether the enabled proxy points at OUR port rather than someone else's. */
  ours: boolean;
  detail?: string;
}

export interface EnvironmentMsg extends ServerFrame {
  type: 'environment';
  systemProxy: SystemProxyReport;
  proxyPort?: number;
  /** The CA cert exists on disk. Trust is a separate, interactive, CLI-only step. */
  caGenerated: boolean;
  caPath?: string;
}

export type ServerMsg =
  | HelloMsg
  | CaptureNewMsg
  | CaptureBackfillMsg
  | EntityUpsertMsg
  | ReplayResultMsg
  | ReplayErrorMsg
  | SessionDiscoveredMsg
  | StatusMsg
  | AppsMsg
  | NoticeMsg
  | OpProgressMsg
  | EnvironmentMsg
  | CaptureStateMsg;

/**
 * Whether the server is currently writing captures, broadcast to EVERY client.
 *
 * Broadcast rather than answered, because pause is server state: two dashboards
 * open on the same runner must not disagree about whether traffic is being
 * recorded. The client renders this rather than its own optimistic guess.
 */
export interface CaptureStateMsg extends ServerFrame {
  type: 'capture.state';
  paused: boolean;
}

// ── Client → server ──────────────────────────────────────────────────────────

/**
 * The client's half of the version handshake, sent on receiving `hello`.
 *
 * `WS_PROTOCOL_VERSION` used to travel one way and be compared by neither end,
 * which made a half-finished upgrade — a rebuilt runner against a cached page,
 * or a `dist/` webapp from another checkout — present as mysterious breakage: a
 * panel that stays empty because the field feeding it is not in the frame. The
 * server answers a mismatch with a `notice`, so the failure names itself.
 */
export interface HelloOkMsg {
  type: 'hello.ok';
  protocolVersion: number;
}

/** Narrow a connection's stream to one app, or one browser tab, or both. */
export interface SubscribeFilter {
  adapterId?: string;
  tabId?: string;
}

export interface SubscribeMsg {
  type: 'subscribe';
  /**
   * The highest `seq` this client already holds. The server resumes from there
   * if the frame is still in its ring, and otherwise re-primes from the store
   * and says which it did (see {@link CaptureBackfillMsg.mode}). Omit it on a
   * first connection — there is nothing to resume.
   */
  sinceSeq?: number;
  /**
   * Applied per connection, so a client watching one app is not shipped every
   * capture on the machine. Scopes captures only: engine status, notices, the
   * pause state and the catalog are about the runner, and a client that muted
   * them by scoping itself to one app would just render stale.
   */
  filter?: SubscribeFilter;
}

export interface ReplayRunMsg {
  type: 'replay.run';
  requestId: string;
  actionId: string;
  params: Record<string, string>;
  sessionId?: string;
}

/**
 * Ask the server to (re)emit a container's entities so the client can serialize
 * them. Deliberately has no `format`: the WS path only re-emits entities, and the
 * on-disk formats live in `sluice export`. A declared-but-ignored field reads as
 * a capability the server does not have.
 */
export interface ExportMsg {
  type: 'export';
  containerId?: string;
}

/** Reconstruct structure for every known session/workspace (the global Sync button). */
export interface SyncMsg {
  type: 'sync';
}

/**
 * Stop or resume WRITING captures. Not a display filter — the engines keep
 * running and the proxy keeps proxying, but nothing reaches SQLite or the wire.
 *
 * Pause used to be client-side only, which meant the UI said "paused" while the
 * engine went on writing every request to disk. That is the opposite of what
 * someone pressing pause is asking for, and on a capture tool the gap is a
 * privacy problem rather than a cosmetic one: you pause precisely when you are
 * about to do something you do not want recorded.
 *
 * There is deliberately no `clear` action. Clearing the client's view is the
 * client's business, and a socket message that deletes captures from the store
 * would be a destructive action behind a toolbar button — `sluice wipe` and
 * `sluice prune` are the deliberate, out-of-band ways to remove data.
 */
export interface CaptureControlMsg {
  type: 'capture.control';
  action: 'pause' | 'resume';
}

/**
 * Start or stop the capture engine at RUNTIME, from the dashboard.
 *
 * Distinct from `capture.control`: pause/resume gates whether captures are
 * WRITTEN while the engine keeps running; this starts and stops the engine (and
 * therefore the proxy) itself. It is a privileged control — it decrypts traffic
 * — so the server applies a stricter gate to it than to the read stream.
 */
export interface EngineControlMsg {
  type: 'engine.control';
  action: 'start' | 'stop';
  requestId: string;
}

/**
 * Turn the system web proxy on or off — route all of the machine's HTTPS through
 * the loopback proxy, or stop. Accepted only while the engine is running (a proxy
 * pointing at a dead port black-holes the machine's traffic), and `off` only ever
 * clears a proxy that points at THIS runner.
 */
export interface ProxyControlMsg {
  type: 'proxy.control';
  action: 'on' | 'off';
  requestId: string;
}

/**
 * Data management from the dashboard. Every member deletes or rewrites the
 * store, so each carries a `requestId` (progress rides the op.progress model) and
 * the server applies the integrity rules a capture-delete needs: drop + rebuild
 * the derived tables it invalidates, and — for `wipe` — invalidate the resume
 * ring so a reconnecting tab cannot replay deleted captures.
 */
export interface DataPruneMsg {
  type: 'data.prune';
  /** Delete captures older than this many days. */
  maxAgeDays?: number;
  /** Keep only this many newest captures. */
  maxRows?: number;
  vacuum?: boolean;
  requestId: string;
}

/** Delete captures by attribution/host — the pre-scoping noise, or one host. */
export interface DataDeleteCapturesMsg {
  type: 'data.deleteCaptures';
  unattributed?: boolean;
  host?: string;
  vacuum?: boolean;
  requestId: string;
}

/** Drop + rebuild the materialized per-app tables (the reclaim-derived win). */
export interface DataRematerializeMsg {
  type: 'data.rematerialize';
  /** One app, or all when omitted. */
  adapterId?: string;
  requestId: string;
}

/** Clear one app: its derived entities always, its captures when asked. */
export interface DataClearAppMsg {
  type: 'data.clearApp';
  adapterId: string;
  includeCaptures: boolean;
  requestId: string;
}

/** Reclaim free pages. Freezes the server while it rewrites the file. */
export interface DataVacuumMsg {
  type: 'data.vacuum';
  requestId: string;
}

/**
 * Remove ALL captures and derived data. `confirm` must equal the literal
 * `'wipe'`, so a stray frame cannot empty the store — the destructive-confirm UI
 * has the user type it.
 */
export interface DataWipeMsg {
  type: 'data.wipe';
  confirm: string;
  requestId: string;
}

export type ClientMsg =
  | HelloOkMsg
  | SubscribeMsg
  | ReplayRunMsg
  | ExportMsg
  | SyncMsg
  | CaptureControlMsg
  | EngineControlMsg
  | ProxyControlMsg
  | DataPruneMsg
  | DataDeleteCapturesMsg
  | DataRematerializeMsg
  | DataClearAppMsg
  | DataVacuumMsg
  | DataWipeMsg;
