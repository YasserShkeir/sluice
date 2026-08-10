// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Engine A (PRIMARY) — an in-process mockttp HTTPS proxy that passively taps the
 * client's own live traffic. It is strictly read-only: every request/websocket is
 * `thenPassThrough`'d with no transforms, so behavior is identical to not running
 * Sluice. For EVERY request we build a canonical Capture — tagging the owning app
 * when an adapter claims it, else leaving it unclassified — run headers + bodies
 * through the core secret-redactor, and hand it to onCapture.
 *
 * Secrets never leave this file un-redacted: reqHeaders/resHeaders go through
 * redactHeaders, bodies + url through redactText, before a Capture is emitted.
 *
 * "Every request" means every request it is allowed to DECRYPT. TLS termination
 * is scoped to the installed adapters' hosts plus anything `--host` adds — see
 * `tlsInterceptList`. Everything else is tunnelled through as opaque bytes.
 */
import { readFileSync } from 'node:fs';
import type { CompletedRequest, CompletedResponse, Mockttp } from 'mockttp';
import { newId, redactHeaders, redactText, redactUrl, splitUrl } from '@sluice/core';
import type { Adapter, Capture, EngineStatus, FrameDirection } from '@sluice/core';
import { ensureSluiceCA } from './ca.js';
import { loadMockttp } from './mockttp-loader.js';

/**
 * The parts of mockttp's `WebSocketMessage` we consume. Note it carries NO url —
 * the socket's URL only appears on the `websocket-request` event, so frames are
 * correlated back to it by `streamId`.
 */
interface WsMessageEvent {
  streamId: string;
  content: Uint8Array;
  isBinary: boolean;
}

/** Cap a single body at ~5 MB so a pathological response can't OOM the runner. */
const MAX_BODY = 5_000_000;

export interface MitmEngineOptions {
  port: number;
  adapters: Adapter[];
  onCapture: (c: Capture) => void;
  onError?: (e: unknown) => void;
  /**
   * Fired on every state transition. Without it the UI only ever learns the
   * engine's state at subscribe time and shows a dead engine as running forever.
   */
  onStatus?: (s: EngineStatus) => void;
  /** Capture WebSocket frames as well as HTTP. Default true. */
  captureWebSockets?: boolean;
  /**
   * Extra hostname patterns to decrypt, on top of the installed adapters' own
   * hosts. This is how you reconnoitre a service Sluice has no adapter for yet:
   * `sluice start --host app.notion.so`. Wildcards follow URLPattern, e.g.
   * `*.notion.so`.
   */
  interceptHosts?: string[];
  /**
   * Decrypt EVERY host. Off by default, and it should stay off — see
   * `tlsInterceptList`. Exposed as `sluice start --all-hosts` for the rare case
   * where you genuinely do not know which hostnames a client talks to.
   */
  interceptAllHosts?: boolean;
}

/**
 * The hostnames whose TLS this proxy is allowed to terminate.
 *
 * Engine A used to hand mockttp no `tlsInterceptOnly` list at all, which meant it
 * decrypted every TLS connection the routed client made — your bank, your email,
 * every unrelated tab — not just the hosts the installed adapters care about.
 * Everything it saw was stored, so the same omission was also the root cause of
 * unbounded store growth: `pruneCaptures` was trimming a firehose instead of the
 * traffic anyone asked for.
 *
 * Scoping it means non-matching connections are tunnelled through as raw bytes:
 * Sluice cannot read them, so it cannot store them, so they cannot leak from
 * `~/.sluice/sluice.db`. That is a stronger guarantee than redaction, because it
 * holds even for hosts whose secret shapes the redactor has never seen.
 *
 * Each declared host also contributes a `*.host` pattern: an app's own subdomains
 * (files.slack.com, cdn.trello.com) are part of that app's traffic, and adapters
 * declare only the handful they match on today.
 *
 * An EMPTY list is meaningful and safe — mockttp reads it as "intercept nothing"
 * rather than "no restriction" — so filtering down to zero adapters captures
 * nothing rather than everything.
 */
export function tlsInterceptList(
  adapters: Adapter[],
  extraHosts: string[] = [],
): Array<{ hostname: string }> {
  const hostnames = new Set<string>();
  const add = (h: string): void => {
    const host = h.trim().toLowerCase();
    if (!host) return;
    hostnames.add(host);
    // A wildcard the caller wrote themselves is left exactly as given.
    if (!host.includes('*')) hostnames.add(`*.${host}`);
  };
  for (const a of adapters) for (const h of a.hosts) add(h);
  for (const h of extraHosts) add(h);
  return [...hostnames].sort().map((hostname) => ({ hostname }));
}

/** What we remember between the `request` and `response` events for one exchange. */
interface Pending {
  method: string;
  url: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  startedAt: number;
}

export class MitmEngine {
  private readonly port: number;
  private readonly adapters: Adapter[];
  private readonly onCapture: (c: Capture) => void;
  private readonly onError: (e: unknown) => void;
  private readonly onStatus: (s: EngineStatus) => void;
  private readonly captureWebSockets: boolean;
  private readonly interceptHosts: string[];
  private readonly interceptAllHosts: boolean;
  private server: Mockttp | undefined;
  private state: EngineStatus['state'] = 'stopped';
  private detail: string | undefined;
  /** Cached from the first successful start, so the reentrancy guard can return it. */
  private caPath: string | undefined;
  private readonly pending = new Map<string, Pending>();
  /** streamId → socket URL, learned from `websocket-request` (frames carry none). */
  private readonly wsUrls = new Map<string, string>();

  constructor(opts: MitmEngineOptions) {
    this.port = opts.port;
    this.adapters = opts.adapters;
    this.onCapture = opts.onCapture;
    this.onError = opts.onError ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});
    this.captureWebSockets = opts.captureWebSockets ?? true;
    this.interceptHosts = opts.interceptHosts ?? [];
    this.interceptAllHosts = opts.interceptAllHosts ?? false;
  }

  /**
   * The hostnames this engine will decrypt, or `undefined` when scoping is off.
   * Exposed so `sluice start` can print it — which hosts get decrypted is a
   * privacy-relevant fact, and the user should not have to read the source to
   * learn it.
   */
  interceptedHosts(): string[] | undefined {
    if (this.interceptAllHosts) return undefined;
    return tlsInterceptList(this.adapters, this.interceptHosts).map((h) => h.hostname);
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

  async start(): Promise<{ port: number; caPath: string }> {
    // Reentrancy guard. `start()` assigns `this.server` before awaiting
    // `server.start()`, so a second concurrent call — two dashboards, a
    // double-click, or a UI start racing the supervisor's own restart — used to
    // overwrite the reference, leak the first mockttp server (still holding the
    // port), and then `stop()` the wrong one. Once the engine is runtime-mutable
    // (the dashboard can start it), that race is reachable. An already-running or
    // still-starting engine is returned as-is rather than started twice.
    if ((this.state === 'running' || this.state === 'starting') && this.server) {
      return { port: this.server.port, caPath: this.caPath ?? '' };
    }
    this.setState('starting');
    try {
      const ca = await ensureCA();
      const { getLocal } = await loadMockttp();
      const scoped = this.interceptedHosts();
      const server = getLocal({
        https: {
          key: ca.key,
          cert: ca.cert,
          // Omitted entirely under --all-hosts: mockttp treats the option's
          // ABSENCE as "no restriction" and an empty ARRAY as "intercept
          // nothing", so the two are not interchangeable.
          ...(scoped ? { tlsInterceptOnly: scoped.map((hostname) => ({ hostname })) } : {}),
        },
        // Clients that only speak h2 (and modern desktop apps increasingly do)
        // could not talk through the proxy at all while this was off, so their
        // traffic was invisible rather than captured.
        http2: true,
      });
      this.server = server;

      // Read-only passthrough for everything. NO transforms — traffic is unaltered.
      await server.forAnyRequest().thenPassThrough();
      // Proxy websockets too (the flannel/RTM socket) so the client isn't broken.
      await server.forAnyWebSocket().thenPassThrough();

      await server.on('request', (req: CompletedRequest) => {
        void this.onRequest(req);
      });
      await server.on('response', (res: CompletedResponse) => {
        void this.onResponse(res);
      });
      // Drop half-open exchanges so `pending` can't grow without bound.
      await server.on('abort', (req: { id: string }) => {
        this.pending.delete(req.id);
      });

      if (this.captureWebSockets) {
        // Fold RTM/realtime frames into the same Capture pipeline as HTTP. Live
        // Slack events (message, reaction_added, presence) travel here and were
        // previously proxied but never observed, so the store only ever held the
        // REST side of a workspace.
        //
        // A frame carries no URL — only a streamId — so remember each socket's
        // URL from the opening request and correlate on that.
        await server.on('websocket-request', (req: CompletedRequest) => {
          this.wsUrls.set(req.id, req.url);
        });
        await server.on('websocket-close', (ev: { streamId: string }) => {
          this.wsUrls.delete(ev.streamId);
        });
        // Direction is inverted relative to the CDP engine's vocabulary: mockttp
        // names events from the PROXY's point of view, so a message it "received"
        // came from the client (client → server), and one it "sent" went to the
        // client (server → client). We normalise to the page's point of view so
        // both engines agree.
        await server.on('websocket-message-received', (m: WsMessageEvent) => {
          this.onWsFrame(m, 'sent');
        });
        await server.on('websocket-message-sent', (m: WsMessageEvent) => {
          this.onWsFrame(m, 'received');
        });
      }

      await server.start(this.port);
      this.caPath = ca.certPath;
      this.setState('running');
      return { port: server.port, caPath: ca.certPath };
    } catch (err) {
      this.setState('error', errText(err));
      throw err;
    }
  }

  async stop(): Promise<void> {
    // Announce `stopping` BEFORE the async teardown. The supervisor's health
    // probe only acts on a `running` engine; without this transition the engine
    // still read `running` all through `server.stop()`, so a probe firing during
    // teardown saw the port already closing and "restarted" the engine the user
    // had just stopped. `stopping` is the signal that this is deliberate.
    this.setState('stopping');
    this.pending.clear();
    this.wsUrls.clear();
    if (this.server) {
      try {
        await this.server.stop();
      } catch (err) {
        this.onError(err);
      }
      this.server = undefined;
    }
    this.setState('stopped');
  }

  status(): EngineStatus {
    return {
      engine: 'mitm',
      state: this.state,
      detail: this.detail,
      proxyPort: this.server?.port,
    };
  }

  private async onRequest(req: CompletedRequest): Promise<void> {
    try {
      const { host, path } = splitUrl(req.url);
      let body: string | null = null;
      try {
        body = (await req.body.getText()) ?? null;
      } catch {
        body = null;
      }
      this.pending.set(req.id, {
        method: req.method,
        url: req.url,
        host,
        path,
        headers: normHeaders(req.headers),
        body: cap(body),
        startedAt: Date.now(),
      });
    } catch (err) {
      this.onError(err);
    }
  }

  private async onResponse(res: CompletedResponse): Promise<void> {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    try {
      const matched = this.match(p); // undefined → still captured, just unclassified
      const resHeaders = normHeaders(res.headers);

      // Decode text bodies only; keep the row for binary/media but skip its body.
      let resBody: string | null = null;
      if (isTextual(resHeaders)) {
        try {
          resBody = (await res.body.getText()) ?? null;
        } catch {
          resBody = null;
        }
      }

      const capture: Capture = {
        id: newId('cap'),
        ts: p.startedAt,
        source: 'mitm',
        adapterId: matched?.id ?? null,
        method: p.method,
        url: redactUrl(p.url),
        host: p.host,
        path: p.path,
        status: res.statusCode ?? null,
        durationMs: Date.now() - p.startedAt,
        reqHeaders: redactHeaders(p.headers),
        reqBody: p.body == null ? null : redactText(p.body),
        resHeaders: redactHeaders(resHeaders),
        resBody: resBody == null ? null : redactText(cap(resBody) ?? ''),
        pid: null,
        processName: null,
      };
      this.onCapture(capture);
    } catch (err) {
      this.onError(err);
    }
  }

  /**
   * One WebSocket frame → one Capture, mirroring the CDP engine's shape so the
   * two engines produce interchangeable rows. `direction` is already normalised
   * to the page's point of view by the caller.
   */
  private onWsFrame(m: WsMessageEvent, direction: FrameDirection): void {
    try {
      // Binary frames carry no readable payload worth storing; skip them.
      if (m.isBinary || !m.content) return;
      const text = Buffer.from(m.content).toString('utf8');
      if (!text) return;

      const url = this.wsUrls.get(m.streamId) ?? '';
      const { host, path } = splitUrl(url || 'https://unknown/');
      const matched = this.adapters.find((a) => {
        try {
          return a.matchRequest({ host, path, method: 'WS', url });
        } catch {
          return false;
        }
      });
      const body = redactText(text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…[truncated]` : text);

      this.onCapture({
        id: newId('cap'),
        ts: Date.now(),
        source: 'ws',
        adapterId: matched?.id ?? null,
        method: 'WS',
        url: redactUrl(url),
        host,
        path,
        status: null,
        durationMs: null,
        reqHeaders: {},
        reqBody: direction === 'sent' ? body : null,
        resHeaders: {},
        resBody: direction === 'received' ? body : null,
        pid: null,
        processName: null,
        direction,
        wsId: m.streamId,
      });
    } catch (err) {
      this.onError(err);
    }
  }

  private match(p: Pending): Adapter | undefined {
    for (const a of this.adapters) {
      try {
        if (a.matchRequest({ host: p.host, path: p.path, method: p.method, url: p.url })) return a;
      } catch (err) {
        this.onError(err);
      }
    }
    return undefined;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Persist a locally-generated CA once so trust survives restarts; reuse it after.
 *
 * The paths and generation rules live in ca.ts, which `sluice ca-install` also
 * uses — the proxy and the trust installer MUST agree on one root cert, and they
 * previously agreed only by keeping two hand-synchronised copies of this logic.
 */
async function ensureCA(): Promise<{ key: string; cert: string; certPath: string }> {
  const { caPath, keyPath } = await ensureSluiceCA();
  return {
    key: readFileSync(keyPath, 'utf8'),
    cert: readFileSync(caPath, 'utf8'),
    certPath: caPath,
  };
}

/** mockttp header maps allow string | string[]; flatten to the Capture's string map. */
function normHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Only text-ish response bodies are decoded/stored; binary/media rows keep no body. */
function isTextual(headers: Record<string, string>): boolean {
  const ct = (headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase();
  if (ct === '') return true; // unknown → attempt (usually small)
  return /json|text|xml|javascript|html|x-www-form-urlencoded|graphql|csv|\+json/.test(ct);
}

function cap(s: string | null): string | null {
  if (s == null) return null;
  return s.length > MAX_BODY
    ? `${s.slice(0, MAX_BODY)}…[truncated ${s.length - MAX_BODY} chars]`
    : s;
}

function errText(e: unknown): string {
  return redactText(e instanceof Error ? e.message : String(e));
}
