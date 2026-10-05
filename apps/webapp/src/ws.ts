// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The webapp's single connection to the runner and its only client-side store.
 *
 * - Connects to ws://127.0.0.1:7788/ws?token=<t> with auto-reconnect + backoff.
 * - Parses the `ServerMsg` stream from @sluice/core into a capped capture ring buffer.
 * - Exposes an immutable snapshot via `useSyncExternalStore`, rebuilt at most once
 *   per animation frame so a boot burst (100–400 calls) is one React commit.
 *
 * The dashboard reads: captures[], engines[], the per-app catalog, the
 * (redacted) sessions a replay can act as, connection state, and a transient
 * `notice` toast. Workspaces/containers/items are read over HTTP by the Explore
 * page; their `entity.upsert` WS frame stays an explicit no-op so the
 * exhaustiveness check keeps compiling.
 *
 * Only Capture / RedactedSession ever cross this wire — never a secret — so nothing
 * here needs to redact; the runner already did before it streamed.
 */
import { useSyncExternalStore } from 'react';
import type {
  AppCatalogEntry,
  Capture,
  ClientMsg,
  EngineStatus,
  EnvironmentMsg,
  FlowRunStepMsg,
  OpProgress,
  RedactedSession,
  ReplayBudgetState,
  ServerMsg,
  WS_PROTOCOL_VERSION as CORE_WS_PROTOCOL_VERSION,
} from '@sluice/core';

const DEFAULT_PORT = 7788;

/**
 * The protocol version this page speaks, sent back in `hello.ok`. A copy rather
 * than an import because @sluice/core is type-only here (its entry pulls in the
 * SQLite store); the annotation makes typecheck fail if the two ever differ.
 */
const WS_PROTOCOL_VERSION: typeof CORE_WS_PROTOCOL_VERSION = 1;

/** Ring-buffer ceiling — the runner's SQLite store is the real source of truth. */
const CAP_CAPTURES = 8000;

export type ConnectionState = 'connecting' | 'open' | 'closed';

/** A transient toast. `id` is monotonic so the UI can react to "a new notice arrived". */
export interface Notice {
  id: number;
  level: 'info' | 'error';
  text: string;
}

/** The frozen, per-frame snapshot the dashboard reads. */
export interface StoreState {
  connection: ConnectionState;
  /** number of reconnect attempts since the last clean open (0 while healthy) */
  retries: number;
  appVersion: string;
  /** Static capability from `hello`: the terminal affordance shows, and `/pty`
   *  opens, only when true. */
  terminalEnabled: boolean;
  /** oldest → newest; the dashboard keeps its own frozen view for pause/scroll */
  captures: Capture[];
  engines: EngineStatus[];
  /** the per-app build/stats catalog the runner computes (drives the launcher) */
  apps: AppCatalogEntry[];
  /**
   * The sessions the runner could replay as — names and kinds only, never a
   * credential. Re-announced on every subscribe, so an app with several accounts
   * can make the user pick one instead of the runner guessing.
   */
  sessions: RedactedSession[];
  /** most recent transient notice (sync progress / errors), or undefined */
  notice?: Notice;
  /** Whether the RUNNER is writing captures. Server-owned, so every dashboard (even one connecting
   *  while paused) agrees, and pausing stops disk writes, not just rendering. */
  capturePaused: boolean;
  /** The runner's replay budget; undefined = not reported, which must not
   *  render as exhausted. */
  replayBudget?: ReplayBudgetState;
  /** In-flight and finished replays this page started, newest first. */
  replays: ReplayRecord[];
  /** Long-running operations (sync, prune, vacuum, …) the runner reported, newest
   *  first. Keyed by requestId so successive frames UPDATE one row. */
  operations: OpProgress[];
  /** System-proxy + CA state. Absent until reported, so "not reported" differs
   *  from "proxy off". */
  environment?: EnvironmentState;
}

/** The runner environment the control page renders: the EnvironmentMsg frame's payload. */
export type EnvironmentState = Omit<EnvironmentMsg, 'type' | 'seq'>;

/** One replay this page asked for, and what came back (see ReplayPage's Worklist for why it is a list). */
export interface ReplayRecord {
  requestId: string;
  actionId: string;
  label: string;
  params: Record<string, string>;
  startedAt: number;
  state: 'pending' | 'ok' | 'error';
  /** Single-action vs multi-step flow. */
  kind?: 'action' | 'flow';
  /** Set on 'ok' — the capture id, so the traffic table can be pointed at it. */
  captureId?: string;
  status?: number | null;
  /** Entities the response yielded, for the "what did this get me?" line. */
  entities?: number;
  /** Flow-only: parent interaction flow id when the runner persisted one. */
  flowId?: string;
  /** Flow-only: per-step log from `flow.result`. */
  flowSteps?: FlowRunStepMsg[];
  /** Set on 'error' — already redacted by the runner. */
  error?: string;
  finishedAt?: number;
}

// ── Working (mutable) state ────────────────────────────────────────────────────

let connection: ConnectionState = 'connecting';
let retries = 0;
let appVersion = '';
let terminalEnabled = false;
let sessions: RedactedSession[] = [];

const captureArr: Capture[] = [];
const captureIndex = new Map<string, number>();
let engines: EngineStatus[] = [];
let appCatalog: AppCatalogEntry[] = [];
/** Newest first, capped. Running + recently-finished operations. */
let operations: OpProgress[] = [];

/**
 * Highest broadcast `seq` this tab has applied. Sent as `subscribe.sinceSeq` on
 * reconnect so the runner can resume from its ring instead of re-priming 2000
 * rows. Cleared when a full backfill replaces the buffer (or on wipe).
 */
let lastBroadcastSeq = 0;
/**
 * When true, the next `capture.backfill` with `mode: 'full'` replaces the ring
 * before applying. Set on open; cleared after the first full-prime chunk so
 * multi-chunk primes fold rather than wipe mid-stream.
 */
let expectFullPrimeReplace = true;

/** How many operations the activity surface keeps. */
const MAX_OPERATIONS = 20;

/**
 * Fold one op-progress frame into a list, updating the row with its requestId
 * rather than appending — a running→running→ok sequence is ONE operation, not
 * three. A brand-new id is prepended; the list is capped newest-first.
 *
 * Pure and exported so it can be tested without the module's live socket state.
 */
export function foldOperations(list: OpProgress[], op: OpProgress, cap = MAX_OPERATIONS): OpProgress[] {
  if (!list.some((o) => o.requestId === op.requestId)) return [op, ...list].slice(0, cap);
  return list.map((o) => (o.requestId === op.requestId ? op : o));
}

function applyOp(op: OpProgress): void {
  operations = foldOperations(operations, op);
}

/**
 * Drop a finished operation from the activity surface. Running ops are left —
 * dismissing something still in flight would only hide it, not stop it.
 */
export function dismissOp(requestId: string): void {
  const target = operations.find((o) => o.requestId === requestId);
  if (target === undefined || target.state === 'running') return;
  operations = operations.filter((o) => o.requestId !== requestId);
  touch();
}
let notice: Notice | undefined;
let noticeSeq = 0;
let capturePaused = false;
let replayBudget: ReplayBudgetState | undefined;
let environment: EnvironmentState | undefined;
/** Newest first, capped — this is a session log, not a history. */
let replays: ReplayRecord[] = [];

/** How many replay records the page keeps. Enough to see a burst, not a ledger. */
const MAX_REPLAYS = 50;

/**
 * A status frame reports a TRANSITION as a one-engine array, so merge by engine
 * kind; replacing wholesale let one engine's status erase the other's.
 */
function mergeEngines(current: EngineStatus[], incoming: EngineStatus[]): EngineStatus[] {
  if (incoming.length === 0) return current;
  const byKind = new Map(current.map((e) => [e.engine, e]));
  for (const e of incoming) byKind.set(e.engine, e);
  return [...byKind.values()];
}

/** Resolve one pending replay. Unknown ids are dropped: another tab started it. */
function settleReplay(requestId: string, update: (r: ReplayRecord) => ReplayRecord): void {
  replays = replays.map((r) => (r.requestId === requestId ? { ...update(r), finishedAt: Date.now() } : r));
}

// ── Snapshot machinery (useSyncExternalStore) ──────────────────────────────────

const listeners = new Set<() => void>();
let snapshot: StoreState = build();
let dirty = false;
let scheduled = false;

function build(): StoreState {
  return {
    connection,
    retries,
    appVersion,
    terminalEnabled,
    captures: captureArr.slice(),
    engines,
    apps: appCatalog,
    sessions,
    notice,
    capturePaused,
    replayBudget,
    replays,
    operations,
    environment,
  };
}

const raf = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb);
  else setTimeout(cb, 16);
};

/** Mark state changed; coalesce the rebuild + notify into the next frame. */
function touch(): void {
  dirty = true;
  if (scheduled) return;
  scheduled = true;
  raf(flush);
}

function flush(): void {
  scheduled = false;
  if (!dirty) return;
  dirty = false;
  snapshot = build();
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureConnected();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): StoreState {
  return snapshot;
}

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Distinct, sorted values of some capture field — used to populate filter dropdowns. */
export function distinctValues(captures: Capture[], pick: (c: Capture) => string): string[] {
  return [...new Set(captures.map(pick))].sort((a, b) => a.localeCompare(b));
}

// ── Ingest ──────────────────────────────────────────────────────────────────────

/**
 * Drop every capture held in the client ring, after a wipe or a full prime, so
 * the dashboard cannot keep showing rows the server just deleted.
 */
function clearCaptureRing(): void {
  captureArr.length = 0;
  captureIndex.clear();
  lastBroadcastSeq = 0;
  touch();
}

function upsertCapture(c: Capture): void {
  const existing = captureIndex.get(c.id);
  if (existing !== undefined) {
    captureArr[existing] = c;
    return;
  }
  captureIndex.set(c.id, captureArr.length);
  captureArr.push(c);
  const over = captureArr.length - CAP_CAPTURES;
  if (over > 0) {
    captureArr.splice(0, over);
    captureIndex.clear();
    for (let i = 0; i < captureArr.length; i++) captureIndex.set(captureArr[i]!.id, i);
  }
}

/**
 * Fold one `session.discovered` frame into the list: replaced in place when its
 * id is already known (a resubscribe re-announces every session), else appended.
 */
export function foldSession(list: RedactedSession[], session: RedactedSession): RedactedSession[] {
  return list.some((s) => s.id === session.id) ? list.map((s) => (s.id === session.id ? session : s)) : [...list, session];
}

function handleMessage(msg: ServerMsg): void {
  // Broadcast frames carry seq; point-to-point answers do not. Track the high
  // water mark so a reconnect can resume instead of a full 2000-row backfill.
  if (typeof msg.seq === 'number' && Number.isFinite(msg.seq) && msg.seq > lastBroadcastSeq) {
    lastBroadcastSeq = msg.seq;
  }

  switch (msg.type) {
    case 'hello':
      appVersion = msg.appVersion;
      terminalEnabled = Boolean(msg.terminalEnabled);
      // Every connection starts with hello and re-announces its sessions on
      // subscribe, so start clean: one that signed out since must not linger.
      sessions = [];
      // The client's half of the version handshake; the runner answers a skew with a notice.
      send({ type: 'hello.ok', protocolVersion: WS_PROTOCOL_VERSION });
      break;
    case 'capture.new':
      upsertCapture(msg.capture);
      break;
    case 'capture.backfill':
      // Priming batch sent on subscribe, oldest-first, in chunks. Full prime
      // (first connect or failed resume) replaces the previous era; resume mode
      // only folds deltas onto what we already hold.
      if (msg.mode === 'full' && expectFullPrimeReplace) {
        clearCaptureRing();
        expectFullPrimeReplace = false;
      }
      for (const c of msg.captures) upsertCapture(c);
      break;
    case 'replay.result':
      // A replayed call is still traffic — show it (source: 'replay').
      upsertCapture(msg.capture);
      settleReplay(msg.requestId, (r) => ({
        ...r,
        state: 'ok',
        captureId: msg.capture.id,
        status: msg.capture.status,
        entities:
          (msg.parsed?.containers?.length ?? 0) +
          (msg.parsed?.actors?.length ?? 0) +
          (msg.parsed?.items?.length ?? 0),
      }));
      break;
    case 'replay.error':
      settleReplay(msg.requestId, (r) => ({ ...r, state: 'error', error: msg.error }));
      break;
    case 'flow.result':
      settleReplay(msg.requestId, (r) => ({
        ...r,
        kind: 'flow',
        state: msg.ok ? 'ok' : 'error',
        error: msg.ok ? undefined : (msg.error ?? 'flow failed'),
        flowId: msg.flowId,
        captureId: msg.steps.find((s) => s.captureId)?.captureId,
        flowSteps: msg.steps,
      }));
      break;
    case 'flow.error':
      settleReplay(msg.requestId, (r) => ({
        ...r,
        kind: 'flow',
        state: 'error',
        error: msg.error,
      }));
      break;
    case 'status':
      engines = mergeEngines(engines, msg.engines);
      if (msg.replayBudget !== undefined) replayBudget = msg.replayBudget;
      break;
    case 'notice':
      notice = { id: ++noticeSeq, level: msg.level, text: msg.text };
      break;
    case 'apps':
      appCatalog = msg.apps;
      break;
    case 'op.progress':
      applyOp(msg.op);
      // Wipe emptied the server; the client ring must empty too or deleted rows
      // stay visible until hard refresh.
      if (msg.op.kind === 'wipe' && msg.op.state === 'ok') {
        clearCaptureRing();
      }
      break;
    case 'capture.state':
      capturePaused = msg.paused;
      break;
    case 'environment':
      environment = {
        systemProxy: msg.systemProxy,
        proxyPort: msg.proxyPort,
        caGenerated: msg.caGenerated,
        caPath: msg.caPath,
      };
      break;
    case 'session.discovered':
      sessions = foldSession(sessions, msg.session);
      break;
    // Explore reads structure over HTTP. An explicit no-op case so the switch
    // stays exhaustive and the `never` guard below still compiles.
    case 'entity.upsert':
      break;
    default: {
      const _never: never = msg;
      void _never;
    }
  }
  touch();
}

// ── Connection ──────────────────────────────────────────────────────────────────

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
const outbox: string[] = [];

/** Where a fragment-delivered key is parked so it can leave the address bar. */
const KEY_STORAGE = 'sluice.sessionKey';
/** Same, for the SEPARATE terminal (`/pty`) capability secret. */
const PTY_KEY_STORAGE = 'sluice.ptyKey';

/**
 * Move the fragment secrets (`k`, and `p` when present) into sessionStorage and
 * strip the hash, ONCE. Both ride the same fragment, so consuming the session token
 * is the moment to also capture the pty token — otherwise the `history.replaceState`
 * that clears `k` would take `p` with it before anything read it.
 */
function consumeFragment(): void {
  const params = fragmentParams();
  const k = params.get('k');
  const p = params.get('p');
  if (!k && !p) return;
  try {
    if (k) sessionStorage.setItem(KEY_STORAGE, k);
    if (p) sessionStorage.setItem(PTY_KEY_STORAGE, p);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch {
    /* private mode / storage disabled — the getters fall back to reading the hash */
  }
}

/** The address-bar fragment as params (`location.hash` is '' or starts with '#'). */
function fragmentParams(): URLSearchParams {
  return new URLSearchParams(location.hash.slice(1));
}

/** A fragment-delivered secret: parked in sessionStorage, else still in the hash. */
function storedSecret(storageKey: string, param: 'k' | 'p'): string | null {
  consumeFragment();
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored) return stored;
  } catch {
    /* storage unavailable */
  }
  return fragmentParams().get(param);
}

/**
 * The per-session bearer token, shared by the socket and the HTTP API.
 *
 * The runner prints the dashboard URL with the token in the fragment
 * (`#k=<token>`). The fragment is never sent to a server, but it DOES persist in
 * the address bar, in history, and in any screenshot — so it is moved into
 * sessionStorage and the hash stripped immediately, then read from there on
 * later loads.
 */
export function sessionToken(): string {
  return storedSecret(KEY_STORAGE, 'k') ?? new URLSearchParams(location.search).get('token') ?? '';
}

/**
 * The terminal capability secret, or '' when none was provided. Kept apart from
 * the session token so nothing but the `/pty` socket ever holds it.
 */
function ptyToken(): string {
  return storedSecret(PTY_KEY_STORAGE, 'p') ?? '';
}

/** ws:// URL for the terminal channel, carrying the pty secret (not the session token). */
export function ptyWsUrl(): string {
  return `ws://127.0.0.1:${runnerPort()}/pty?token=${encodeURIComponent(ptyToken())}`;
}

/** The runner injects the port it bound; in dev (vite) the global is absent, so
 *  use the default. */
function runnerPort(): number {
  const injected = (window as unknown as { __SLUICE_PORT__?: number }).__SLUICE_PORT__;
  return typeof injected === 'number' && injected > 0 ? injected : DEFAULT_PORT;
}

/** The runner's HTTP origin — the base for the read-only API. */
export function runnerOrigin(): string {
  return `http://127.0.0.1:${runnerPort()}`;
}

function wsUrl(): string {
  const token = sessionToken();
  const path = (window as unknown as { __SLUICE_WS_PATH__?: string }).__SLUICE_WS_PATH__ ?? '/ws';
  return `ws://127.0.0.1:${runnerPort()}${path}?token=${encodeURIComponent(token)}`;
}

function setConnection(next: ConnectionState): void {
  if (connection !== next) {
    connection = next;
    touch();
  }
}

/** Idempotent: called on first subscriber; opens and keeps the socket alive. */
function ensureConnected(): void {
  if (started) return;
  started = true;
  connect();
}

function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setConnection('connecting');

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    retries = 0;
    setConnection('open');
    // Next full prime (if resume is refused) should replace, not stitch eras.
    expectFullPrimeReplace = true;
    const sub: ClientMsg =
      lastBroadcastSeq > 0
        ? { type: 'subscribe', sinceSeq: lastBroadcastSeq }
        : { type: 'subscribe' };
    send(sub);
    for (const raw of outbox.splice(0)) ws.send(raw);
  };

  ws.onmessage = (ev) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    if (parsed && typeof parsed === 'object' && 'type' in parsed) {
      handleMessage(parsed as ServerMsg);
    }
  };

  ws.onerror = () => {
    // A failed handshake fires error then close; let onclose drive reconnect.
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    setConnection('closed');
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(15000, 500 * 2 ** Math.min(retries, 5));
  const jitter = Math.floor(Math.random() * 250);
  retries += 1;
  touch();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay + jitter);
}

/** Send a ClientMsg; queues until the socket is open. */
function send(msg: ClientMsg): void {
  const raw = JSON.stringify(msg);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(raw);
  } else {
    outbox.push(raw);
  }
}

/** Ask the runner to stop or resume WRITING captures. Not optimistic: the UI
 *  renders the server's broadcast `capture.state` rather than a local guess. */
export function sendCaptureControl(action: 'pause' | 'resume'): void {
  send({ type: 'capture.control', action });
}

/**
 * What the Record/Pause button should ask for. Derived from what it SHOWS —
 * active only while this view records AND the runner writes — so a runner paused
 * from another tab or the CLI reads "Record" and a click resumes it, instead of
 * sending a second, no-op pause.
 */
export function captureToggleAction(recording: boolean, capturePaused: boolean): 'pause' | 'resume' {
  return recording && !capturePaused ? 'pause' : 'resume';
}

/** The global Sync button: ask the runner to reconstruct structure for every session. */
export function sendSync(): void {
  send({ type: 'sync' });
}

/** How a fresh requestId is minted (randomUUID, with a fallback outside secure contexts). */
function newRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `r${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Start or stop the capture engine. Progress arrives as an op.progress card. */
export function sendEngineControl(action: 'start' | 'stop'): void {
  send({ type: 'engine.control', action, requestId: newRequestId() });
}

/** Turn the system web proxy on or off. Progress arrives as an op.progress card. */
export function sendProxyControl(action: 'on' | 'off'): void {
  send({ type: 'proxy.control', action, requestId: newRequestId() });
}

// ── Data management. Each mints a requestId; progress arrives as op.progress. ──

export function sendDataDeleteCaptures(opts: { unattributed?: boolean; host?: string; vacuum?: boolean }): void {
  send({ type: 'data.deleteCaptures', ...opts, requestId: newRequestId() });
}

export function sendDataRematerialize(adapterId?: string): void {
  send({ type: 'data.rematerialize', adapterId, requestId: newRequestId() });
}

export function sendDataVacuum(): void {
  send({ type: 'data.vacuum', requestId: newRequestId() });
}

/** `confirm` must be the literal 'wipe' — the server refuses anything else. */
export function sendDataWipe(confirm: string): void {
  send({ type: 'data.wipe', confirm, requestId: newRequestId() });
}

/**
 * Run one replay action. The record is written, and the requestId minted, BEFORE
 * the send: replies are correlated by it and `settleReplay` drops unknown ids.
 * `sessionId` names the account so the runner never guesses.
 */
export function sendReplayRun(
  actionId: string,
  label: string,
  params: Record<string, string>,
  sessionId?: string,
): string {
  const requestId = recordPending('action', actionId, label, params);
  send({ type: 'replay.run', requestId, actionId, params, sessionId });
  return requestId;
}

/** Run a learned multi-step flow; same pending-before-send discipline as sendReplayRun. */
export function sendFlowRun(
  templateId: string,
  label: string,
  params: Record<string, string>,
  sessionId?: string,
): string {
  const requestId = recordPending('flow', templateId, label, params);
  send({ type: 'flow.run', requestId, templateId, params, sessionId });
  return requestId;
}

/** Mint a request id and record it as a pending worklist row, before anything is sent. */
function recordPending(
  kind: 'action' | 'flow',
  actionId: string,
  label: string,
  params: Record<string, string>,
): string {
  const requestId = newRequestId();
  const record: ReplayRecord = { requestId, actionId, label, params, startedAt: Date.now(), state: 'pending', kind };
  replays = [record, ...replays].slice(0, MAX_REPLAYS);
  touch();
  return requestId;
}
