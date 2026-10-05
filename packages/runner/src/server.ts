// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The loopback HTTP + WebSocket server that fronts the runner.
 *
 * Security posture (see §2.3 / §15.2 of the plans):
 *   - binds 127.0.0.1 only;
 *   - a random per-session bearer token gates `/api/*` and every WS upgrade. It
 *     is the SESSION token, not a read token: holding it is full dashboard
 *     control — reads, replay and flows against live accounts, sync, engine and
 *     system-proxy control, and every destructive `data.*` operation;
 *   - both also require a loopback `Host` (anti DNS-rebinding) and, when
 *     present, an `Origin` that is this runner's own (or the pinned dev UI's) —
 *     a browser always sends one, so no other website, and no other local port,
 *     can drive it;
 *   - every capture is re-run through the core redactors before it is persisted
 *     or streamed, so a secret cannot leave the capture path even by accident;
 *   - only a RedactedSession is ever streamed.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statfsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  redactedErrorMessage as errMsg,
  matchAdapter,
  newId,
  persistCapture,
  redactSession,
  workspaceOfParams,
  workspaceOfValues,
  WS_PROTOCOL_VERSION,
} from '@sluice/core';
import { parseClientFrame } from '@sluice/protocol';
import type {
  Adapter,
  App,
  AppCatalogEntry,
  AppCatalogMcpTool,
  AppCatalogReplayAction,
  Capture,
  EngineStatus,
  EnvironmentMsg,
  ExportMsg,
  FlowRunMsg,
  PtyClientFrame,
  PtyServerFrame,
  OpProgress,
  PersistResult,
  ReplayRunMsg,
  ServerMsg,
  Session,
  SqliteStore,
  SubscribeFilter,
  StatusMsg,
  SubscribeMsg,
} from '@sluice/core';
import type { TerminalHooks, TerminalSession } from './claude-terminal.js';
import { ReplayDeniedError, replayBudget, runFlowReplay } from '@sluice/interceptor';
import { listMaterializedTables, materializeIncremental, rebuildMaterialized } from '@sluice/cartographer';
import {
  anonymousSession,
  defaultParams,
  findReplayAction,
  flowReplayIo,
  pickSession,
  runReplayAction,
  structureActions,
} from './replay-actions.js';

/** Any capture engine, structurally — only its status() is consumed here. */
interface EngineLike {
  status(): EngineStatus;
}

/** One subscribed connection's per-connection state. */
interface Subscription {
  /** Undefined means unfiltered; an empty filter is normalized away to that. */
  filter?: SubscribeFilter;
}

import { APP_VERSION, LOOPBACK_HOST, webappDistDir } from './config.js';
import { handleApi, json, previewCapture } from './api.js';

/** Pull a bearer token out of an Authorization header, if present. */
function bearerFrom(header: string | undefined): string {
  if (!header) return '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1] ?? '';
}

/** How many recent captures a fresh subscriber is primed with. */
const BACKFILL_LIMIT = 2000;
/** Captures per backfill frame — one frame per capture melted the socket. */
const BACKFILL_CHUNK = 250;
/**
 * Broadcast frames held for resume. Modest because each `capture.new` frame pins
 * preview-capped bodies in memory; SQLite is the durable copy, and a client past
 * the end gets a full backfill. It covers a reload or reconnect, not replication.
 */
const RESUME_RING = 500;

export interface StartServerOpts {
  store: SqliteStore;
  /**
   * The installed apps. Typed as `App` (not `Adapter`) so the catalog can see
   * optional seams like `mcpTools()`; every caller already passes `App[]`.
   */
  adapters: App[];
  port: number;
  /** In-memory (SECRET) sessions, one per workspace; never streamed — only redactions. */
  getSessions: () => Session[];
  /** Optional live capture engine (MITM or CDP), purely for status reporting. */
  engine?: EngineLike;
  /**
   * Runtime control of the engine + system proxy, so the dashboard can start and
   * stop capture. Absent in modes that own the engine themselves (`sluice start`
   * historically) or have none (`sluice mock`). When present, `engine` should be
   * the SAME object (a controller satisfies both — it has `status()`), so the
   * catalog and status frames reflect what control changes.
   */
  control?: EngineControlHooks;
  /**
   * When present (`sluice serve --terminal`), exposes a second, separately-gated
   * WebSocket at `/pty` that runs one embedded Claude Code session. Absent by
   * default: no terminal, no `/pty`, no second secret. The hooks come from the
   * CLI so `server.ts` never imports node-pty, and the launcher's argv is fixed
   * and audited there (see claude-terminal.ts).
   */
  terminal?: TerminalHooks;
  /**
   * Enable the passive-capture ingest endpoint (`sluice serve --ingest`) — the
   * one authenticated POST the API accepts, for the MV3 browser extension
   * (Engine C). Off by default: accepting POSTed exchanges is a write surface, so
   * it exists only when the operator asks, and is gated by its OWN secret.
   */
  ingest?: boolean;
}

/** What the server needs to drive the engine/proxy on the dashboard's behalf. */
export interface EngineControlHooks {
  startEngine(): Promise<unknown>;
  stopEngine(): Promise<void>;
  proxyOn(): Promise<void>;
  proxyOff(): Promise<void>;
  environment(): Promise<EnvironmentMsg | Omit<EnvironmentMsg, 'type' | 'seq'>>;
}

export interface StartServerResult {
  url: string;
  token: string;
  /**
   * The `/pty` capability secret, or '' when the terminal is disabled. Distinct
   * from `token`; the CLI prints it in the URL fragment (`&p=`) only when the
   * terminal is on, so it discloses to nobody but the browser that opens the URL.
   */
  ptyToken: string;
  /**
   * The `/api/ingest` capability secret, or '' when ingest is disabled. Distinct
   * from every other token; printed by the CLI for the operator to paste into the
   * browser extension. It gates the one POST the API accepts.
   */
  ingestToken: string;
  close: () => Promise<void>;
  /**
   * Feed a freshly captured (already secret-redacted) exchange into the store +
   * live stream. This is a superset of the shared `{ url, token, close }`
   * contract; the CLI uses it to wire `MitmEngine` captures into the one ingest
   * funnel that replay also flows through.
   */
  ingest: (capture: Capture) => void;
  /**
   * Push an engine state change to every subscriber. Wire this to the engine's
   * `onStatus` hook so the UI sees transitions (notably an engine that stopped
   * on its own) instead of the state frozen at subscribe time.
   */
  broadcastEngineStatus: (s: EngineStatus) => void;
  /** Re-read and broadcast the runner environment (proxy + CA). Wire to the controller. */
  broadcastEnvironment: () => Promise<void>;
  /**
   * Send every dashboard these sessions (redacted), for a scan that finishes after
   * they subscribed — subscribe alone would leave their pickers empty.
   */
  announceSessions: (sessions: readonly Session[]) => void;
}

export async function startServer(opts: StartServerOpts): Promise<StartServerResult> {
  const { store, adapters, port, getSessions, engine, control, terminal } = opts;
  // The SESSION token gates `/api/*` and `/ws`, and every WS mutation rides it, so
  // a leak of it is full dashboard control. None of the three secrets is ever
  // embedded in the served page.
  const token = randomBytes(32).toString('hex');
  // Only with `--ingest`: gates the sole POST; the session token cannot substitute.
  const ingestToken = opts.ingest ? randomBytes(32).toString('hex') : '';
  // Only with the terminal: `/pty` checks it, so the session token cannot open a
  // shell. It rides the URL fragment as `&p=`.
  const ptyToken = terminal ? randomBytes(32).toString('hex') : '';

  /** Positive allowlist for caller-supplied adapter ids that reach DDL or deletes (AGENTS.md). */
  const installedIds = new Set(adapters.map((a) => a.id));
  function requireInstalled(id: string): string {
    if (!installedIds.has(id)) throw new Error(`Unknown app "${id}".`);
    return id;
  }

  /** Every subscribed connection and what it asked to be shown. */
  const subscribers = new Map<WebSocket, Subscription>();

  /** Monotonic broadcast counter; 0 means nothing has been broadcast yet. */
  let seq = 0;
  /**
   * The most recent {@link RESUME_RING} broadcast frames, oldest first, each
   * already carrying its `seq`. This is what a reconnect resumes from instead of
   * re-reading 2000 captures out of SQLite.
   */
  const ring: ServerMsg[] = [];

  /**
   * Whether live capture is being WRITTEN. Gated at the exported `ingest` — the
   * single entry point the capture engines use — rather than inside
   * `ingestCapture`, so pausing silences live traffic without also silencing
   * replay and sync, which are things the user explicitly asked for while paused.
   *
   * Server-side because a pause must actually stop writes: it is a privacy control.
   */
  let capturePaused = false;

  // ── one ingest funnel — live captures AND replay results flow through here ──

  /** The app a capture belongs to: its stated (installed) adapter, else whichever one claims it. */
  function adapterFor(c: Capture): App | undefined {
    return (c.adapterId ? adapters.find((a) => a.id === c.adapterId) : undefined) ?? matchAdapter(adapters, c);
  }

  /**
   * Persist one capture through the shared funnel (core persistCapture — redact,
   * attribute, classify, store, parse, seed), then stream it. Replay paths pass
   * the adapter they replayed for, so attribution never depends on matching.
   */
  function ingestCapture(raw: Capture, adapter: Adapter | undefined = adapterFor(raw)): PersistResult {
    const r = persistCapture(store, raw, adapter);
    if (r.parseError !== undefined) {
      console.error(`sluice: ${adapter?.id ?? '?'} parse failed on ${r.capture.id}: ${errMsg(r.parseError)}`);
    }
    const { capture, parsed } = r;
    // A preview: the frame (and the resume ring that holds it) never carries a
    // multi-MB body; the inspector fetches the whole one by id.
    broadcast({ type: 'capture.new', capture: previewCapture(capture) });
    if (parsed.workspaces?.length || parsed.actors?.length || parsed.containers?.length || parsed.items?.length) {
      broadcast({
        type: 'entity.upsert',
        workspaces: parsed.workspaces,
        actors: parsed.actors,
        containers: parsed.containers,
        items: parsed.items,
      });
    }
    scheduleBroadcastApps(); // keep the launcher's per-app stats live during capture
    scheduleMaterialize(); // dynamically (re)build the per-app DB as traffic flows
    return r;
  }

  // ── WS send helpers ─────────────────────────────────────────────────────────

  function send(ws: WebSocket, msg: ServerMsg | PtyServerFrame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(msg: ServerMsg): void {
    msg.seq = ++seq;
    ring.push(msg);
    if (ring.length > RESUME_RING) ring.splice(0, ring.length - RESUME_RING);
    fanOut(msg);
  }

  /**
   * One operation's progress, to every dashboard. `fanOut`, not `broadcast`:
   * transient op progress must not be replayed from the resume ring, so no `seq`.
   */
  function emitOp(op: OpProgress): void {
    fanOut({ type: 'op.progress', op });
  }

  /**
   * Write one frame to every subscriber it belongs to, with one lazy
   * `JSON.stringify` shared by all of them (bodies can be 5 MB). Valid because a
   * filter only DROPS frames and never rewrites them.
   */
  function fanOut(msg: ServerMsg): void {
    let payload: string | undefined;
    for (const [ws, sub] of subscribers) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (sub.filter && !frameMatchesFilter(msg, sub.filter)) continue;
      payload ??= JSON.stringify(msg);
      ws.send(payload);
    }
  }

  /** Seq floor after wipe/delete — clients with sinceSeq below this must full-backfill. */
  let resumeFloorSeq = 0;

  /**
   * Can this client resume from `sinceSeq`, or must it be re-primed from SQLite?
   *
   * Two ways the answer is no, and both must fall back to a full backfill: the
   * ring no longer reaches back that far, or the client names a seq this runner
   * never issued.
   *
   * A seq from a PREVIOUS runner cannot get here: a restart mints a new session
   * token, so the stale tab's socket fails the upgrade gate rather than resuming
   * against a counter that has been rewound.
   */
  function canResume(sinceSeq: unknown): sinceSeq is number {
    if (typeof sinceSeq !== 'number' || !Number.isInteger(sinceSeq) || sinceSeq < 0) return false;
    if (sinceSeq > seq) return false;
    // Post-wipe/delete: client held a pre-deletion watermark — force full backfill.
    if (sinceSeq < resumeFloorSeq) return false;
    const oldest = ring[0]?.seq;
    if (oldest === undefined) return sinceSeq === seq; // nothing broadcast yet
    return sinceSeq >= oldest - 1; // the next frame it needs is still held
  }

  /** Re-send, in order, the broadcast frames a resuming client missed. */
  function replayRing(ws: WebSocket, sub: Subscription, sinceSeq: number): void {
    for (const msg of ring) {
      if ((msg.seq ?? 0) <= sinceSeq) continue;
      if (sub.filter && !frameMatchesFilter(msg, sub.filter)) continue;
      send(ws, msg);
    }
  }

  // ── app catalog (the launcher) ────────────────────────────────────────────────

  const PLANNED_APPS: Array<{ id: string; displayName: string }> = [
    { id: 'linear', displayName: 'Linear' },
    { id: 'jira', displayName: 'Jira' },
    { id: 'discord', displayName: 'Discord' },
  ];

  function statsForAdapter(a: Adapter): AppCatalogEntry['stats'] {
    const root = (a.hosts[0] ?? '').split('.').slice(-2).join('.');
    const cap = store.db
      .prepare(
        `SELECT COUNT(*) AS c, COUNT(DISTINCT method || ' ' || path) AS e FROM captures WHERE host = ? OR host LIKE ?`,
      )
      .get(root, `%.${root}`) as { c: number; e: number };
    const count = (table: string): number =>
      (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE adapter_id = ?`).get(a.id) as { n: number }).n;
    return {
      captures: cap.c,
      endpoints: cap.e,
      workspaces: count('workspaces'),
      containers: count('containers'),
      actors: count('actors'),
      items: count('items'),
    };
  }

  /** True once the Cartographer has materialized per-app tables (e.g. <app>_channel). */
  function hasPerAppDb(adapterId: string): boolean {
    return listMaterializedTables(store, [adapterId]).length > 0;
  }

  /**
   * The MCP tools this app contributes, described for the catalog.
   *
   * Total, like `replayActionsFor` below: the catalog is recomputed on every
   * subscribe and after every capture burst, so one app throwing out of an
   * optional seam would blank the launcher for all of them.
   */
  function mcpToolsFor(a: App): AppCatalogMcpTool[] {
    try {
      return (a.mcpTools?.() ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        // `inputSchema` is a zod RAW SHAPE keyed by param name; reading keys off
        // the converted ZodObject would yield its own members instead.
        params: Object.keys(t.inputSchema ?? {}),
      }));
    } catch {
      return [];
    }
  }

  /** The replay actions this app exposes, described for the catalog. */
  function replayActionsFor(a: Adapter): AppCatalogReplayAction[] {
    try {
      return a.listReplayActions().map((r) => ({
        id: r.id,
        label: r.label,
        method: r.method,
        // Every field, not a subset: the UI builds its form from label and default too.
        params: r.params.map(({ name, kind, required, label, default: def }) => ({ name, kind, required, label, default: def })),
      }));
    } catch {
      return [];
    }
  }

  function computeCatalog(): AppCatalogEntry[] {
    const capturing = Boolean(engine && engine.status().state === 'running');
    const registered: AppCatalogEntry[] = adapters.map((a) => {
      const stats = statsForAdapter(a);
      const data = stats.captures > 0 || stats.containers > 0 || stats.items > 0;
      const mcpTools = mcpToolsFor(a);
      return {
        id: a.id,
        displayName: a.displayName,
        capturing,
        build: { adapter: true, data, db: hasPerAppDb(a.id), mcp: mcpTools.length > 0 },
        hosts: [...a.hosts],
        mcpTools,
        replayActions: replayActionsFor(a),
        stats,
      };
    });
    const registeredIds = new Set(adapters.map((a) => a.id));
    const planned: AppCatalogEntry[] = PLANNED_APPS.filter((p) => !registeredIds.has(p.id)).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capturing: false,
      build: { adapter: false, data: false, db: false, mcp: false },
      hosts: [],
      mcpTools: [],
      replayActions: [],
      stats: { captures: 0, endpoints: 0, workspaces: 0, containers: 0, actors: 0, items: 0 },
    }));
    return [...registered, ...planned];
  }

  function broadcastApps(): void {
    // computeCatalog costs ~6 SQLite queries per app (one an unindexed LIKE over
    // a table that grows forever), so it must never run speculatively: with no
    // subscriber there is nobody to receive it.
    if (subscribers.size === 0) return;
    broadcast({ type: 'apps', apps: computeCatalog() });
  }

  // Debounced so a capture burst produces one catalog refresh rather than one per request.
  let appsTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleBroadcastApps(): void {
    if (appsTimer || subscribers.size === 0) return;
    appsTimer = setTimeout(() => {
      appsTimer = undefined;
      broadcastApps();
    }, 1000);
  }

  // Debounced so the per-app tables rebuild after a capture burst settles, then the
  // catalog refreshes so "Local DB" stays live. Incremental via the watermark, which
  // the store holds, so a restart resumes rather than rescans; upserts are idempotent.
  let matTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleMaterialize(): void {
    if (matTimer) clearTimeout(matTimer);
    matTimer = setTimeout(() => {
      matTimer = undefined;
      try {
        materializeIncremental(store);
        broadcastApps();
      } catch (e) {
        // Materialize runs DDL driven by arbitrary response keys, so a throw is plausible: surface it.
        const text = `Per-app DB build failed: ${errMsg(e)}`;
        console.error(`sluice: ${text}`);
        broadcast({ type: 'notice', level: 'error', text });
      }
    }, 2000);
  }

  /**
   * Push an engine state change to every subscriber. Engines call this through
   * their `onStatus` hook; without it the UI learns the state once at subscribe
   * and then shows a dead engine as running indefinitely.
   */
  function broadcastEngineStatus(s: EngineStatus): void {
    broadcast(statusFrame([s]));
  }

  // ── client message handlers ─────────────────────────────────────────────────

  function onSubscribe(ws: WebSocket, msg: SubscribeMsg): void {
    const sub: Subscription = { filter: msg.filter };
    subscribers.set(ws, sub);
    send(ws, statusFrame());
    // Pause is server state, so a client that connects while paused must be told
    // — otherwise it renders "recording" over a runner that is writing nothing.
    send(ws, { type: 'capture.state', paused: capturePaused });
    // Prime the control page with the real OS state (proxy set? CA present?) so a
    // dashboard opened after a crash sees, e.g., a proxy pointing at a dead port.
    if (control) {
      void control
        .environment()
        .then((env) => send(ws, { type: 'environment', ...env }))
        .catch(() => {});
    }
    for (const s of getSessions()) send(ws, { type: 'session.discovered', session: redactSession(s) });
    // Prime the client's tree with the structure already reconstructed.
    const workspaces = store.listWorkspaces();
    const actors = store.listActors();
    const containers = store.listContainers();
    if (workspaces.length || actors.length || containers.length) {
      send(ws, { type: 'entity.upsert', workspaces, actors, containers });
    }
    if (canResume(msg.sinceSeq)) {
      // Announced BEFORE the missed frames, so the client knows the rows it
      // already holds still stand and these are deltas on top of them.
      send(ws, { type: 'capture.backfill', captures: [], done: true, mode: 'resume' });
      replayRing(ws, sub, msg.sinceSeq);
    } else {
      backfill(ws, sub.filter);
    }
    send(ws, { type: 'apps', apps: computeCatalog() });
  }

  /**
   * Prime a client with recent captures (oldest-first) so a page reload does not
   * wipe the recorder — a capture tool must survive a refresh. Sent in chunks.
   *
   * Every chunk says `mode: 'full'`, including the empty one. A client that asked
   * to resume and got this instead must replace its buffer rather than fold these
   * rows into it, and the two cases are indistinguishable from the frames alone.
   */
  function backfill(ws: WebSocket, filter: SubscribeFilter | undefined): void {
    const recent = store.listCaptures({
      limit: BACKFILL_LIMIT,
      adapterId: filter?.adapterId,
      tabId: filter?.tabId,
    });
    const oldestFirst = recent.reverse().map((c) => previewCapture(c));
    for (let i = 0; i < oldestFirst.length; i += BACKFILL_CHUNK) {
      const chunk = oldestFirst.slice(i, i + BACKFILL_CHUNK);
      send(ws, {
        type: 'capture.backfill',
        captures: chunk,
        done: i + BACKFILL_CHUNK >= oldestFirst.length,
        mode: 'full',
      });
    }
    if (oldestFirst.length === 0) {
      send(ws, { type: 'capture.backfill', captures: [], done: true, mode: 'full' });
    }
  }

  /**
   * The session a dashboard replay or flow acts as — never silently another
   * account. An explicit `sessionId` must exist; otherwise the workspace the
   * request's own params imply picks it; otherwise it has to be the app's only
   * session. Several sessions and nothing to choose between them is an error.
   */
  function sessionFor(app: App, sessionId: string | undefined, workspaceId: string | undefined): Session {
    const mine = getSessions().filter((s) => s.adapterId === app.id);
    // fast.com, OLX, Gmail: no provider, so no session to find — the same stand-in
    // the CLI and the MCP server use. A credential-free request carries nothing.
    if (mine.length === 0 && sessionId === undefined && !app.credentials) return anonymousSession(app.id);
    if (mine.length === 0 && sessionId === undefined) {
      throw new Error(`No active ${app.displayName} session — run \`sluice extract-token\` first.`);
    }
    const choice = pickSession(mine, { sessionId, workspaceId }, app.displayName);
    if (!choice.ok) throw new Error(choice.error);
    return choice.session;
  }

  /**
   * Engine state plus the replay budget — everything the header renders.
   *
   * `engines` is overridable so a single engine's transition can be reported
   * without re-polling the others. The client merges by engine kind rather than
   * assigning the array, so a one-element frame updates one engine instead of
   * erasing the rest.
   */
  function statusFrame(engines?: EngineStatus[]): StatusMsg {
    return {
      type: 'status',
      engines: engines ?? (engine ? [engine.status()] : []),
      replayBudget: replayBudget.snapshot(),
    };
  }

  async function onReplayRun(ws: WebSocket, msg: ReplayRunMsg): Promise<void> {
    try {
      const match = findReplayAction(adapters, msg.actionId);
      if (!match) throw new Error(`Unknown replay action "${msg.actionId}".`);
      // The action FIRST, then a session belonging to its adapter — a session
      // handed to another app's builder goes out as the wrong account (see
      // `onSync`), and so does one picked from the wrong workspace (sessionFor).
      const session = sessionFor(
        match.adapter,
        msg.sessionId,
        workspaceOfParams(store, match.action, msg.params),
      );
      // runReplayAction sends only through runReplay, which enforces the safety
      // rails (method / operation / host / rate budget) below this layer, so a
      // modified frontend cannot route around them.
      const result = await runReplayAction(store, match.adapter, match.action, msg.params ?? {}, session);
      const { capture, parsed } = ingestCapture(result, match.adapter);
      send(ws, { type: 'replay.result', requestId: msg.requestId, capture, parsed });
      // Broadcast rather than answer: the budget bucket is shared by every dashboard,
      // flow and sync in this process (sluice-mcp and each CLI invocation have their own).
      broadcast(statusFrame());
    } catch (e) {
      const code = e instanceof ReplayDeniedError ? `[${e.code}] ` : '';
      send(ws, {
        type: 'replay.error',
        requestId: msg.requestId,
        error: `${code}${errMsg(e)}`,
      });
      // A refusal spends nothing, but a denial for `rate_budget_exhausted` is
      // exactly when the meter matters most.
      broadcast(statusFrame());
    }
  }

  /**
   * Multi-step flow run from the dashboard, the same pipeline as `replay --flow`
   * and MCP: template → flowStepBuilder (host and read-action rails) →
   * runFlowReplay → per-step runReplay. No `refresh` hook: sessions here are in
   * memory, so a refresh could only restart as the same stale session or as
   * another workspace's.
   */
  async function onFlowRun(ws: WebSocket, msg: FlowRunMsg): Promise<void> {
    try {
      const tmpl = store.getFlowTemplate(msg.templateId);
      if (!tmpl) {
        throw new Error(
          `Unknown flow template "${msg.templateId}". Run \`sluice learn-flows\` or open Traffic → Group flows.`,
        );
      }
      const app = adapters.find((a) => a.id === tmpl.adapterId);
      if (!app) {
        throw new Error(`No installed app for adapter "${tmpl.adapterId}".`);
      }
      const params = msg.params ?? {};
      const session = sessionFor(app, msg.sessionId, workspaceOfValues(store, Object.values(params)));

      const result = await runFlowReplay({
        template: tmpl,
        params,
        session,
        // Same funnel as single replay: attribute, store, stream, materialize.
        io: flowReplayIo(tmpl, app, (c) => {
          ingestCapture(c, app);
        }),
      });

      if (result.flow) {
        try {
          store.upsertFlow(result.flow);
        } catch {
          /* parent flow persist is best-effort */
        }
      }

      send(ws, {
        type: 'flow.result',
        requestId: msg.requestId,
        ok: result.ok,
        templateId: tmpl.id,
        primaryKey: tmpl.primaryKey,
        flowId: result.flow?.id,
        refreshed: result.refreshed || undefined,
        // Already redacted: runFlowReplay's stepFailed scrubs every free text.
        error: result.error,
        steps: result.steps,
      });
      broadcast(statusFrame());
    } catch (e) {
      const code = e instanceof ReplayDeniedError ? `[${e.code}] ` : '';
      send(ws, {
        type: 'flow.error',
        requestId: msg.requestId,
        error: `${code}${errMsg(e)}`,
      });
      broadcast(statusFrame());
    }
  }

  function onExport(ws: WebSocket, msg: ExportMsg): void {
    // The frozen ServerMsg protocol has no dedicated export frame, so we honor
    // an export request by (re)emitting the requested entities as an
    // `entity.upsert` the client can fold in or serialize. The CLI `export`
    // command produces the on-disk JSON dump.
    if (msg.containerId) {
      const container = store.listContainers().find((c) => c.id === msg.containerId);
      const items = store.listItems(msg.containerId, { limit: 1_000_000 });
      const workspaces = container
        ? store.listWorkspaces().filter((w) => w.id === container.workspaceId)
        : [];
      const actors = container ? store.listActors(container.workspaceId) : [];
      send(ws, {
        type: 'entity.upsert',
        workspaces,
        actors,
        containers: container ? [container] : [],
        items,
      });
    } else {
      send(ws, {
        type: 'entity.upsert',
        workspaces: store.listWorkspaces(),
        actors: store.listActors(),
        containers: store.listContainers(),
      });
    }
  }

  // The global Sync button: replay each adapter's no-arg "structure" actions for
  // every session through the ingest funnel. Progress is BROADCAST as one keyed
  // op.progress, so every dashboard sees it, rather than a toast per failure.
  async function onSync(): Promise<void> {
    const requestId = randomBytes(8).toString('hex');
    const sessions = getSessions();
    if (sessions.length === 0) {
      emitOp({ requestId, kind: 'sync', state: 'error', detail: 'No sessions — extract or paste credentials first.' });
      return;
    }
    emitOp({ requestId, kind: 'sync', state: 'running', detail: `Syncing ${sessions.length} workspace(s)…` });
    let entities = 0;
    const failures: string[] = [];
    for (const session of sessions) {
      for (const adapter of adapters) {
        // Only ever hand a session to ITS OWN adapter. Without this a Trello
        // session reached Slack's request builder (emitting a literal
        // `Cookie: cookieHeader` header) and a Slack session reached Trello's
        // (firing unauthenticated).
        if (session.adapterId !== adapter.id) continue;
        for (const action of structureActions(adapter)) {
          try {
            const result = await runReplayAction(store, adapter, action, defaultParams(action), session);
            const { parsed } = ingestCapture(result, adapter);
            entities +=
              (parsed.containers?.length ?? 0) + (parsed.actors?.length ?? 0) + (parsed.items?.length ?? 0);
            emitOp({ requestId, kind: 'sync', state: 'running', detail: `${session.label} ${action.id}`, count: entities });
          } catch (e) {
            // One op's detail accumulates every failure; redacted (errMsg) because it is broadcast to every dashboard.
            failures.push(`${session.label} ${action.id}: ${errMsg(e)}`);
          }
        }
      }
    }
    emitOp({
      requestId,
      kind: 'sync',
      // A run that reconstructed something AND hit failures is still a success
      // with caveats; only a run that produced nothing is an error.
      state: entities === 0 && failures.length > 0 ? 'error' : 'ok',
      count: entities,
      detail:
        `Reconstructed ${entities} entities across ${sessions.length} workspace(s).` +
        (failures.length > 0 ? `\n${failures.length} action(s) failed:\n${failures.join('\n')}` : ''),
    });
  }

  /** Broadcast the runner environment (system-proxy + CA state) to every dashboard. */
  async function broadcastEnvironment(): Promise<void> {
    if (!control) return;
    try {
      broadcast({ type: 'environment', ...(await control.environment()) });
    } catch (e) {
      // Advisory; a failure to read the environment must not break control.
      broadcast({ type: 'notice', level: 'error', text: `environment read failed: ${errMsg(e)}` });
    }
  }

  /** Start or stop the capture engine, reporting progress as one keyed operation. */
  async function onEngineControl(action: 'start' | 'stop', requestId: string): Promise<void> {
    if (!control) {
      emitOp({ requestId, kind: `engine.${action}`, state: 'error', detail: 'This runner does not expose engine control.' });
      return;
    }
    emitOp({ requestId, kind: `engine.${action}`, state: 'running', detail: `${action === 'start' ? 'Starting' : 'Stopping'} capture…` });
    try {
      if (action === 'start') await control.startEngine();
      else await control.stopEngine();
      // The controller broadcasts status + environment itself; this is the op's
      // completion for the activity surface.
      emitOp({ requestId, kind: `engine.${action}`, state: 'ok', detail: `Capture ${action === 'start' ? 'started' : 'stopped'}.` });
    } catch (e) {
      emitOp({ requestId, kind: `engine.${action}`, state: 'error', detail: errMsg(e) });
    }
  }

  /** Turn the system proxy on/off, reporting progress. */
  async function onProxyControl(action: 'on' | 'off', requestId: string): Promise<void> {
    if (!control) {
      emitOp({ requestId, kind: `proxy.${action}`, state: 'error', detail: 'This runner does not expose proxy control.' });
      return;
    }
    emitOp({ requestId, kind: `proxy.${action}`, state: 'running', detail: `Turning the system proxy ${action}…` });
    try {
      if (action === 'on') await control.proxyOn();
      else await control.proxyOff();
      emitOp({ requestId, kind: `proxy.${action}`, state: 'ok', detail: `System proxy ${action}.` });
    } catch (e) {
      // setProxy on macOS can need admin rights and throws copyable sudo commands;
      // surfacing the message verbatim (redacted) is what makes it actionable.
      emitOp({ requestId, kind: `proxy.${action}`, state: 'error', detail: errMsg(e) });
    }
  }

  /**
   * Run one data-management operation as a keyed op, refreshing the catalog after
   * (counts changed). The handler returns its final detail/count; failures become
   * an error op rather than crashing the socket.
   */
  async function onData(
    requestId: string,
    kind: string,
    fn: () => Promise<{ count?: number; detail: string }>,
  ): Promise<void> {
    emitOp({ requestId, kind, state: 'running', detail: `${kind}…` });
    try {
      const { count, detail } = await fn();
      emitOp({ requestId, kind, state: 'ok', detail, count });
      scheduleBroadcastApps(); // stats moved; refresh the app catalog
    } catch (e) {
      emitOp({ requestId, kind, state: 'error', detail: errMsg(e) });
    }
  }

  /** Drop + fully rebuild the derived tables for the given adapters (see rebuildMaterialized). */
  function rebuildDerived(adapterIds: readonly string[]): number {
    // Clear the debounce so a pending incremental pass cannot race in with the
    // watermark the rebuild is about to reset.
    clearTimeout(matTimer);
    return rebuildMaterialized(store, adapterIds).length;
  }

  /** Called after any capture delete: reconcile derived tables + drop zombie flows. */
  function afterCaptureDelete(): void {
    // Flows/templates whose captures vanished — prune/delete already GCs orphans
    // inside the store; this is the belt for adapter-scoped clear paths.
    store.gcOrphanFlows();
    rebuildDerived(adapters.map((a) => a.id));
    invalidateRing();
  }

  /**
   * VACUUM with a free-disk pre-check, and a "server pauses" heads-up.
   *
   * better-sqlite3 is synchronous on one connection, so VACUUM rewrites the whole
   * file on the event loop — every socket and API read blocks until it finishes.
   * It also needs free space roughly equal to the DB size and throws SQLITE_FULL
   * otherwise, which would crash the runner if uncaught. Both are handled here.
   */
  async function vacuumGuarded(): Promise<void> {
    const dbPath = store.db.name;
    let free: number | undefined;
    let dbBytes = 0;
    try {
      dbBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
      const fs = statfsSync(dbPath);
      free = fs.bavail * fs.bsize;
    } catch {
      // ':memory:', or a filesystem that cannot report free space — skip the
      // pre-check rather than block the VACUUM.
    }
    if (free !== undefined && free < dbBytes) {
      throw new Error(
        `VACUUM needs ~${Math.ceil(dbBytes / 1e6)} MB free but only ${Math.floor(free / 1e6)} MB is available.`,
      );
    }
    broadcast({ type: 'notice', level: 'info', text: 'Reclaiming space — the server pauses briefly.' });
    store.vacuum();
  }

  /**
   * Invalidate the resume ring after a wipe. Without this, a tab that reconnects
   * post-wipe passes `canResume` and `replayRing` re-sends pre-wipe `capture.new`
   * frames — the deleted rows reappear until a hard refresh.
   */
  function invalidateRing(): void {
    ring.length = 0;
    // Anything issued before this moment is untrusted for resume. seq itself is
    // monotonic for the process, so the next broadcast will be > resumeFloorSeq.
    resumeFloorSeq = seq;
  }

  // ── passive-capture ingest (Engine C / MV3 extension) ────────────────────────

  /** Total request-body bytes accepted per ingest POST. A batch of a few 5 MB captures. */
  const INGEST_MAX_BYTES = 32 * 1024 * 1024;
  /** Captures accepted per POST, so one call cannot flood the store. */
  const INGEST_MAX_BATCH = 500;

  async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > limit) throw new Error('payload too large');
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  /**
   * `POST /api/ingest` — accept a batch of browser-observed exchanges from the
   * extension and run them through the SAME ingest funnel as the proxy (redact,
   * attribute, parse, store, stream). Gated by the ingest secret and a loopback
   * Host; NO loopback-Origin requirement, because the poster is a browser
   * extension (a `chrome-extension://` origin, and its `host_permissions` let it
   * reach loopback without CORS) authenticated by the secret rather than by being
   * same-origin. Honours the pause switch, exactly like live capture.
   */
  async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => json(res, status, body);
    if (!ingestToken) return reply(404, { error: 'ingest_disabled', detail: 'Start with --ingest.' });
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const supplied =
      bearerFrom(req.headers.authorization) ||
      (typeof req.headers['x-sluice-ingest'] === 'string' ? req.headers['x-sluice-ingest'] : '');
    if (!isLoopbackHost(req.headers.host, port) || !safeEqual(supplied, ingestToken)) {
      return reply(403, { error: 'forbidden' });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req, INGEST_MAX_BYTES)).toString('utf8'));
    } catch (e) {
      return reply(413, { error: 'bad_body', detail: errMsg(e) });
    }
    const list = Array.isArray((parsed as { captures?: unknown })?.captures)
      ? ((parsed as { captures: unknown[] }).captures)
      : [];
    if (list.length > INGEST_MAX_BATCH) {
      return reply(413, { error: 'batch_too_large', detail: `max ${INGEST_MAX_BATCH} per POST` });
    }
    if (capturePaused) return reply(200, { ingested: 0, paused: true });
    let ingested = 0;
    for (const raw of list) {
      const capture = toExtCapture(raw);
      if (!capture) continue;
      try {
        ingestCapture(capture); // redacts + attributes + parses + streams, same as the proxy
        ingested += 1;
      } catch {
        // A single malformed row must not drop the rest of the batch.
      }
    }
    reply(200, { ingested });
  }

  // ── HTTP server (static webapp + token injection) ────────────────────────────

  const httpServer = createServer((req, res) => handleHttp(req, res));

  /**
   * A strict CSP is the one "nothing leaves this machine" claim a sceptical
   * reader can verify in about thirty seconds: no external origin is reachable
   * for scripts, styles, images, fonts, or sockets. `'unsafe-inline'` is present
   * only because the runner injects the session token as an inline <script> and
   * the built webapp ships inline styles; everything else is locked to 'self'.
   */
  const CSP = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ws://${LOOPBACK_HOST}:* http://${LOOPBACK_HOST}:*`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // Nothing a request carries may take the runner down: a crash here strands a
    // system proxy pointed at a port nothing listens on.
    try {
      routeHttp(req, res);
    } catch {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  }

  function routeHttp(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    const url = parseReqUrl(req);
    if (!url) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }
    if (url.pathname === '/ws') {
      res.statusCode = 426;
      res.end('Upgrade Required');
      return;
    }

    // The one authenticated POST: passive-capture ingest (Engine C). Handled
    // BEFORE the GET-only `/api/*` gate below, and on its OWN secret — so the
    // HTTP API stays read-only and the session token cannot post captures.
    if (url.pathname === '/api/ingest') {
      void handleIngest(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // The API reads the whole capture store, so it carries exactly the same
      // gate as the WebSocket upgrade: loopback Host (anti DNS-rebinding), our
      // own Origin when the caller sent one, and the per-session token.
      // Static assets stay unauthenticated; they hold no secret (the token is never injected, see injectConfig).
      const okHost = isLoopbackHost(req.headers.host, port);
      const okOrigin = isOwnOrigin(req.headers.origin, port);
      const supplied = url.searchParams.get('token') ?? bearerFrom(req.headers.authorization);
      if (!okHost || !okOrigin || !safeEqual(supplied, token)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'forbidden' }));
        return;
      }
      const took = handleApi(req, res, url, {
        store,
        adapters: adapters.map((a) => ({ id: a.id, displayName: a.displayName })),
        engineStatus: () => (engine ? engine.status() : null),
        appVersion: APP_VERSION,
      });
      if (took) return;
    }

    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }
    serveStatic(url.pathname, res);
  }

  function injectConfig(html: string): string {
    // Only the NON-SECRET port and WS path. The static document is served WITHOUT
    // auth, so an injected token could be read by any local process with curl. The
    // token travels in the URL fragment (`/#k=`, never sent to the server); the
    // client moves it to sessionStorage and strips it (the webapp's readToken). The
    // port is injected so `--port` works.
    const tag =
      `<script>window.__SLUICE_WS_PATH__=${JSON.stringify('/ws')};` +
      `window.__SLUICE_PORT__=${JSON.stringify(port)};</script>`;
    return html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
  }

  function serveIndexHtml(file: string, res: ServerResponse): void {
    const html = injectConfig(readFileSync(file, 'utf8'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
  }

  function serveStatic(pathname: string, res: ServerResponse): void {
    const root = webappDistDir().replace(/[\\/]+$/, '');
    const indexFile = join(root, 'index.html');
    if (!existsSync(indexFile)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(injectConfig(placeholderHtml(port)));
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      rel = pathname;
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = normalize(join(root, rel));
    // Path-traversal guard: the resolved file must stay inside the dist root.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      serveIndexHtml(indexFile, res); // SPA fallback
      return;
    }
    if (filePath === indexFile) {
      serveIndexHtml(filePath, res);
      return;
    }
    res.setHeader('Content-Type', contentType(filePath));
    res.end(readFileSync(filePath));
  }

  // ── WS server (loopback + token gated) ───────────────────────────────────────

  const wss = new WebSocketServer({ noServer: true });

  // ── /pty terminal channel (opt-in, second secret) ────────────────────────────
  //
  // A separate socket server so its traffic never touches the capture broadcast
  // path. The session is PERSISTENT: the claude child outlives a dropped socket,
  // so a page reload / navigation / network blip RE-ATTACHES to the same running
  // session instead of losing it. What ties the two together is a rolling buffer
  // of recent output — a fresh tab's xterm starts blank, so on re-attach we replay
  // the buffer and it shows the current screen. The child dies only on an explicit
  // `end`, on claude exiting, or on server shutdown; one viewer at a time (a new
  // connection takes over the VIEW, not the process).
  const ptyWss = terminal ? new WebSocketServer({ noServer: true }) : null;
  let ptySession: TerminalSession | null = null;
  let ptyWs: WebSocket | null = null;
  /** Rolling window of recent PTY output, replayed to a re-attaching tab. */
  const ptyBuffer: string[] = [];
  let ptyBufferBytes = 0;
  const PTY_BUFFER_MAX = 256 * 1024;

  /** Buffer output (for re-attach) and forward it to whichever tab is attached now. */
  function ptyOnData(d: string): void {
    ptyBuffer.push(d);
    ptyBufferBytes += d.length;
    while (ptyBufferBytes > PTY_BUFFER_MAX && ptyBuffer.length > 1) {
      ptyBufferBytes -= (ptyBuffer.shift() ?? '').length;
    }
    if (ptyWs) send(ptyWs, { t: 'data', d });
  }

  function killPtySession(): void {
    if (ptySession) {
      ptySession.kill();
      ptySession = null;
    }
    ptyBuffer.length = 0;
    ptyBufferBytes = 0;
  }

  if (terminal && ptyWss) {
    const term = terminal;
    ptyWss.on('connection', (ws: WebSocket) => {
      // Take over the VIEW from a previous tab, but keep the child running.
      if (ptyWs && ptyWs !== ws) {
        try {
          ptyWs.close();
        } catch {
          /* already closing */
        }
      }
      ptyWs = ws;
      ws.on('error', () => {
        /* a dropped local terminal tab is not fatal */
      });

      // Spawn only if there is no live session to re-attach to.
      if (!ptySession) {
        try {
          const session = term.spawn({ cols: 80, rows: 24 });
          ptySession = session;
          session.onData(ptyOnData);
          session.onExit((code) => {
            if (ptyWs) send(ptyWs, { t: 'exit', code });
            if (ptySession === session) killPtySession();
          });
        } catch (e) {
          send(ws, { t: 'error', message: errMsg(e) });
          ws.close();
          return;
        }
      }

      send(ws, { t: 'ready' });
      // Replay recent output so a reloaded tab shows the session as it stands.
      if (ptyBuffer.length > 0) send(ws, { t: 'data', d: ptyBuffer.join('') });

      ws.on('message', (data: RawData) => {
        const frame = parsePtyFrame(toText(data));
        if (!frame) return; // a raw byte channel — drop noise silently
        if (frame.t === 'stdin') ptySession?.write(frame.d);
        else if (frame.t === 'resize') ptySession?.resize(frame.cols, frame.rows);
        else if (frame.t === 'end') killPtySession(); // the ONLY client-driven teardown
      });

      // On disconnect, detach the view but KEEP the child alive — that is the
      // whole point: a reload must not lose the session. It is reclaimed on an
      // explicit `end`, on claude exiting, or on server shutdown.
      ws.on('close', () => {
        if (ptyWs === ws) ptyWs = null;
      });
    });
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      routeUpgrade(req, socket, head);
    } catch {
      socket.destroy(); // a malformed handshake must not become an uncaught throw
    }
  });

  function routeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = parseReqUrl(req);
    if (!url) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const okHost = isLoopbackHost(req.headers.host, port);

    if (url.pathname === '/pty') {
      // Stricter than /ws by design. `/ws` tolerates a missing Origin so non-browser
      // clients (tests, CLIs) can connect on the bearer token alone; nothing but the
      // dashboard should ever speak `/pty`, so an absent Origin FAILS CLOSED here.
      // And it is gated by the SEPARATE pty secret, so the session token cannot open it.
      const okOrigin = Boolean(req.headers.origin) && isOwnOrigin(req.headers.origin, port);
      const okPtyToken = ptyToken !== '' && safeEqual(url.searchParams.get('token') ?? '', ptyToken);
      if (!ptyWss || !okHost || !okOrigin || !okPtyToken) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      ptyWss.handleUpgrade(req, socket, head, (ws) => ptyWss.emit('connection', ws));
      return;
    }

    const okPath = url.pathname === '/ws';
    const okOrigin = isOwnOrigin(req.headers.origin, port);
    const okToken = safeEqual(url.searchParams.get('token') ?? '', token);
    if (!okPath || !okHost || !okOrigin || !okToken) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  }

  wss.on('connection', (ws: WebSocket) => {
    ws.on('error', () => {
      /* swallow — a dropped local tab is not an error worth crashing on */
    });
    send(ws, {
      type: 'hello',
      protocolVersion: WS_PROTOCOL_VERSION,
      appVersion: APP_VERSION,
      adapters: adapters.map((a) => ({ id: a.id, displayName: a.displayName })),
      terminalEnabled: Boolean(terminal),
    });
    ws.on('message', (data: RawData) => {
      // Validated at the trust boundary (@sluice/protocol), not merely narrowed.
      const frame = parseClientFrame(toText(data));
      if (!frame.ok) {
        // Reported as a notice rather than silently dropped.
        send(ws, { type: 'notice', level: 'error', text: `Ignored a malformed message — ${frame.reason}.` });
        return;
      }
      const parsed = frame.msg;
      switch (parsed.type) {
        case 'hello.ok':
          // The other half of the version handshake: name a protocol skew, because
          // otherwise both ends keep talking with fields silently missing.
          if (parsed.protocolVersion !== WS_PROTOCOL_VERSION) {
            send(ws, {
              type: 'notice',
              level: 'error',
              text:
                `Protocol mismatch: this runner speaks v${WS_PROTOCOL_VERSION}, ` +
                `the page speaks v${String(parsed.protocolVersion)}. Reload; if that does not ` +
                `fix it, the built webapp is from a different Sluice than the runner.`,
            });
          }
          break;
        case 'subscribe':
          onSubscribe(ws, parsed);
          break;
        case 'replay.run':
          void onReplayRun(ws, parsed);
          break;
        case 'flow.run':
          void onFlowRun(ws, parsed);
          break;
        case 'export':
          onExport(ws, parsed);
          break;
        case 'capture.control': {
          const next = parsed.action === 'pause';
          if (next !== capturePaused) {
            capturePaused = next;
            // Broadcast, not acknowledged: two dashboards on one runner must not
            // disagree about whether traffic is being recorded.
            broadcast({ type: 'capture.state', paused: capturePaused });
            broadcast({
              type: 'notice',
              level: 'info',
              text: capturePaused
                ? 'Capture paused — the proxy keeps running, but nothing is being written.'
                : 'Capture resumed.',
            });
          }
          break;
        }
        case 'sync':
          void onSync();
          break;
        case 'engine.control':
          void onEngineControl(parsed.action, parsed.requestId);
          break;
        case 'proxy.control':
          void onProxyControl(parsed.action, parsed.requestId);
          break;
        case 'data.prune':
          void onData(parsed.requestId, 'prune', async () => {
            const removed = store.pruneCaptures({
              maxAgeMs: parsed.maxAgeDays ? parsed.maxAgeDays * 86_400_000 : undefined,
              maxRows: parsed.maxRows,
            });
            afterCaptureDelete();
            if (parsed.vacuum) await vacuumGuarded();
            return { count: removed, detail: `Pruned ${removed} capture(s).` };
          });
          break;
        case 'data.deleteCaptures':
          void onData(parsed.requestId, 'delete', async () => {
            const removed = store.deleteCaptures({
              unattributed: parsed.unattributed,
              host: parsed.host,
            });
            afterCaptureDelete();
            if (parsed.vacuum) await vacuumGuarded();
            return { count: removed, detail: `Deleted ${removed} capture(s).` };
          });
          break;
        case 'data.rematerialize':
          void onData(parsed.requestId, 'rematerialize', async () => {
            // A caller-supplied id becomes a DROP TABLE prefix, so only an installed app's id is accepted.
            const ids = parsed.adapterId ? [requireInstalled(parsed.adapterId)] : [...installedIds];
            const rebuilt = rebuildDerived(ids);
            return { detail: `Rebuilt ${rebuilt} table(s).` };
          });
          break;
        case 'data.clearApp':
          void onData(parsed.requestId, 'clearApp', async () => {
            // Validated before ANY delete, not just before the drop.
            const app = requireInstalled(parsed.adapterId);
            let removed = 0;
            for (const w of store.listWorkspaces().filter((x) => x.adapterId === app)) {
              store.deleteWorkspace(w.id);
            }
            // Derived flow rows must not outlive the app that owns them.
            store.deleteFlows({ adapterId: app });
            store.deleteFlowTemplates({ adapterId: app });
            if (parsed.includeCaptures) {
              removed = store.deleteCaptures({ adapterId: app });
              afterCaptureDelete();
            } else {
              rebuildDerived([app]);
            }
            return {
              detail: `Cleared ${app}${parsed.includeCaptures ? ` and ${removed} capture(s)` : ' (derived only)'}.`,
            };
          });
          break;
        case 'data.vacuum':
          void onData(parsed.requestId, 'vacuum', async () => {
            await vacuumGuarded();
            return { detail: 'Reclaimed free space.' };
          });
          break;
        case 'data.wipe':
          void onData(parsed.requestId, 'wipe', async () => {
            if (parsed.confirm !== 'wipe') throw new Error('Wipe not confirmed.');
            const { captures } = store.wipe();
            // wipe() leaves meta alone; the rebuild drops the tables and resets
            // the watermark, and over an empty store derives nothing.
            rebuildDerived(adapters.map((a) => a.id));
            invalidateRing();
            await vacuumGuarded();
            return { count: captures, detail: `Wiped ${captures} capture(s) and all derived data.` };
          });
          break;
      }
    });
    ws.on('close', () => {
      subscribers.delete(ws);
    });
  });

  // ── boot ─────────────────────────────────────────────────────────────────────

  await new Promise<void>((resolve, reject) => {
    const onError = (e: unknown): void => reject(e);
    httpServer.once('error', onError);
    httpServer.listen(port, LOOPBACK_HOST, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  async function close(): Promise<void> {
    clearTimeout(appsTimer);
    appsTimer = undefined;
    clearTimeout(matTimer);
    // Take the terminal down first so its child dies with the server, not orphaned.
    // This is where the persistent session is reclaimed — the runner exiting is
    // its lifetime bound, not a dropped socket.
    killPtySession();
    if (ptyWs) ptyWs.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (ptyWss) await new Promise<void>((resolve) => ptyWss.close(() => resolve()));
    (httpServer as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  return {
    url: `http://${LOOPBACK_HOST}:${port}/`,
    token,
    ptyToken,
    ingestToken,
    close,
    ingest: (capture: Capture) => {
      if (capturePaused) return;
      ingestCapture(capture);
    },
    broadcastEngineStatus,
    broadcastEnvironment,
    announceSessions: (list) => {
      for (const s of list) broadcast({ type: 'session.discovered', session: redactSession(s) });
    },
  };
}

// ── pure helpers ───────────────────────────────────────────────────────────────

/**
 * Does this frame belong on a connection that scoped itself to one app or tab?
 *
 * Captures only. Engine status, notices, the pause state and the app catalog
 * describe the RUNNER, not one app — a client that stopped receiving them
 * because it narrowed to Gmail would quietly render stale state instead.
 */
function frameMatchesFilter(msg: ServerMsg, f: SubscribeFilter): boolean {
  if (msg.type !== 'capture.new') return true;
  if (f.adapterId !== undefined && msg.capture.adapterId !== f.adapterId) return false;
  if (f.tabId !== undefined && msg.capture.tabId !== f.tabId) return false;
  return true;
}

/**
 * Validate + normalize one exchange POSTed to `/api/ingest` into a Capture.
 *
 * Untrusted input — page script can post through the extension bridge — so the
 * poster decides as little as possible:
 *   - the id is always minted here: `insertCapture` upserts on id, so a
 *     caller-chosen id could overwrite any row it names;
 *   - host and path come only from the (absolute, http/https) URL, never from
 *     separate `host`/`path` fields, so a post cannot claim `slack.com` for a URL
 *     on another host. Path is the pathname, as every engine records it;
 *   - a timestamp from the future is clamped to now;
 *   - tab fields are not accepted: the extension never sends them.
 * It keeps only string header values and stamps `source: 'ext'`. It does NOT
 * redact — the ingest funnel's `redactCapture` does that for every path,
 * URL-like fields included, so an extension's own redaction is belt to the
 * server's braces rather than the only line of defence.
 */
function toExtCapture(raw: unknown): Capture | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const method = typeof o.method === 'string' ? o.method : null;
  const url = typeof o.url === 'string' ? o.url : null;
  if (!method || !url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null; // the extension always posts absolute URLs
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const now = Date.now();
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const headers = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === 'string') out[k] = val;
      }
    }
    return out;
  };
  return {
    id: newId('cap'),
    ts: typeof o.ts === 'number' && Number.isFinite(o.ts) && o.ts > 0 ? Math.min(o.ts, now) : now,
    source: 'ext',
    adapterId: null,
    method,
    url,
    host: u.host,
    path: u.pathname,
    status: typeof o.status === 'number' ? o.status : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
    reqHeaders: headers(o.reqHeaders),
    reqBody: str(o.reqBody),
    resHeaders: headers(o.resHeaders),
    resBody: str(o.resBody),
  };
}

/**
 * The request's URL, or null when it cannot be parsed. Resolved against a
 * constant base: building it from the `Host` header, before Host was validated,
 * let one `Host: [` request throw ERR_INVALID_URL and kill the runner.
 */
function parseReqUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
  } catch {
    return null;
  }
}

function toText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return (data as Buffer).toString('utf8');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** The webapp dev server's pinned port (apps/webapp/vite.config.ts, strictPort). */
const DEV_UI_PORT = 5273;

/**
 * Is this Origin the dashboard itself? A browser always sends one, so an exact
 * allowlist — loopback, http, and THIS runner's port or the pinned dev UI's —
 * blocks every other website and every other local port, so a compromised dev
 * server on another port cannot drive the runner with a leaked token.
 * Non-browser clients (tests, CLIs) omit Origin; the bearer token is still the
 * hard gate there, and `/pty` refuses an absent one.
 */
function isOwnOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:') return false;
    // WHATWG keeps the brackets on an IPv6 hostname, so this is '[::1]', not '::1'.
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return false;
    const p = u.port === '' ? 80 : Number(u.port);
    return p === port || p === DEV_UI_PORT;
  } catch {
    return false;
  }
}

/**
 * Parse and minimally validate one `/pty` client frame. Returns null on anything
 * malformed; the terminal socket is a raw byte channel, so a bad frame is dropped
 * rather than answered.
 */
function parsePtyFrame(text: string): PtyClientFrame | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.t === 'stdin' && typeof o.d === 'string') return { t: 'stdin', d: o.d };
  if (o.t === 'resize' && typeof o.cols === 'number' && typeof o.rows === 'number') {
    return { t: 'resize', cols: o.cols, rows: o.rows };
  }
  if (o.t === 'end') return { t: 'end' };
  return null;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function placeholderHtml(port: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sluice runner</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; max-width: 42rem;
         margin: 8vh auto; padding: 0 1.25rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  code, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: rgba(127,127,127,.14); padding: .8rem 1rem; border-radius: 8px;
        overflow-x: auto; }
  .muted { opacity: .7; }
  a { color: inherit; }
</style>
</head>
<body>
  <h1>Sluice runner is up</h1>
  <p class="muted">Listening on <code>127.0.0.1:${port}</code>. No built web UI was found at
     <code>apps/webapp/dist</code>.</p>
  <p>Build it once, then reload this page:</p>
  <pre>pnpm webapp:build</pre>
  <p>…or run the dev server and open it with the tokenized URL the runner printed
     to the terminal (the token is in the URL fragment, never sent to the server):</p>
  <pre>pnpm webapp:dev</pre>
  <p class="muted">The WebSocket endpoint is <code>ws://127.0.0.1:${port}/ws?token=…</code>.
     The token is loopback-only, rotates every run, and is shown only on the
     runner's own terminal — this page never contains it.</p>
</body>
</html>`;
}
