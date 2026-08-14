// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The webapp's single connection to the runner and its only client-side store.
 *
 * - Connects to ws://127.0.0.1:7788/ws?token=<t> with auto-reconnect + backoff.
 * - Parses the `ServerMsg` stream from @sluice/core into a capped capture ring buffer.
 * - Exposes an immutable snapshot via `useSyncExternalStore`, rebuilt at most once
 *   per animation frame so a boot burst (100–400 calls) is one React commit.
 *
 * The dashboard reads: captures[], engines[], the per-app catalog, connection
 * state, and a transient `notice` toast. Structural entities
 * (workspaces/containers/items) and sessions are still streamed by the runner but
 * have no panel yet — their ServerMsg cases stay in the switch as explicit no-ops
 * so the exhaustiveness check keeps passing if the protocol grows.
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
  OpProgress,
  ReplayBudgetState,
  ServerMsg,
} from '@sluice/core';

export const DEFAULT_PORT = 7788;

/** Ring-buffer ceiling — the runner's SQLite store is the real source of truth. */
const CAP_CAPTURES = 8000;

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface AdapterInfo {
  id: string;
  displayName: string;
}

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
  protocolVersion: number;
  adapters: AdapterInfo[];
  /**
   * Whether this runner was started with `--terminal`. A static server
   * capability from `hello`; the dashboard shows the terminal affordance only
   * when true, and the `/pty` socket only opens when it is.
   */
  terminalEnabled: boolean;
  /** oldest → newest; the dashboard keeps its own frozen view for pause/scroll */
  captures: Capture[];
  engines: EngineStatus[];
  /** the per-app build/stats catalog the runner computes (drives the launcher) */
  apps: AppCatalogEntry[];
  /** most recent transient notice (sync progress / errors), or undefined */
  notice?: Notice;
  /**
   * Whether the RUNNER is writing captures. Server-owned: pausing stops the
   * engine writing to disk, not just this client rendering.
   */
  capturePaused: boolean;
  /**
   * The runner's replay rate budget, or undefined when it has not reported one.
   *
   * Undefined and "no tokens left" must not be the same value: a meter rendered
   * from a defaulted zero reads as exhausted, which is the one state that would
   * stop someone replaying when nothing is actually wrong.
   */
  replayBudget?: ReplayBudgetState;
  /** In-flight and finished replays this page started, newest first. */
  replays: ReplayRecord[];
  /**
   * Long-running operations (sync, prune, vacuum, …) the runner reported, newest
   * first. Keyed by requestId so successive frames UPDATE one row — the whole
   * reason this exists instead of the single `notice` slot, which clobbered a
   * per-action error loop down to its last message.
   */
  operations: OpProgress[];
  /**
   * The runner environment: system-proxy state + whether the CA exists. Absent
   * until the runner reports it (older runners never do), so the control page can
   * tell "not reported" from "proxy off".
   */
  environment?: EnvironmentState;
}

/**
 * One replay this page asked for, and what came back.
 *
 * Kept per request rather than as a single "last result", because
 * `withReplaySlot` serializes every replay in the RUNNER — including `sluice
 * sync` and the MCP tools — so a click can sit pending behind work this page
 * did not start. A list makes the queue visible; a single slot would look like
 * the button did nothing.
 */
/** The runner environment the control page renders — see the EnvironmentMsg frame. */
export interface EnvironmentState {
  systemProxy: { supported: boolean; enabled: boolean; host?: string; port?: number; ours: boolean; detail?: string };
  proxyPort?: number;
  caGenerated: boolean;
  caPath?: string;
}

export interface ReplayRecord {
  requestId: string;
  actionId: string;
  label: string;
  params: Record<string, string>;
  startedAt: number;
  state: 'pending' | 'ok' | 'error';
  /** Single-action vs multi-step flow (F7.3). */
  kind?: 'action' | 'flow';
  /** Set on 'ok' — the capture id, so the traffic table can be pointed at it. */
  captureId?: string;
  status?: number | null;
  /** Entities the response yielded, for the "what did this get me?" line. */
  entities?: number;
  /** Flow-only: parent interaction flow id when the runner persisted one. */
  flowId?: string;
  /** Flow-only: per-step log from `flow.result`. */
  flowSteps?: Array<{
    seq: number;
    role: string;
    operation?: string;
    method: string;
    path: string;
    status: string;
    captureId?: string;
    httpStatus?: number | null;
    detail?: string;
  }>;
  /** Set on 'error' — already redacted by the runner. */
  error?: string;
  finishedAt?: number;
}

// ── Working (mutable) state ────────────────────────────────────────────────────

let connection: ConnectionState = 'connecting';
let retries = 0;
let appVersion = '';
let protocolVersion = 0;
let adapters: AdapterInfo[] = [];
let terminalEnabled = false;

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
  const at = list.findIndex((o) => o.requestId === op.requestId);
  if (at === -1) return [op, ...list].slice(0, cap);
  const next = list.slice();
  next[at] = op;
  return next;
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
/**
 * Whether the RUNNER is writing captures. Server state, not a local toggle: two
 * dashboards on one runner must not disagree about whether traffic is being
 * recorded, and a client that connects while paused must render paused.
 */
let capturePaused = false;
let replayBudget: ReplayBudgetState | undefined;
let environment: EnvironmentState | undefined;
/** Newest first, capped — this is a session log, not a history. */
let replays: ReplayRecord[] = [];

/** How many replay records the page keeps. Enough to see a burst, not a ledger. */
const MAX_REPLAYS = 50;

/**
 * Fold a one-engine status frame into what is already known.
 *
 * The runner reports a TRANSITION as a single-element array, so replacing the
 * array wholesale meant the mitm engine's status erased the CDP engine's. With
 * one engine that is invisible; the supervisor makes it wrong.
 */
function mergeEngines(current: EngineStatus[], incoming: EngineStatus[]): EngineStatus[] {
  if (incoming.length === 0) return current;
  const byKind = new Map(current.map((e) => [e.engine, e]));
  for (const e of incoming) byKind.set(e.engine, e);
  return [...byKind.values()];
}

/** Resolve one pending replay. Unknown ids are dropped: another tab started it. */
function settleReplay(requestId: string, update: (r: ReplayRecord) => ReplayRecord): void {
  const at = replays.findIndex((r) => r.requestId === requestId);
  if (at === -1) return;
  const existing = replays[at];
  if (existing === undefined) return;
  const next = replays.slice();
  next[at] = { ...update(existing), finishedAt: Date.now() };
  replays = next;
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
    protocolVersion,
    adapters,
    terminalEnabled,
    captures: captureArr.slice(),
    engines,
    apps: appCatalog,
    notice,
    capturePaused,
    replayBudget,
    replays,
    operations,
    environment,
  };
}

const raf: (cb: () => void) => void =
  typeof requestAnimationFrame === 'function'
    ? (cb) => {
        requestAnimationFrame(() => cb());
      }
    : (cb) => {
        setTimeout(cb, 16);
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
  const set = new Set<string>();
  for (const c of captures) set.add(pick(c));
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ── Ingest ──────────────────────────────────────────────────────────────────────

/**
 * Drop every capture held in the client ring. Used after a successful wipe so
 * the dashboard cannot keep showing rows the server just deleted.
 */
export function clearCaptureRing(): void {
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

function handleMessage(msg: ServerMsg): void {
  // Broadcast frames carry seq; point-to-point answers do not. Track the high
  // water mark so a reconnect can resume instead of a full 2000-row backfill.
  if (typeof msg.seq === 'number' && Number.isFinite(msg.seq) && msg.seq > lastBroadcastSeq) {
    lastBroadcastSeq = msg.seq;
  }

  switch (msg.type) {
    case 'hello':
      appVersion = msg.appVersion;
      protocolVersion = msg.protocolVersion;
      adapters = msg.adapters;
      terminalEnabled = Boolean(msg.terminalEnabled);
      break;
    case 'capture.new':
      upsertCapture(msg.capture);
      break;
    case 'capture.backfill':
      // Priming batch sent on subscribe, oldest-first. One frame per capture
      // used to melt the socket on reload; these arrive in chunks instead.
      // Full prime (first connect or failed resume) replaces the previous era;
      // resume mode only folds deltas onto what we already hold.
      if (msg.mode === 'full' && expectFullPrimeReplace) {
        captureArr.length = 0;
        captureIndex.clear();
        expectFullPrimeReplace = false;
        // New era — do not keep a stale high-water mark from the previous ring.
        lastBroadcastSeq = 0;
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
      // Was a no-op, so a denied or failed replay was invisible: the safety
      // rails refuse a write with a reason, and the reason never reached anyone.
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
        flowSteps: msg.steps.map((s) => ({
          seq: s.seq,
          role: s.role,
          operation: s.operation,
          method: s.method,
          path: s.path,
          status: s.status,
          captureId: s.captureId,
          httpStatus: s.httpStatus,
          detail: s.detail,
        })),
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
      // MERGED by engine kind, not assigned. A transition frame carries one
      // engine (server.ts broadcastEngineStatus), so assigning the array made
      // the mitm engine's status erase the CDP engine's and vice versa —
      // invisible today with one engine, wrong the moment there are two.
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
    // No panel for these yet. Explicit no-op cases so the switch stays exhaustive
    // and the `never` guard below still compiles.
    case 'entity.upsert':
    case 'session.discovered':
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
 * strip the hash, ONCE. Both ride the same fragment, so consuming the read token
 * is the moment to also capture the pty token — otherwise the `history.replaceState`
 * that clears `k` would take `p` with it before anything read it.
 */
function consumeFragment(): void {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(hash);
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

function readToken(): string {
  // Served by the runner: the token is injected into the page as a global.
  const injected = (window as unknown as { __SLUICE_TOKEN__?: string }).__SLUICE_TOKEN__;
  if (injected) return injected;

  // Served by vite in dev: the runner prints http://localhost:5273/#k=<token>.
  // The fragment is never sent to a server, but it DOES persist in the address
  // bar, in history, and in any screenshot — so move it into sessionStorage and
  // strip the hash immediately, then read from there on later loads.
  consumeFragment();
  try {
    const stored = sessionStorage.getItem(KEY_STORAGE);
    if (stored) return stored;
  } catch {
    /* storage unavailable */
  }
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  return new URLSearchParams(hash).get('k') ?? new URLSearchParams(location.search).get('token') ?? '';
}

/**
 * The terminal capability secret, or '' when none was provided. Kept apart from
 * the read token so nothing but the `/pty` socket ever holds it.
 */
export function ptyToken(): string {
  consumeFragment();
  try {
    const stored = sessionStorage.getItem(PTY_KEY_STORAGE);
    if (stored) return stored;
  } catch {
    /* storage unavailable */
  }
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  return new URLSearchParams(hash).get('p') ?? '';
}

/** ws:// URL for the terminal channel, carrying the pty secret (not the read token). */
export function ptyWsUrl(): string {
  return `ws://127.0.0.1:${runnerPort()}/pty?token=${encodeURIComponent(ptyToken())}`;
}

/**
 * The runner injects the port it actually bound. Hardcoding 7788 meant any
 * `--port` produced a UI that could never connect. In dev (vite on :5273) the
 * global is absent, so fall back to the default the runner also defaults to.
 */
function runnerPort(): number {
  const injected = (window as unknown as { __SLUICE_PORT__?: number }).__SLUICE_PORT__;
  return typeof injected === 'number' && injected > 0 ? injected : DEFAULT_PORT;
}

/** The runner's HTTP origin — the base for the read-only API. */
export function runnerOrigin(): string {
  return `http://127.0.0.1:${runnerPort()}`;
}

/** The per-session bearer token, shared by the socket and the HTTP API. */
export function sessionToken(): string {
  return readToken();
}

function wsUrl(): string {
  const token = readToken();
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
export function send(msg: ClientMsg): void {
  const raw = JSON.stringify(msg);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(raw);
  } else {
    outbox.push(raw);
  }
}

/** The global Sync button: ask the runner to reconstruct structure for every session. */
/**
 * Ask the runner to stop or resume WRITING captures.
 *
 * Deliberately not optimistic — the local flag is not set here. The server
 * broadcasts `capture.state`, and rendering that instead of a guess is what
 * stops the UI claiming "paused" over a runner that is still recording, which is
 * exactly the bug this replaced.
 */
export function sendCaptureControl(action: 'pause' | 'resume'): void {
  send({ type: 'capture.control', action });
}

export function sendSync(): void {
  send({ type: 'sync' });
}

/** How a fresh requestId is minted for a control op the activity surface tracks. */
export function newRequestId(): string {
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

// ── Data management. Each returns the requestId so a caller can follow the op. ──

export function sendDataPrune(opts: { maxAgeDays?: number; maxRows?: number; vacuum?: boolean }): void {
  send({ type: 'data.prune', ...opts, requestId: newRequestId() });
}

export function sendDataDeleteCaptures(opts: { unattributed?: boolean; host?: string; vacuum?: boolean }): void {
  send({ type: 'data.deleteCaptures', ...opts, requestId: newRequestId() });
}

export function sendDataRematerialize(adapterId?: string): void {
  send({ type: 'data.rematerialize', adapterId, requestId: newRequestId() });
}

export function sendDataClearApp(adapterId: string, includeCaptures: boolean): void {
  send({ type: 'data.clearApp', adapterId, includeCaptures, requestId: newRequestId() });
}

export function sendDataVacuum(): void {
  send({ type: 'data.vacuum', requestId: newRequestId() });
}

/** `confirm` must be the literal 'wipe' — the server refuses anything else. */
export function sendDataWipe(confirm: string): void {
  send({ type: 'data.wipe', confirm, requestId: newRequestId() });
}

/**
 * Run one replay action, and record it as pending so the UI can show it.
 *
 * The record is written BEFORE the send, and the request id is minted here
 * rather than by the server, because the reply is correlated by it: a result
 * that arrived before its own record existed would be dropped by
 * `settleReplay`, which is a race the socket queue makes real (`send` buffers
 * while reconnecting, so the reply can be fast).
 *
 * `crypto.randomUUID` needs a secure context; the runner serves over plain HTTP
 * on 127.0.0.1, which browsers DO treat as secure — but the dev server on
 * `localhost` is the same story and a fallback costs one line, so this does not
 * depend on being right about that.
 */
export function sendReplayRun(
  actionId: string,
  label: string,
  params: Record<string, string>,
): string {
  const requestId = newRequestId();
  const record: ReplayRecord = {
    requestId,
    actionId,
    label,
    params,
    startedAt: Date.now(),
    state: 'pending',
    kind: 'action',
  };
  replays = [record, ...replays].slice(0, MAX_REPLAYS);
  touch();
  send({ type: 'replay.run', requestId, actionId, params });
  return requestId;
}

/**
 * Run a learned multi-step flow from the dashboard (F7.3).
 *
 * Same pending-before-send discipline as {@link sendReplayRun}: the reply is
 * correlated by `requestId`, so the worklist row must exist first.
 */
export function sendFlowRun(
  templateId: string,
  label: string,
  params: Record<string, string>,
): string {
  const requestId = newRequestId();
  const record: ReplayRecord = {
    requestId,
    actionId: templateId,
    label,
    params,
    startedAt: Date.now(),
    state: 'pending',
    kind: 'flow',
  };
  replays = [record, ...replays].slice(0, MAX_REPLAYS);
  touch();
  send({ type: 'flow.run', requestId, templateId, params });
  return requestId;
}
