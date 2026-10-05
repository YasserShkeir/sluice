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
 * `seq` is stamped on BROADCAST frames only — the ones held in the resume ring —
 * never on frames answering one connection. It is per-runner, so a filtered
 * subscriber sees gaps (renumbering would mean re-serializing per subscriber).
 */
export interface ServerFrame {
  seq?: number;
}

export interface HelloMsg extends ServerFrame {
  type: 'hello';
  protocolVersion: number;
  appVersion: string;
  adapters: { id: string; displayName: string }[];
  /** The runner was started with `--terminal` (off unless opted in); fixed for the process's life. */
  terminalEnabled?: boolean;
}

/**
 * The `/pty` socket's wire protocol: a separately-gated WebSocket carrying a raw
 * terminal stream, deliberately outside {@link ClientMsg}/{@link ServerMsg} so
 * keystrokes never enter the broadcast ring. Hand-validated in server.ts.
 */
export type PtyClientFrame =
  | { t: 'stdin'; d: string }
  | { t: 'resize'; cols: number; rows: number }
  /** Kill the session; a reload/close keeps it for re-attach. */
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

/**
 * One step of a multi-step flow run, as reported to the dashboard.
 *
 * Mirrors interceptor `FlowStepResult` without importing interceptor into core.
 * Bodies never travel here — only ids, status, and short detail strings.
 */
export interface FlowRunStepMsg {
  seq: number;
  role: string;
  operation?: string;
  method: string;
  path: string;
  status: string;
  captureId?: string;
  httpStatus?: number | null;
  detail?: string;
  durationMs?: number;
}

/** Successful multi-step flow run (or completed-with-soft-fails). */
export interface FlowResultMsg extends ServerFrame {
  type: 'flow.result';
  requestId: string;
  ok: boolean;
  templateId: string;
  primaryKey: string;
  flowId?: string;
  refreshed?: boolean;
  error?: string;
  steps: FlowRunStepMsg[];
}

/** Flow run refused or failed before producing a step list worth showing. */
export interface FlowErrorMsg extends ServerFrame {
  type: 'flow.error';
  requestId: string;
  error: string;
}

export interface SessionDiscoveredMsg extends ServerFrame {
  type: 'session.discovered';
  session: RedactedSession;
}

/** The replay rate budget, so the UI can show it draining before a refusal. */
export interface ReplayBudgetState {
  /** Replays available right now. */
  tokens: number;
  /** Replays per window. */
  capacity: number;
  /** How long the window is, in ms. */
  refillMs: number;
  /**
   * Ms until at least one token exists (0 when one does). A duration, not a
   * deadline: the page's clock is not the runner's.
   */
  retryAfterMs: number;
}

export interface StatusMsg extends ServerFrame {
  type: 'status';
  engines: EngineStatus[];
  /** Absent from older runners; the UI then hides the meter rather than showing zero. */
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
  /** Parameter names in declaration order (a zod shape does not survive JSON). */
  params: string[];
}

/** One replay action an app exposes, as the catalog describes it. */
export interface AppCatalogReplayAction {
  id: string;
  label: string;
  method: string;
  /** `kind` is a plain string, so a new ReplayParam kind is not a protocol change. */
  params: { name: string; kind: string; required?: boolean; label?: string; default?: string }[];
}

export interface AppCatalogEntry {
  id: string;
  displayName: string;
  /** an engine is actively capturing this app right now */
  capturing: boolean;
  build: AppBuildStatus;
  /** Hostnames the adapter claims — exactly what the proxy decrypts for this app. */
  hosts: string[];
  /** The app's full inventory, so the per-app page needs no second round trip. */
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

/** A chunk of recent captures sent when a client subscribes, oldest-first. */
export interface CaptureBackfillMsg extends ServerFrame {
  type: 'capture.backfill';
  captures: Capture[];
  /** True on the final chunk, so a client can show "primed" exactly once. */
  done: boolean;
  /**
   * `full`: everything recent from the store; `resume`: only what this client
   * missed. Stated because the frames look alike and a client must know whether
   * to replace its buffer or fold into it.
   */
  mode?: 'full' | 'resume';
}

/**
 * The lifecycle of ONE named, possibly long-running dashboard operation (sync,
 * prune, vacuum, rematerialize, engine start). Frames sharing a `requestId`
 * update one row instead of clobbering the single `notice` toast; broadcast, so
 * every dashboard on the runner sees it.
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
 * The machine's system-proxy state, broadcast on change and at subscribe. Kept
 * apart from `status` because these are facts about the OS (a proxy someone else
 * set, a CA not yet trusted), not the engine.
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
  | FlowErrorMsg
  | FlowResultMsg
  | SessionDiscoveredMsg
  | StatusMsg
  | AppsMsg
  | NoticeMsg
  | OpProgressMsg
  | EnvironmentMsg
  | CaptureStateMsg;

/** Whether the server is writing captures. Broadcast: pause is server state every dashboard must agree on. */
export interface CaptureStateMsg extends ServerFrame {
  type: 'capture.state';
  paused: boolean;
}

// ── Client → server ──────────────────────────────────────────────────────────

/** The client's half of the version handshake; the server answers a mismatch with a `notice`. */
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
   * Highest `seq` held (omit on a first connection). The server resumes from its
   * ring, or re-primes and says so (see {@link CaptureBackfillMsg.mode}).
   */
  sinceSeq?: number;
  /** Scopes captures only; runner-wide frames (status, notices, pause, catalog) always arrive. */
  filter?: SubscribeFilter;
}

export interface ReplayRunMsg {
  type: 'replay.run';
  requestId: string;
  actionId: string;
  params: Record<string, string>;
  /**
   * Which signed-in session to replay as (a `RedactedSession.id`). An unknown id
   * is refused, never replaced by another account's session. Omitted, the
   * runner uses the app's only session, or the one whose workspace the params
   * name; with several and no way to tell, the run is refused.
   */
  sessionId?: string;
}

/**
 * Run a learned multi-step flow template from the dashboard.
 *
 * Same rails as CLI `sluice replay --flow` and MCP `sluice_replay_flow`: each
 * step pays method/operation/budget independently. Params are the template's
 * `flowParams` (strings only), not adapter action params.
 */
export interface FlowRunMsg {
  type: 'flow.run';
  requestId: string;
  /** Flow template id from `listFlowTemplates` / Learn-flows. */
  templateId: string;
  params: Record<string, string>;
  /** As {@link ReplayRunMsg.sessionId}. */
  sessionId?: string;
}

/** Re-emit a container's entities. No `format`: on-disk formats live in `sluice export`. */
export interface ExportMsg {
  type: 'export';
  containerId?: string;
}

/** Reconstruct structure for every known session/workspace (the global Sync button). */
export interface SyncMsg {
  type: 'sync';
}

/**
 * Stop or resume WRITING captures (a privacy control): engines keep running, but
 * nothing reaches SQLite or the wire. Deliberately no `clear` — deleting captures
 * from a toolbar socket message would be a destructive action; `sluice wipe`/
 * `prune` are the deliberate ways.
 */
export interface CaptureControlMsg {
  type: 'capture.control';
  action: 'pause' | 'resume';
}

/**
 * Start or stop the capture engine (and proxy) itself, unlike `capture.control`.
 * Privileged — it decrypts traffic — so the server gates it more strictly.
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
  | FlowRunMsg
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
