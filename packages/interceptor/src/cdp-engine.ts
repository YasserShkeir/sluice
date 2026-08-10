// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Engine C — passive browser capture via the Chrome DevTools Protocol.
 *
 * Attaches to a debug-enabled Chrome (`--remote-debugging-port`) and OBSERVES the
 * real XHR/Fetch traffic and WebSocket frames the pages produce as the user
 * clicks. It issues ZERO requests of its own — from the server's view nothing
 * unusual happens, which is the whole point: the traffic is the client's own, and
 * no CA cert or proxy is involved.
 *
 * It attaches to EVERY page target, not one:
 *   - a sign-in flow that opens a new tab used to produce nothing at all,
 *   - a second workspace in a second tab was invisible,
 *   - and closing the one attached tab silently ended capture.
 * Targets are discovered up front and as they appear, each gets its own Network
 * session, and every capture carries the tab that produced it so the UI can
 * separate concurrent tabs.
 *
 * Unlike replay, this captures EVERY API call — including endpoints no adapter yet
 * knows about — so it feeds endpoint discovery / the API cartographer, not just
 * the known app methods. Headers + bodies pass through the core redactors before
 * a Capture is emitted.
 */
import type CDPType from 'chrome-remote-interface';
import { newId, redactHeaders, redactText, redactUrl, splitUrl } from '@sluice/core';
import type { Adapter, Capture, EngineStatus, FrameDirection } from '@sluice/core';

/**
 * chrome-remote-interface is loaded on demand.
 *
 * Only the CDP capture path needs it, but a static import made every consumer of
 * @sluice/interceptor depend on it — including the MCP server, which never
 * touches Chrome and would fail to start if the package were absent.
 */
async function cdp(): Promise<typeof CDPType> {
  return (await import('chrome-remote-interface')).default;
}

const MAX_BODY = 5_000_000;
/** How often to re-poll for tabs opened since we attached. */
const DISCOVER_INTERVAL_MS = 2_000;

export interface CdpEngineOptions {
  /** Chrome remote-debugging port to attach to. */
  port: number;
  adapters: Adapter[];
  onCapture: (c: Capture) => void;
  onError?: (e: unknown) => void;
  /**
   * Fired on every state transition. This engine can stop on its own — closing
   * the last attached tab drops its DevTools connection — so without this the UI
   * has no way to learn that capture has ended.
   */
  onStatus?: (s: EngineStatus) => void;
  /** Capture WebSocket frames as well as HTTP. Default true. */
  captureWebSockets?: boolean;
}

type CdpClient = Awaited<ReturnType<typeof CDPType>>;

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  title?: string;
}

interface ReqWillBeSent {
  requestId: string;
  /** CDP document loader id — shared by every request that belongs to one navigation. */
  loaderId?: string;
  request: { url: string; method: string; headers: Record<string, string>; postData?: string };
  type?: string;
}
interface RespReceived {
  requestId: string;
  response: { status: number; headers: Record<string, string>; url: string };
}
interface WithRequestId {
  requestId: string;
}
interface GetBodyResult {
  body: string;
  base64Encoded: boolean;
}
interface WsCreated {
  requestId: string;
  url: string;
}
interface WsFrame {
  requestId: string;
  timestamp: number;
  response: { opcode: number; mask: boolean; payloadData: string };
}

interface Pending {
  method: string;
  url: string;
  host: string;
  path: string;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  startedAt: number;
  adapterId: string | null;
  status: number | null;
  resHeaders: Record<string, string>;
  /** Which attached tab this exchange belongs to. */
  tabId: string;
  tabUrl: string;
  /** CDP Network loader id — F0.3 correlation for one document load. */
  loaderId?: string | null;
}

/** One attached page target and everything scoped to it. */
interface Attached {
  id: string;
  url: string;
  client: CdpClient;
  /** Open sockets on this tab: CDP requestId → its URL, for frame attribution. */
  sockets: Map<string, string>;
}

export class CdpEngine {
  private readonly port: number;
  private readonly adapters: Adapter[];
  private readonly onCapture: (c: Capture) => void;
  private readonly onError: (e: unknown) => void;
  private readonly onStatus: (s: EngineStatus) => void;
  private readonly captureWebSockets: boolean;
  private state: EngineStatus['state'] = 'stopped';
  private detail: string | undefined;
  private stopping = false;
  private discoverTimer: ReturnType<typeof setInterval> | undefined;
  /** True while a discover() pass is in flight — concurrent polls must not double-attach. */
  private discovering = false;
  /** Target ids currently mid-attach (await CDP) so a second discover cannot race. */
  private attaching = new Set<string>();

  /** Attached page targets, keyed by CDP target id. */
  private readonly attached = new Map<string, Attached>();
  /**
   * In-flight exchanges, keyed by `${tabId}:${requestId}`. CDP request ids are
   * only unique within a target, so keying by requestId alone would let two tabs
   * collide and cross-attribute each other's bodies.
   */
  private readonly pending = new Map<string, Pending>();

  constructor(opts: CdpEngineOptions) {
    this.port = opts.port;
    this.adapters = opts.adapters;
    this.onCapture = opts.onCapture;
    this.onError = opts.onError ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});
    this.captureWebSockets = opts.captureWebSockets ?? true;
  }

  /** Record a transition and tell anyone listening. Never throws into a caller. */
  private setState(state: EngineStatus['state'], detail?: string): void {
    this.state = state;
    this.detail = detail;
    try {
      this.onStatus(this.status());
    } catch (err) {
      this.onError(err);
    }
  }

  async start(): Promise<{ port: number }> {
    this.setState('starting');
    this.stopping = false;
    try {
      const targets = await this.listPageTargets();
      if (targets.length === 0) {
        throw new Error(
          `no CDP page target on :${this.port} — is Chrome running with --remote-debugging-port=${this.port}?`,
        );
      }
      for (const t of targets) await this.attach(t);
      if (this.attached.size === 0) throw new Error('found page targets but could not attach to any');

      // Tabs opened later (a sign-in popup, a second workspace) must be picked up
      // too, otherwise capture silently covers only whatever existed at startup.
      this.discoverTimer = setInterval(() => void this.discover(), DISCOVER_INTERVAL_MS);
      this.discoverTimer.unref?.();

      this.setState('running', this.describeAttachment());
      return { port: this.port };
    } catch (e) {
      this.setState('error', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  private async listPageTargets(): Promise<TargetInfo[]> {
    const CDP = await cdp();
    const all = (await CDP.List({ port: this.port })) as TargetInfo[];
    return all.filter((t) => t.type === 'page');
  }

  private describeAttachment(): string {
    const n = this.attached.size;
    const first = [...this.attached.values()][0];
    return n === 1
      ? `attached to Chrome :${this.port} (${first?.url || 'page'})`
      : `attached to Chrome :${this.port} (${n} tabs)`;
  }

  /** Poll for tabs that appeared or vanished since the last check. */
  private async discover(): Promise<void> {
    if (this.stopping || this.discovering) return;
    this.discovering = true;
    try {
      let targets: TargetInfo[];
      try {
        targets = await this.listPageTargets();
      } catch {
        return; // Chrome may be shutting down; the disconnect handlers will cope
      }
      const live = new Set(targets.map((t) => t.id));
      for (const t of targets) {
        if (!this.attached.has(t.id) && !this.attaching.has(t.id)) await this.attach(t);
      }
      // Drop bookkeeping for tabs that are gone; their client emits 'disconnect'
      // too, but polling also covers a target that vanished without one.
      for (const id of [...this.attached.keys()]) {
        if (!live.has(id)) this.detach(id, 'tab closed');
      }
    } finally {
      this.discovering = false;
    }
  }

  private async attach(t: TargetInfo): Promise<void> {
    if (this.attached.has(t.id) || this.attaching.has(t.id) || this.stopping) return;
    this.attaching.add(t.id);
    let client: CdpClient;
    try {
      const CDP = await cdp();
      client = await CDP({ port: this.port, target: t.id });
    } catch (e) {
      this.attaching.delete(t.id);
      this.onError(e);
      return;
    }

    const entry: Attached = { id: t.id, url: t.url, client, sockets: new Map() };
    this.attached.set(t.id, entry);
    this.attaching.delete(t.id);

    const net = client.Network;
    net.requestWillBeSent((p) => this.onRequest(entry, p as ReqWillBeSent));
    net.responseReceived((p) => this.onResponse(entry, p as RespReceived));
    net.loadingFinished((p) => void this.onFinished(entry, (p as WithRequestId).requestId));
    net.loadingFailed((p) => this.pending.delete(this.key(entry.id, (p as WithRequestId).requestId)));

    if (this.captureWebSockets) {
      // Slack RTM (and any realtime layer) lives here — invisible to the HTTP
      // handlers above, which is why live message events never reached the store.
      net.webSocketCreated((p) => {
        const w = p as WsCreated;
        entry.sockets.set(w.requestId, w.url);
      });
      net.webSocketClosed((p) => {
        entry.sockets.delete((p as WithRequestId).requestId);
      });
      net.webSocketFrameSent((p) => this.onFrame(entry, p as WsFrame, 'sent'));
      net.webSocketFrameReceived((p) => this.onFrame(entry, p as WsFrame, 'received'));
    }

    client.on('disconnect', () => this.detach(t.id, 'tab closed'));

    try {
      await net.enable();
    } catch (e) {
      this.onError(e);
      this.detach(t.id, 'Network.enable failed');
      return;
    }

    // Only announce once running; during start() the caller reports attachment.
    if (this.state === 'running') this.setState('running', this.describeAttachment());
  }

  private detach(id: string, why: string): void {
    const entry = this.attached.get(id);
    if (!entry) return;
    this.attached.delete(id);
    for (const k of [...this.pending.keys()]) {
      if (k.startsWith(`${id}:`)) this.pending.delete(k);
    }
    try {
      void entry.client.close();
    } catch {
      /* already gone */
    }
    if (this.stopping) return;
    // Capture only truly ends when the last tab goes.
    if (this.attached.size === 0) this.setState('stopped', `Chrome DevTools connection closed (${why})`);
    else this.setState('running', this.describeAttachment());
  }

  private key(tabId: string, requestId: string): string {
    return `${tabId}:${requestId}`;
  }

  private onRequest(tab: Attached, p: ReqWillBeSent): void {
    const type = p.type ?? '';
    if (type !== 'XHR' && type !== 'Fetch') return; // API calls only — skip docs/assets
    const { host, path } = splitUrl(p.request.url);
    // Capture ALL API calls (any host); tag the owning app if an adapter claims it.
    const match = this.adapters.find((a) =>
      a.matchRequest({ host, path, method: p.request.method, url: p.request.url }),
    );
    const loaderId = p.loaderId ?? null;
    this.pending.set(this.key(tab.id, p.requestId), {
      method: p.request.method,
      url: p.request.url,
      host,
      path,
      reqHeaders: p.request.headers ?? {},
      reqBody: p.request.postData ?? null,
      startedAt: Date.now(),
      adapterId: match?.id ?? null,
      status: null,
      resHeaders: {},
      tabId: tab.id,
      tabUrl: tab.url,
      loaderId,
    });
  }

  private onResponse(tab: Attached, p: RespReceived): void {
    const pend = this.pending.get(this.key(tab.id, p.requestId));
    if (!pend) return;
    pend.status = p.response.status;
    pend.resHeaders = p.response.headers ?? {};
  }

  private async onFinished(tab: Attached, requestId: string): Promise<void> {
    const k = this.key(tab.id, requestId);
    const pend = this.pending.get(k);
    if (!pend) return;
    this.pending.delete(k);

    let bodyText: string | null = null;
    try {
      // Fetch through the OWNING tab's session — a request id means nothing to
      // another target's client.
      const res = (await tab.client.Network.getResponseBody({ requestId })) as GetBodyResult | undefined;
      if (res) {
        bodyText = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
        if (bodyText.length > MAX_BODY) bodyText = `${bodyText.slice(0, MAX_BODY)}…[truncated]`;
      }
    } catch {
      bodyText = null; // body may be evicted or opaque; still emit the capture
    }

    try {
      this.onCapture({
        id: newId('cap'),
        ts: pend.startedAt,
        source: 'cdp',
        adapterId: pend.adapterId,
        method: pend.method,
        url: redactUrl(pend.url),
        host: pend.host,
        path: pend.path,
        status: pend.status,
        durationMs: Date.now() - pend.startedAt,
        reqHeaders: redactHeaders(pend.reqHeaders),
        reqBody: pend.reqBody == null ? null : redactText(pend.reqBody),
        resHeaders: redactHeaders(pend.resHeaders),
        resBody: bodyText == null ? null : redactText(bodyText),
        pid: null,
        processName: null,
        tabId: pend.tabId,
        tabUrl: pend.tabUrl,
        // F0.3: loaderId is the CDP document load; pageLoadId aliases it so
        // clustering can use one field across engines.
        loaderId: pend.loaderId ?? null,
        pageLoadId: pend.loaderId ?? null,
      });
    } catch (e) {
      this.onError(e);
    }
  }

  /**
   * One WebSocket frame → one Capture. Payload goes in reqBody for a sent frame
   * and resBody for a received one, so the existing inspector tabs render it
   * without special-casing. Opcode 1 is text; binary frames are skipped since
   * their payload is base64 and not useful to parse or read.
   */
  private onFrame(tab: Attached, p: WsFrame, direction: FrameDirection): void {
    const opcode = p.response?.opcode;
    if (opcode !== 1) return; // text frames only
    const payload = p.response.payloadData ?? '';
    if (!payload) return;

    const url = tab.sockets.get(p.requestId) ?? '';
    const { host, path } = splitUrl(url || 'https://unknown/');
    const match = this.adapters.find((a) => a.matchRequest({ host, path, method: 'WS', url }));
    const text = payload.length > MAX_BODY ? `${payload.slice(0, MAX_BODY)}…[truncated]` : payload;
    const redacted = redactText(text);

    try {
      this.onCapture({
        id: newId('cap'),
        ts: Date.now(),
        source: 'ws',
        adapterId: match?.id ?? null,
        method: 'WS',
        url: redactUrl(url),
        host,
        path,
        status: null,
        durationMs: null,
        reqHeaders: {},
        reqBody: direction === 'sent' ? redacted : null,
        resHeaders: {},
        resBody: direction === 'received' ? redacted : null,
        pid: null,
        processName: null,
        tabId: tab.id,
        tabUrl: tab.url,
        direction,
        wsId: p.requestId,
      });
    } catch (e) {
      this.onError(e);
    }
  }

  /** Navigate a tab (defaults to the first attached one). */
  /**
   * Drive the attached tab (debug / scripted capture). Not on the hot ingest
   * path — kept for `sluice capture` helpers and manual CDP control.
   */
  async navigate(url: string, tabId?: string): Promise<void> {
    const tab = tabId ? this.attached.get(tabId) : [...this.attached.values()][0];
    if (!tab) throw new Error('CdpEngine has no attached tab');
    await tab.client.Page.navigate({ url });
  }

  /** Run JS in a tab (defaults to the first attached one). */
  /** Evaluate JS in the attached tab — same non-hot-path use as navigate. */
  async evaluate(expression: string, tabId?: string): Promise<void> {
    const tab = tabId ? this.attached.get(tabId) : [...this.attached.values()][0];
    if (!tab) throw new Error('CdpEngine has no attached tab');
    await tab.client.Runtime.evaluate({ expression, awaitPromise: false });
  }

  /** The tabs currently being captured — surfaced so the UI can label a filter. */
  tabs(): Array<{ id: string; url: string }> {
    return [...this.attached.values()].map((t) => ({ id: t.id, url: t.url }));
  }

  status(): EngineStatus {
    return { engine: 'cdp', state: this.state, detail: this.detail, proxyPort: this.port };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.discoverTimer) {
      clearInterval(this.discoverTimer);
      this.discoverTimer = undefined;
    }
    this.pending.clear();
    for (const entry of this.attached.values()) {
      try {
        await entry.client.close();
      } catch {
        /* already closed */
      }
    }
    this.attached.clear();
    this.setState('stopped');
  }
}
