// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Engine A (PRIMARY) — an in-process mockttp HTTPS proxy that passively taps the
 * client's own live traffic. It is strictly read-only: every request/websocket is
 * `thenPassThrough`'d with no transforms, so behavior is identical to not running
 * Sluice. For EVERY request we build a canonical Capture — tagging the owning app
 * when an adapter claims it, else leaving it unclassified — run headers + bodies
 * through the core secret-redactor, and hand it to onCapture.
 *
 * Secrets never leave this file un-redacted: every Capture is built by
 * `redactedCapture` (capture-build.ts), which masks headers, bodies and URLs.
 *
 * Default: decrypt every host the routed client talks to (recon / unknown
 * services work without an adapter) EXCEPT {@link NEVER_DECRYPT_HOSTS}, which
 * are always tunnelled. Pass `interceptHosts` / adapter-only scoping, or set
 * `interceptAllHosts: false`, to narrow TLS termination — see
 * `tlsInterceptList`. Non-matching connections are then tunnelled as opaque bytes.
 */
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo, Server as NetServer } from 'node:net';
import type { CompletedRequest, CompletedResponse, Mockttp } from 'mockttp';
import { headerValue, matchAdapter, redactedErrorMessage as errText, splitUrl } from '@sluice/core';
import type { Adapter, Capture, EngineStatus, FrameDirection } from '@sluice/core';
import { caDer, caMobileconfig, ensureSluiceCA } from './ca.js';
import { capBody, redactedCapture, wsFrameCapture } from './capture-build.js';
import { loadMockttp } from './mockttp-loader.js';

/** Default Engine A bind — never `*` unless the caller opted into LAN. */
const LOOPBACK_LISTEN_HOST = '127.0.0.1';
/** `--lan-proxy` bind. mockttp has no single-IPv4 listen API. */
export const LAN_LISTEN_HOST = '0.0.0.0';

const CA_DOWNLOAD_PATHS = new Set(['/sluice-ca.pem', '/sluice-ca.cer', '/sluice-ca.mobileconfig']);
/** Beat `forAnyRequest` passthrough (same default priority otherwise). */
const CA_RULE_PRIORITY = 100;

export function isLoopbackListenHost(host: string | undefined): boolean {
  const h = (host ?? LOOPBACK_LISTEN_HOST).trim().toLowerCase();
  return h === LOOPBACK_LISTEN_HOST || h === 'localhost' || h === '::1';
}

/**
 * May this client use a proxy bound off loopback? Loopback always may; any
 * other address only when it is listed (IPv4-mapped `::ffff:` is stripped). An
 * empty list admits loopback only.
 */
export function isAllowedProxyClient(remoteAddress: string | undefined, allowed: readonly string[]): boolean {
  if (!remoteAddress) return false;
  const addr = remoteAddress.replace(/^::ffff:/i, '').toLowerCase();
  if (addr === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)) return true;
  return allowed.some((a) => a.trim().replace(/^::ffff:/i, '').toLowerCase() === addr);
}

/**
 * Drop every connection from a client {@link isAllowedProxyClient} refuses,
 * before the proxy reads a byte of it. Prepended, so it runs ahead of mockttp's
 * own connection handler. Exported for tests.
 */
export function guardProxyClients(
  server: Pick<NetServer, 'prependListener'>,
  allowed: readonly string[],
  onRefused?: (remoteAddress: string | undefined) => void,
): void {
  server.prependListener('connection', (socket: { remoteAddress?: string; destroy(): void }) => {
    if (isAllowedProxyClient(socket.remoteAddress, allowed)) return;
    socket.destroy();
    onRefused?.(socket.remoteAddress);
  });
}

/** Phone CA fetch paths — never stored as captures. */
export function isCaDownloadPath(path: string): boolean {
  return CA_DOWNLOAD_PATHS.has(path.split('?')[0] ?? path);
}

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
   * Hostname patterns to decrypt when scoping is on (see `interceptAllHosts`).
   * Combined with installed adapters' own hosts via `tlsInterceptList`.
   * Wildcards follow URLPattern, e.g. `*.notion.so`.
   */
  interceptHosts?: string[];
  /**
   * Decrypt EVERY host. **On by default** so unknown services (no adapter yet)
   * are still captured. Set false — or pass an explicit host list from the CLI /
   * config — to limit TLS termination to `tlsInterceptList`.
   */
  interceptAllHosts?: boolean;
  /** Address to listen on. Default 127.0.0.1; LAN capture passes 0.0.0.0 (see bindMockttpListenHost). */
  listenHost?: string;
  /**
   * Client addresses (besides loopback) allowed to use a listener that is not
   * loopback — the phone(s) on the LAN. Every other client's connection is
   * dropped before the proxy reads it; empty admits loopback only.
   */
  lanClients?: readonly string[];
}

/**
 * The hostnames whose TLS this proxy is allowed to terminate when scoping is on.
 *
 * When scoping is on, non-matching connections are tunnelled through as raw
 * bytes: Sluice cannot read them, so it cannot store them. That is a stronger
 * guarantee than redaction for hosts whose secret shapes the redactor has never
 * seen — use it when you want a tight privacy boundary.
 *
 * Each declared host also contributes a `*.host` pattern: an app's own subdomains
 * (files.slack.com, cdn.trello.com) are part of that app's traffic, and adapters
 * declare only the handful they match on today.
 *
 * An EMPTY list is meaningful and safe — mockttp reads it as "intercept nothing"
 * rather than "no restriction" — so filtering down to zero adapters/hosts
 * captures nothing rather than everything.
 */
export function tlsInterceptList(
  adapters: Adapter[],
  extraHosts: readonly string[] = [],
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

/**
 * Hosts whose TLS Engine A never terminates, even in all-hosts mode: AI
 * assistants and coding agents on the same machine (Claude Code's bridge, the
 * Anthropic and OpenAI APIs, GitHub Copilot) route through the same system
 * proxy, and their OAuth tokens and API keys ended up in the local capture DB.
 * Each entry also covers its subdomains. These connections are tunnelled as raw
 * TLS, so Sluice cannot read or store them.
 *
 * Scoped mode (`interceptAllHosts: false`) is unaffected: there, only hosts the
 * user or an adapter named are decrypted at all.
 */
export const NEVER_DECRYPT_HOSTS: readonly string[] = Object.freeze([
  'anthropic.com',
  'claude.ai',
  'claude.com',
  'claudeusercontent.com',
  'openai.com',
  'chatgpt.com',
  'githubcopilot.com',
]);

/**
 * The TLS-scope part of mockttp's `https` options. mockttp's two options are
 * mutually exclusive (setting both throws):
 *   - scoped (`scoped` is the host list): `tlsInterceptOnly`, so only those
 *     hosts are decrypted and an EMPTY list decrypts nothing;
 *   - all hosts (`scoped` undefined): `tlsPassthrough` of
 *     {@link NEVER_DECRYPT_HOSTS}, so everything else is decrypted.
 */
export function mitmTlsScope(
  scoped: string[] | undefined,
): { tlsInterceptOnly: Array<{ hostname: string }> } | { tlsPassthrough: Array<{ hostname: string }> } {
  if (scoped) return { tlsInterceptOnly: scoped.map((hostname) => ({ hostname })) };
  // Each host also as its trailing-dot FQDN (`api.anthropic.com.`), which the
  // passthrough patterns would otherwise not match.
  return { tlsPassthrough: tlsInterceptList([], NEVER_DECRYPT_HOSTS.flatMap((h) => [h, `${h}.`])) };
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
  private readonly listenHost: string;
  private readonly lanClients: readonly string[];
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
    this.listenHost = opts.listenHost?.trim() || LOOPBACK_LISTEN_HOST;
    this.lanClients = opts.lanClients ?? [];
    this.interceptAllHosts = opts.interceptAllHosts ?? true;
  }

  /**
   * The hostnames this engine will decrypt, or `undefined` when scoping is off
   * (all hosts). Exposed so `sluice start` can print it — which hosts get
   * decrypted is a privacy-relevant fact, and the user should not have to read
   * the source to learn it.
   */
  interceptedHosts(): string[] | undefined {
    if (this.interceptAllHosts) return undefined;
    return tlsInterceptList(this.adapters, this.interceptHosts).map((h) => h.hostname);
  }

  /** Bound proxy address after start (used by tests). */
  listenAddress(): { host: string; port: number } | undefined {
    const inner = this.server ? mockttpInnerServer(this.server) : undefined;
    const addr = inner?.address();
    if (addr && typeof addr === 'object') return { host: addr.address, port: addr.port };
    if (this.server) return { host: this.listenHost, port: this.server.port };
    return undefined;
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
      const { caPath, keyPath } = await ensureSluiceCA();
      const cert = readFileSync(caPath, 'utf8');
      const { getLocal } = await loadMockttp();
      const scoped = this.interceptedHosts();
      const server = getLocal({
        https: {
          key: readFileSync(keyPath, 'utf8'),
          cert,
          ...mitmTlsScope(scoped),
        },
        // Clients that only speak h2 (and modern desktop apps increasingly do)
        // could not talk through the proxy at all while this was off, so their
        // traffic was invisible rather than captured.
        http2: true,
      });
      this.server = server;
      // CA download for a phone on the LAN. Register BEFORE passthrough so the
      // GETs are answered here and never captured. Loopback binds skip this —
      // `sluice ca-install` already covers the Mac.
      if (!isLoopbackListenHost(this.listenHost)) {
        await this.installCaDownloadRules(server, cert);
      }

      // Fallback only: CA GETs must win. `forAnyRequest` at default priority
      // races the CA rules and forwards the proxy's own URL into itself
      // ("Passthrough loop detected") — Safari then installs that 500 as a profile.
      await server.forUnmatchedRequest().thenPassThrough();
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
        this.wsUrls.delete(req.id);
        this.pending.delete(req.id);
      });

      if (this.captureWebSockets) {
        // Fold RTM/realtime frames into the same Capture pipeline as HTTP. Live
        // Slack events (message, reaction_added, presence) travel here and were
        // previously proxied but never observed, so the store only ever held the
        // REST side of a workspace.
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
      await bindMockttpListenHost(server, this.listenHost);
      if (!isLoopbackListenHost(this.listenHost)) {
        // No authentication on a proxy: the client allowlist is what keeps any
        // device on the network from relaying through this Mac.
        const inner = mockttpInnerServer(server);
        if (!inner) throw new Error('MITM proxy exposed no listen handle to guard');
        guardProxyClients(inner, this.lanClients, (addr) =>
          this.onError(new Error(`refused a proxy client not on the LAN allowlist: ${addr ?? '(unknown)'}`)),
        );
      }
      this.caPath = caPath;
      this.setState('running');
      return { port: server.port, caPath };
    } catch (err) {
      // Fail closed. `server.start()` binds every interface before the loopback
      // rebind, so a rebind that throws would otherwise leave that listener up
      // for the life of the process — and the controller discards this engine
      // on a failed start, so nothing could stop it later. mockttp's stop is
      // called directly (not this.stop(), which would overwrite 'error'), and
      // rejects when the server never listened.
      const orphan = this.server;
      this.server = undefined;
      await orphan?.stop().catch(() => {});
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
      if (isCaDownloadPath(path)) return;
      const body = await req.body.getText().catch(() => undefined);
      this.pending.set(req.id, {
        method: req.method,
        url: req.url,
        host,
        path,
        headers: normHeaders(req.headers),
        body: body == null ? null : capBody(body),
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
      // undefined → still captured, just unclassified
      const matched = matchAdapter(this.adapters, p, this.onError);
      const resHeaders = normHeaders(res.headers);

      // Decode text bodies only; keep the row for binary/media but skip its body.
      const resText = isTextual(resHeaders) ? await res.body.getText().catch(() => undefined) : undefined;

      this.onCapture(
        redactedCapture({
          ts: p.startedAt,
          source: 'mitm',
          adapterId: matched?.id ?? null,
          method: p.method,
          url: p.url,
          host: p.host,
          path: p.path,
          status: res.statusCode ?? null,
          durationMs: Date.now() - p.startedAt,
          reqHeaders: p.headers,
          reqBody: p.body,
          resHeaders,
          resBody: resText == null ? null : capBody(resText),
        }),
      );
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

      this.onCapture(
        wsFrameCapture({
          adapters: this.adapters,
          url: this.wsUrls.get(m.streamId) ?? '',
          wsId: m.streamId,
          direction,
          text,
          onError: this.onError,
        }),
      );
    } catch (err) {
      this.onError(err);
    }
  }

  private async installCaDownloadRules(server: Mockttp, pem: string): Promise<void> {
    const reply = (
      pathRe: RegExp,
      body: string | Buffer,
      type: string,
      filename: string,
    ): Promise<unknown> =>
      server
        .forGet(pathRe)
        .asPriority(CA_RULE_PRIORITY)
        .thenReply(200, body, {
          'Content-Type': type,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        });

    await reply(/^\/sluice-ca\.pem$/, pem, 'application/x-pem-file', 'sluice-ca.pem');
    const der = caDer(pem);
    if (der) {
      await reply(/^\/sluice-ca\.cer$/, der, 'application/x-x509-ca-cert', 'sluice-ca.cer');
      await reply(
        /^\/sluice-ca\.mobileconfig$/,
        caMobileconfig(der),
        'application/x-apple-aspen-config',
        'sluice-ca.mobileconfig',
      );
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
  const ct = (headerValue(headers, 'content-type') ?? '').toLowerCase();
  if (ct === '') return true; // unknown → attempt (usually small)
  return /json|text|xml|javascript|html|x-www-form-urlencoded|graphql|csv|\+json/.test(ct);
}

/**
 * mockttp 4.6 `start(port)` always calls `this.server.listen(port)` with no
 * host, so Node binds `::` / `0.0.0.0`. Close that socket and listen again on
 * the requested address. The combo server is a real `net.Server`.
 */
async function bindMockttpListenHost(server: Mockttp, listenHost: string): Promise<void> {
  const inner = mockttpInnerServer(server);
  if (!inner) {
    throw new Error('MITM proxy started but exposed no listen handle to rebind');
  }
  const current = inner.address();
  const bound = listenAddressHost(current);
  if (listenHostMatches(bound, listenHost)) return;
  const port = typeof current === 'object' && current ? current.port : server.port;
  await new Promise<void>((resolve, reject) => inner.close((err) => (err ? reject(err) : resolve())));
  const listening = once(inner, 'listening');
  inner.listen(port, listenHost);
  await listening;
  const after = listenAddressHost(inner.address());
  if (!listenHostMatches(after, listenHost)) {
    throw new Error(`MITM proxy rebound to ${after ?? '(unknown)'} instead of ${listenHost}`);
  }
}

function mockttpInnerServer(server: Mockttp): NetServer | undefined {
  const raw = server as unknown as { server?: NetServer };
  return raw.server && typeof raw.server.listen === 'function' ? raw.server : undefined;
}

function listenAddressHost(addr: AddressInfo | string | null): string | undefined {
  if (!addr || typeof addr === 'string') return undefined;
  return addr.address;
}

function listenHostMatches(bound: string | undefined, wanted: string): boolean {
  if (!bound) return false;
  if (bound === wanted) return true;
  if (isLoopbackListenHost(wanted)) return isLoopbackListenHost(bound);
  return (wanted === LAN_LISTEN_HOST || wanted === '::') && ['0.0.0.0', '::', '*'].includes(bound);
}
