// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The loopback HTTP + WebSocket server that fronts the runner.
 *
 * Security posture (see §2.3 / §15.2 of the plans):
 *   - binds 127.0.0.1 only;
 *   - a random per-session bearer token gates every WS upgrade;
 *   - the WS upgrade also requires a loopback `Host` (anti DNS-rebinding) and,
 *     when present, a loopback `Origin` (a browser always sends one, so this
 *     blocks any other website / tab from subscribing);
 *   - every capture is re-run through the core redactors before it is persisted
 *     or streamed, so a secret cannot leave the capture path even by accident;
 *   - only a RedactedSession is ever streamed.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  operationName,
  redactHeaders,
  redactSession,
  redactText,
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
  ParseResult,
  PtyClientFrame,
  PtyServerFrame,
  ReplayAction,
  OpProgress,
  ReplayRunMsg,
  ServerMsg,
  Session,
  SqliteStore,
  SubscribeFilter,
  StatusMsg,
  SubscribeMsg,
} from '@sluice/core';
import type { TerminalHooks, TerminalSession } from './claude-terminal.js';
import { ReplayDeniedError, replayBudget, runFlowReplay, runReplay, resolveJsonPath } from '@sluice/interceptor';
import {
  buildFlowStepRequest,
  dropMaterialized,
  faithfulReplayRequest,
  materialize,
} from '@sluice/cartographer';

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
import { handleApi } from './api.js';

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
 * How many recent broadcast frames are held for resume.
 *
 * Deliberately modest. A `capture.new` frame pins its bodies — up to 5 MB each —
 * in memory for as long as it sits in the ring, and SQLite is still the durable
 * copy: a client that falls off the end gets a full backfill, which is slower
 * but never wrong. This covers a page reload and a laptop-lid reconnect, which
 * is what resume exists for; it is not a replication log.
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
}

export async function startServer(opts: StartServerOpts): Promise<StartServerResult> {
  const { store, adapters, port, getSessions, engine, control, terminal } = opts;
  const token = randomBytes(32).toString('hex');
  // A THIRD capability secret (after the read token and the pty token), minted
  // only with `--ingest`. It gates the sole POST the API accepts; the read token
  // cannot substitute for it, and it is never embedded in any served page.
  const ingestToken = opts.ingest ? randomBytes(32).toString('hex') : '';
  // A SECOND capability secret, minted only when the terminal is enabled and kept
  // distinct from `token`. Holding the read/mutation token does not let a caller
  // open a shell: `/pty` checks this one. It rides the URL fragment (`&p=`) the
  // same way `token` rides `#k=`, so it is never sent to the server on an ordinary
  // request and never embedded in the served document.
  const ptyToken = terminal ? randomBytes(32).toString('hex') : '';

  const clients = new Set<WebSocket>();
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
   * Server-side because the previous pause was not: the UI said "paused" while
   * the engine went on writing every request to disk. On a capture tool that is
   * a privacy bug, not a cosmetic one — you pause precisely when you are about
   * to do something you would rather not record.
   */
  let capturePaused = false;

  // ── one ingest funnel — live captures AND replay results flow through here ──

  function sanitizeCapture(c: Capture): Capture {
    // Belt-and-suspenders: engines already redact, but a stray secret must never
    // reach SQLite or the wire, so we redact again right before either happens.
    return {
      ...c,
      reqHeaders: redactHeaders(c.reqHeaders ?? {}),
      resHeaders: redactHeaders(c.resHeaders ?? {}),
      reqBody: c.reqBody == null ? c.reqBody : redactText(c.reqBody),
      resBody: c.resBody == null ? c.resBody : redactText(c.resBody),
    };
  }

  function adapterFor(c: Capture): Adapter | undefined {
    if (c.adapterId) {
      const byId = adapters.find((a) => a.id === c.adapterId);
      if (byId) return byId;
    }
    return adapters.find((a) =>
      a.matchRequest({ host: c.host, path: c.path, method: c.method, url: c.url }),
    );
  }

  function ingestCapture(raw: Capture): { capture: Capture; parsed: ParseResult } {
    const capture = sanitizeCapture(raw);
    const adapter = adapterFor(capture);
    if (adapter && !capture.adapterId) capture.adapterId = adapter.id; // attribute to its app
    // Prefer the adapter's semantic op (cards/:id, not card/6uQ2uchS). Generic
    // operationName is the fallback for unattributed traffic and adapters without
    // classify — calling only operationName was how Trello shortLinks and gateway
    // paths never collapsed and polluted flow templates.
    if (capture.classification == null && adapter?.classify) {
      try {
        const named = adapter.classify(capture);
        if (named.operation) capture.classification = named.operation;
      } catch {
        // classify is contractually non-throwing; never lose a capture to one that does.
      }
    }
    capture.classification ??= operationName(capture.path);
    // Parsing happens immediately below, so this row is done before it lands.
    // Writing it here rather than in a second UPDATE keeps it one statement.
    capture.parsedAt ??= Date.now();
    store.insertCapture(capture);
    const parsed: ParseResult = adapter ? adapter.parse(capture) : {};
    store.applyParseResult(parsed, capture.ts || Date.now());
    // Seed the worklist from what this response says is still unfetched.
    //
    // The cursors table existed and was written by exactly one caller — the CLI
    // drainer, from inside its own loop — so on a live `sluice start` it was
    // empty and stayed empty, and `sluice replay --all` had nothing to drain
    // unless you had already drained something. Every response knows what comes
    // after it; this is the only place every response passes through.
    //
    // Enqueue only, never execute. Seeding is free and bounded (the unique index
    // dedupes a page seen twice), while replaying is a real call against a real
    // account and stays behind an explicit command.
    if (adapter?.nextCursors !== undefined) {
      try {
        const seeds = adapter.nextCursors(capture);
        if (seeds.length > 0) store.enqueueCursors(seeds);
      } catch {
        // `nextCursors` is contractually not allowed to throw, and a capture is
        // not worth losing to one that does anyway.
      }
    }
    broadcast({ type: 'capture.new', capture });
    if (hasEntities(parsed)) {
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
    return { capture, parsed };
  }

  // ── WS send helpers ─────────────────────────────────────────────────────────

  function send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(msg: ServerMsg): void {
    msg.seq = ++seq;
    ring.push(msg);
    if (ring.length > RESUME_RING) ring.splice(0, ring.length - RESUME_RING);
    fanOut(msg);
  }

  /**
   * Report one operation's progress to every dashboard.
   *
   * `fanOut`, not `broadcast`: op progress is transient status, and putting a
   * finished op in the resume ring would replay it on the next reconnect as if
   * it had just happened. It carries no `seq` for the same reason `status` does
   * not — there is nothing to resume.
   */
  function emitOp(op: OpProgress): void {
    fanOut({ type: 'op.progress', op });
  }

  /**
   * Write one frame to every subscriber it belongs to.
   *
   * ONE `JSON.stringify` shared by all of them. That matters: a capture body can
   * be 5 MB, and serializing per subscriber made a second dashboard cost as much
   * as the first. Per-connection filters do not break it, because a filter only
   * ever DROPS a frame — it never rewrites one — so every connection that
   * receives this frame receives byte-identical output. The serialization is
   * lazy, so a frame no connection wants costs nothing at all.
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

  /**
   * Can this client resume from `sinceSeq`, or must it be re-primed from SQLite?
   *
   * Two ways the answer is no, and both must fall back to a full backfill: the
   * ring no longer reaches back that far, or the client names a seq this runner
   * never issued. The type checks that used to be here as well are now the
   * schema's job (`@sluice/protocol`), which is why `sinceSeq` arrives as a
   * non-negative integer or not at all.
   *
   * A seq from a PREVIOUS runner cannot get here: a restart mints a new session
   * token, so the stale tab's socket fails the upgrade gate rather than resuming
   * against a counter that has been rewound.
   */
  /** Seq floor after wipe/delete — clients with sinceSeq below this must full-backfill. */
  let resumeFloorSeq = 0;

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
    { id: 'notion', displayName: 'Notion' },
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
    const row = store.db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE ? ESCAPE '\\'`)
      .get(`${adapterId}\\_%`) as { n: number };
    return row.n > 0;
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
        // `inputSchema` is a zod RAW SHAPE here — a plain object keyed by
        // parameter name. The MCP SDK converts it to a ZodObject at
        // registration, and reading keys off THAT yields ZodObject's own
        // members instead; packages/mcp's test carries the same warning,
        // having once asserted exactly that and passed for the wrong reason.
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
        // Every field, not a subset. The UI generates a form from this, so a
        // dropped `label` shows a raw param name and a dropped `default` makes
        // the adapter's own sensible starting value unreachable.
        params: r.params.map((p) => ({
          name: p.name,
          kind: p.kind,
          required: p.required,
          label: p.label,
          default: p.default,
        })),
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

  // Debounced so a capture burst produces one catalog refresh rather than one
  // per request — this used to run inline on every single captured exchange.
  let appsTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleBroadcastApps(): void {
    if (appsTimer || subscribers.size === 0) return;
    appsTimer = setTimeout(() => {
      appsTimer = undefined;
      broadcastApps();
    }, 1000);
  }

  // Dynamic DB: debounce a materialize so the per-app tables rebuild after a
  // capture burst settles, then refresh the catalog so "Local DB" stays live.
  //
  // The watermark keeps this incremental. The first pass covers everything
  // already in the store; each later pass only sees captures that arrived since,
  // so the cost tracks new traffic instead of total store size. Upserts are
  // idempotent and keyed, so the resulting tables are identical either way.
  let matTimer: ReturnType<typeof setTimeout> | undefined;
  let materializedThroughTs: number | undefined;
  function scheduleMaterialize(): void {
    if (matTimer) clearTimeout(matTimer);
    matTimer = setTimeout(() => {
      matTimer = undefined;
      try {
        const startedAt = Date.now();
        materialize(store, { sinceTs: materializedThroughTs });
        // Rewind slightly so a capture written while we were scanning is not
        // skipped by the next pass; re-processing a few rows is free.
        materializedThroughTs = startedAt - 5_000;
        broadcastApps();
      } catch (e) {
        // materialize runs real DDL driven by arbitrary response-body keys, so a
        // type/name collision is a plausible throw. Swallowing it left the only
        // symptom as "Local DB: false" with no diagnostic anywhere.
        const text = `Per-app DB build failed: ${redactText(errMsg(e))}`;
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
   * wipe the recorder — a capture tool must survive a refresh. Sent in chunks:
   * one frame per capture meant 2000 serializations and socket writes per reload.
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
    const oldestFirst = recent.slice().reverse();
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

  function findAction(actionId: string): { adapter: Adapter; action: ReplayAction } | undefined {
    for (const adapter of adapters) {
      const action = adapter.listReplayActions().find((a) => a.id === actionId);
      if (action) return { adapter, action };
    }
    return undefined;
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
      const match = findAction(msg.actionId);
      if (!match) throw new Error(`Unknown replay action "${msg.actionId}".`);
      // The action FIRST, then a session belonging to its adapter. It used to be
      // the other way round, falling back to `sessions[0]` whatever app that
      // was for — the same defect `onSync` documents and guards against below,
      // where a Trello session reached Slack's request builder and emitted a
      // literal `Cookie: cookieHeader`. Here it was worse than noise: the
      // request went out authenticated as the WRONG ACCOUNT.
      const sessions = getSessions().filter((s) => s.adapterId === match.adapter.id);
      const session =
        (msg.sessionId ? sessions.find((s) => s.id === msg.sessionId) : undefined) ?? sessions[0];
      if (!session) {
        throw new Error(
          `No active ${match.adapter.displayName} session — run \`sluice extract-token\` first.`,
        );
      }
      const req = faithfulReplayRequest(
        store,
        match.adapter.buildReplayRequest(match.action, msg.params ?? {}, session),
      );
      // runReplay enforces the safety rails (method / operation / rate budget)
      // below this layer, so a modified frontend cannot route around them.
      const result = await runReplay(req); // returns a normalized, secret-redacted Capture
      const { capture, parsed } = ingestCapture(result);
      send(ws, { type: 'replay.result', requestId: msg.requestId, capture, parsed });
      // The budget moved, so everyone's meter has to. Broadcast rather than
      // answer: the bucket is process-global — shared with sync, the MCP tools
      // and the CLI drainer — so a second dashboard's meter is wrong the moment
      // this one spends a token.
      broadcast(statusFrame());
    } catch (e) {
      const code = e instanceof ReplayDeniedError ? `[${e.code}] ` : '';
      send(ws, {
        type: 'replay.error',
        requestId: msg.requestId,
        error: `${code}${redactText(errMsg(e))}`,
      });
      // A refusal spends nothing, but a denial for `rate_budget_exhausted` is
      // exactly when the meter matters most.
      broadcast(statusFrame());
    }
  }

  /**
   * Multi-step flow run from the dashboard (F7.3). Same pipeline as CLI
   * `sluice replay --flow` and MCP `sluice_replay_flow`: learn template →
   * buildFlowStepRequest (with app.hosts) → runFlowReplay → per-step runReplay.
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
      const sessions = getSessions().filter((s) => s.adapterId === app.id);
      const session =
        (msg.sessionId ? sessions.find((s) => s.id === msg.sessionId) : undefined) ?? sessions[0];
      if (!session) {
        throw new Error(
          `No active ${app.displayName} session — run \`sluice extract-token\` first.`,
        );
      }

      const result = await runFlowReplay({
        template: tmpl,
        params: msg.params ?? {},
        session,
        io: {
          build: (step, s, ctx) =>
            buildFlowStepRequest(tmpl, step, s, {
              params: ctx.params,
              priorResponses: ctx.priorResponses,
              resolvePath: resolveJsonPath,
              allowedHosts: app.hosts,
            }),
          run: (req) => runReplay(req),
          record: (c) => {
            c.adapterId = app.id;
            // Same funnel as single replay: attribute, store, stream, materialize.
            ingestCapture(c);
          },
          refresh: app.credentials
            ? async () => {
                const again = getSessions().filter((s) => s.adapterId === app.id);
                return again[0];
              }
            : undefined,
        },
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
        error: result.error ? redactText(result.error) : undefined,
        steps: result.steps.map((s) => ({
          seq: s.seq,
          role: s.role,
          operation: s.operation,
          method: s.method,
          path: s.path,
          status: s.status,
          captureId: s.captureId,
          httpStatus: s.httpStatus,
          detail: s.detail ? redactText(s.detail) : undefined,
          durationMs: s.durationMs,
        })),
      });
      broadcast(statusFrame());
    } catch (e) {
      const code = e instanceof ReplayDeniedError ? `[${e.code}] ` : '';
      send(ws, {
        type: 'flow.error',
        requestId: msg.requestId,
        error: `${code}${redactText(errMsg(e))}`,
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

  // The global Sync button: reconstruct structure for every session/workspace by
  // replaying each adapter's no-argument "structure" actions (conversations.list,
  // users.list, …). Results flow through the same ingest funnel (attributed,
  // stored, streamed, materialized).
  // No `ws` param: sync progress is BROADCAST via op.progress (every dashboard
  // watching one runner should see the sync), not answered to the requester.
  async function onSync(): Promise<void> {
    // One operation, keyed, so its many steps update a single row instead of
    // firing (and clobbering) a toast per failed action — the exact failure of
    // the old notice-per-action loop.
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
        // (firing unauthenticated). The CLI's `sluice sync` has always had this
        // guard; the WS path did not.
        if (session.adapterId !== adapter.id) continue;
        for (const action of adapter.listReplayActions()) {
          if (action.params.some((p) => p.required)) continue; // only no-arg structure actions
          const params: Record<string, string> = {};
          for (const p of action.params) if (p.default != null) params[p.name] = p.default;
          try {
            const req = faithfulReplayRequest(store, adapter.buildReplayRequest(action, params, session));
            const { parsed } = ingestCapture(await runReplay(req));
            entities +=
              (parsed.containers?.length ?? 0) + (parsed.actors?.length ?? 0) + (parsed.items?.length ?? 0);
            emitOp({ requestId, kind: 'sync', state: 'running', detail: `${session.label} ${action.id}`, count: entities });
          } catch (e) {
            // Accumulated, not each-a-toast: five failures now leave five lines
            // in ONE op's detail, all of which survive, instead of one 4.5s toast.
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
      send0(`environment read failed: ${redactText(errMsg(e))}`);
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
      emitOp({ requestId, kind: `engine.${action}`, state: 'error', detail: redactText(errMsg(e)) });
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
      emitOp({ requestId, kind: `proxy.${action}`, state: 'error', detail: redactText(errMsg(e)) });
    }
  }

  /** A standalone info notice — used where there is no single client to answer. */
  function send0(text: string): void {
    broadcast({ type: 'notice', level: 'error', text });
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
      emitOp({ requestId, kind, state: 'error', detail: redactText(errMsg(e)) });
    }
  }

  /**
   * Drop + fully rebuild the derived tables for the given adapters.
   *
   * The integrity rule: `materialize` is INSERT-OR-REPLACE only, so it never
   * removes rows for captures that were just deleted. After ANY capture delete,
   * the derived tables must be dropped and rebuilt from scratch — an incremental
   * re-materialize would leave the deleted captures' rows behind.
   */
  function rebuildDerived(adapterIds: string[]): number {
    dropMaterialized(store, adapterIds);
    // A full rebuild (no sinceTs watermark), and clear the debounce so a pending
    // incremental pass cannot race in with the stale watermark.
    if (matTimer) {
      clearTimeout(matTimer);
      matTimer = undefined;
    }
    const { tables } = materialize(store);
    materializedThroughTs = Date.now() - 5_000; // full rebuild done; incremental resumes from here
    return tables.length;
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
    try {
      const { statSync } = await import('node:fs');
      const { statfsSync } = await import('node:fs');
      const dbBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
      try {
        const fs = statfsSync(dbPath);
        const free = fs.bavail * fs.bsize;
        if (free < dbBytes) {
          throw new Error(
            `VACUUM needs ~${Math.ceil(dbBytes / 1e6)} MB free but only ${Math.floor(free / 1e6)} MB is available.`,
          );
        }
      } catch (e) {
        // statfsSync is newer Node; if it is unavailable, skip the pre-check
        // rather than block the VACUUM — but re-throw a real space error.
        if (e instanceof Error && e.message.includes('VACUUM needs')) throw e;
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('VACUUM needs')) throw e;
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
    const reply = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
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
      return reply(413, { error: 'bad_body', detail: redactText(errMsg(e)) });
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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? LOOPBACK_HOST}`);
    if (url.pathname === '/ws') {
      res.statusCode = 426;
      res.end('Upgrade Required');
      return;
    }

    // The one authenticated POST: passive-capture ingest (Engine C). Handled
    // BEFORE the GET-only `/api/*` gate below, and on its OWN secret — so the
    // read API stays read-only and the read token cannot post captures.
    if (url.pathname === '/api/ingest') {
      void handleIngest(req, res);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // The API reads the whole capture store, so it carries exactly the same
      // gate as the WebSocket upgrade: loopback Host (anti DNS-rebinding), a
      // loopback Origin when the caller sent one, and the per-session token.
      // Static assets stay unauthenticated — and now genuinely contain nothing
      // secret: the token is no longer injected into the served document (see
      // injectConfig), so a fetch of `/` cannot disclose it.
      const okHost = isLoopbackHost(req.headers.host, port);
      const okOrigin = isLoopbackOrigin(req.headers.origin);
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
    // Injects the NON-SECRET bootstrap config only — the port and WS path — never
    // the token.
    //
    // The token used to be injected here too, and that was a real disclosure: the
    // static document is served WITHOUT auth (only `/api/*` is gated), so any
    // local user or process could `curl http://127.0.0.1:<port>/` and read
    // `window.__SLUICE_TOKEN__` with no credential at all — then use it on `/ws`
    // and `/api`. The token now travels in the URL FRAGMENT (`/#k=<token>`, the
    // same path the dev flow already used): the fragment is never sent to the
    // server, so a fetch of the document cannot contain it, and the client moves
    // it into sessionStorage and strips it on load (see the webapp's readToken).
    // The port matters because the webapp once hardcoded 7788, so `--port`
    // produced a UI that could never connect.
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

  function sendPty(ws: WebSocket, frame: PtyServerFrame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  /** Buffer output (for re-attach) and forward it to whichever tab is attached now. */
  function ptyOnData(d: string): void {
    ptyBuffer.push(d);
    ptyBufferBytes += d.length;
    while (ptyBufferBytes > PTY_BUFFER_MAX && ptyBuffer.length > 1) {
      ptyBufferBytes -= (ptyBuffer.shift() ?? '').length;
    }
    if (ptyWs) sendPty(ptyWs, { t: 'data', d });
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
            if (ptyWs) sendPty(ptyWs, { t: 'exit', code });
            if (ptySession === session) killPtySession();
          });
        } catch (e) {
          sendPty(ws, { t: 'error', message: redactText(errMsg(e)) });
          ws.close();
          return;
        }
      }

      sendPty(ws, { t: 'ready' });
      // Replay recent output so a reloaded tab shows the session as it stands.
      if (ptyBuffer.length > 0) sendPty(ws, { t: 'data', d: ptyBuffer.join('') });

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
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? LOOPBACK_HOST}`);
    const okHost = isLoopbackHost(req.headers.host, port);

    if (url.pathname === '/pty') {
      // Stricter than /ws by design. `/ws` tolerates a missing Origin so non-browser
      // clients (tests, CLIs) can connect on the bearer token alone; nothing but the
      // dashboard should ever speak `/pty`, so an absent Origin FAILS CLOSED here.
      // And it is gated by the SEPARATE pty secret, so the read token cannot open it.
      const okOrigin = isLoopbackOriginStrict(req.headers.origin);
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
    const okOrigin = isLoopbackOrigin(req.headers.origin);
    const okToken = safeEqual(url.searchParams.get('token') ?? '', token);
    if (!okPath || !okHost || !okOrigin || !okToken) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
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
      // Validated, not merely narrowed. This used to be a `type`-string check
      // and nothing else, so `subscribe.sinceSeq` could be a string, a
      // `subscribe.filter` could be a number, and `replay.run` handed its
      // `params` to an adapter's request builder without anyone having looked
      // at them. Every handler below was written to coerce defensively around
      // that, which is a rule that has to be remembered at each new call site.
      const frame = parseClientFrame(toText(data));
      if (!frame.ok) {
        // Said out loud rather than dropped. A silently discarded frame presents
        // as "the socket went quiet", which is diagnosed by reading the runner's
        // source; a notice puts the reason in the UI that sent it.
        send(ws, { type: 'notice', level: 'error', text: `Ignored a malformed message — ${frame.reason}.` });
        return;
      }
      const parsed = frame.msg;
      switch (parsed.type) {
        case 'hello.ok':
          // The other half of the version handshake. A skew is otherwise
          // invisible — both ends keep talking, and whatever field one of them
          // gained is silently absent on the other — so name it here rather
          // than leave someone debugging an empty panel after a partial upgrade.
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
            const ids = parsed.adapterId ? [parsed.adapterId] : adapters.map((a) => a.id);
            const rebuilt = rebuildDerived(ids);
            return { detail: `Rebuilt ${rebuilt} table(s).` };
          });
          break;
        case 'data.clearApp':
          void onData(parsed.requestId, 'clearApp', async () => {
            const app = parsed.adapterId;
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
            dropMaterialized(store, adapters.map((a) => a.id));
            invalidateRing();
            await vacuumGuarded();
            return { count: captures, detail: `Wiped ${captures} capture(s) and all derived data.` };
          });
          break;
      }
    });
    ws.on('close', () => {
      subscribers.delete(ws);
      clients.delete(ws);
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
    if (appsTimer) {
      clearTimeout(appsTimer);
      appsTimer = undefined;
    }
    if (matTimer) clearTimeout(matTimer);
    // Take the terminal down first so its child dies with the server, not orphaned.
    // This is where the persistent session is reclaimed — the runner exiting is
    // its lifetime bound, not a dropped socket.
    killPtySession();
    if (ptyWs) ptyWs.terminate();
    for (const ws of clients) ws.terminate();
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

function hasEntities(pr: ParseResult): boolean {
  return Boolean(
    pr.workspaces?.length || pr.actors?.length || pr.containers?.length || pr.items?.length,
  );
}

/**
 * Validate + normalize one exchange POSTed to `/api/ingest` into a Capture.
 *
 * Untrusted input, so it is defensive: it requires a method and URL, derives host
 * and path from the URL when the poster omits them, keeps only string header
 * values, and stamps `source: 'ext'`. It does NOT redact — the ingest funnel's
 * `sanitizeCapture` does that for every path, so an extension's own redaction is
 * belt to the server's braces rather than the only line of defence.
 */
function toExtCapture(raw: unknown): Capture | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const method = typeof o.method === 'string' ? o.method : null;
  const url = typeof o.url === 'string' ? o.url : null;
  if (!method || !url) return null;
  let host = typeof o.host === 'string' ? o.host : '';
  let path = typeof o.path === 'string' ? o.path : '';
  if (!host || !path) {
    try {
      const u = new URL(url);
      host ||= u.host;
      path ||= u.pathname + u.search;
    } catch {
      /* a non-absolute URL keeps whatever the poster gave */
    }
  }
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
    id: str(o.id) ?? randomBytes(12).toString('hex'),
    ts: typeof o.ts === 'number' ? o.ts : Date.now(),
    source: 'ext',
    adapterId: null,
    method,
    url,
    host,
    path,
    status: typeof o.status === 'number' ? o.status : null,
    durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
    reqHeaders: headers(o.reqHeaders),
    reqBody: str(o.reqBody),
    resHeaders: headers(o.resHeaders),
    resBody: str(o.resBody),
    tabUrl: str(o.tabUrl) ?? undefined,
    tabId: str(o.tabId) ?? undefined,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

function isLoopbackOrigin(origin: string | undefined): boolean {
  // A browser always sends an Origin on a WS handshake, so requiring it to be
  // loopback blocks any other site. Non-browser clients (tests, CLIs) omit it;
  // the bearer token is still the hard gate there.
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Like {@link isLoopbackOrigin} but FAILS CLOSED on an absent Origin. Used only
 * for `/pty`: the terminal is a browser-only feature, so a handshake with no
 * Origin is not a CLI we should accommodate — it is something we should refuse.
 */
function isLoopbackOriginStrict(origin: string | undefined): boolean {
  if (!origin) return false;
  return isLoopbackOrigin(origin);
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

function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ttf':
      return 'font/ttf';
    case '.wasm':
      return 'application/wasm';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
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
