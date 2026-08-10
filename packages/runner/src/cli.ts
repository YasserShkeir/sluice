#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `sluice` — the local-only capture daemon + one-shot commands.
 *
 * Commands: doctor | extract-token | serve | start | replay | export
 *
 * Secrets rule, enforced everywhere below: the live Session (token + `d` cookie)
 * lives only in this process's memory. Only a RedactedSession is ever written to
 * SQLite, and error strings pass through `redactText` before printing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { redactHeaders, redactSession, redactText, redactUrl, SqliteStore } from '@sluice/core';
import type {
  Actor,
  App,
  Capture,
  Container,
  EngineStatus,
  Item,
  Session,
  WorkItem,
  Workspace,
} from '@sluice/core';
import {
  apps,
  describeDiscovery,
  externalConfigPath,
  installExternalAdapters,
  readEnabledAdapterIds,
} from '@sluice/apps';
import { parseNdjson, runMockCaptures } from '@sluice/adapter-sdk';
import {
  CdpEngine,
  defaultChromeProfileDir,
  ensureSluiceCA,
  sluiceCaCertPath,
  launchDebugChrome,
  mapAuthFlow,
  MitmEngine,
  reconstructCredentials,
  ReplayDeniedError,
  resolveJsonPath,
  runFlowReplay,
  runReplay,
  superviseEngine,
} from '@sluice/interceptor';
import type { LaunchedChrome, Supervisor } from '@sluice/interceptor';
import { buildApiMap, buildFlowStepRequest, clusterCapturesIntoFlows, faithfulReplayRequest, learnFlowTemplates, materialize, renderMarkdown } from '@sluice/cartographer';

import * as config from './config.js';
import { clearProxy, detectNetworkService, getProxyState, setProxy } from './proxy.js';
import { startServer, type StartServerResult } from './server.js';
import { EngineController, type EngineHandle } from './engine-controller.js';
import { ChildEngine } from './child-engine.js';
import { makeClaudeTerminal, type Effort, type TerminalHooks } from './claude-terminal.js';

interface CredFlags {
  token?: string;
  cookie?: string;
  'app-support'?: string;
}

/** Can we open a TCP connection to this port? Used to spot a dangling system proxy. */
async function isPortListening(port: number, host = config.LOOPBACK_HOST): Promise<boolean> {
  const { createConnection } = await import('node:net');
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(750, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// ── small shared helpers ─────────────────────────────────────────────────────

function errMsg(e: unknown): string {
  return redactText(e instanceof Error ? e.message : String(e));
}

/** Surface an app-style {ok:false,error} body (or an HTTP error) so failures are visible. */
function apiErrorText(capture: Capture): string | null {
  if (capture.resBody) {
    try {
      const b = JSON.parse(capture.resBody) as { ok?: boolean; error?: string; needed?: string; provided?: string };
      if (b.ok === false) {
        return `${b.error ?? 'error'}${b.needed ? ` (needed: ${b.needed}; provided: ${b.provided ?? '-'})` : ''}`;
      }
    } catch {
      /* non-JSON body */
    }
  }
  return capture.status != null && capture.status >= 400 ? `HTTP ${capture.status}` : null;
}

/**
 * The config file, loaded once per process.
 *
 * Precedence is CLI flag → config file → built-in default, so a flag always wins
 * and nothing silently overrides something the user typed. Loaded lazily so a
 * malformed config only fails the commands that actually read settings.
 */
let configCache: { config: config.SluiceConfig; path?: string } | undefined;
function fileConfig(explicitPath?: string): config.SluiceConfig {
  if (!configCache || explicitPath) configCache = config.loadConfig(explicitPath);
  return configCache.config;
}

/** Resolve the DB path: `--db` → config `db` → default. */
function resolveDb(dbFlag?: string, configPath?: string): string {
  return dbFlag ?? fileConfig(configPath).db ?? config.defaultDbPath();
}

function openStore(dbPath?: string): SqliteStore {
  config.ensureSluiceHome();
  return new SqliteStore(dbPath ?? config.defaultDbPath());
}

/** Passively seed named Workspace entities from each app's local config (no Keychain, no network). */
async function seedWorkspaces(store: SqliteStore, appSupport?: string): Promise<void> {
  const opts = appSupport ? { appSupportDir: appSupport } : undefined;
  for (const app of apps) {
    const listWorkspaces = app.credentials?.listWorkspaces;
    if (!listWorkspaces) continue;
    try {
      const wss = await listWorkspaces(opts);
      if (wss.length === 0) continue;
      store.applyParseResult(
        { workspaces: wss.map((w) => ({ id: w.id, adapterId: app.id, name: w.name, domain: w.domain })) },
        Date.now(),
      );
      console.error(`Workspaces (${wss.length}): ${wss.map((w) => w.name).join(', ')}`);
    } catch {
      /* best-effort, passive */
    }
  }
}

/**
 * Build/refresh the per-app tables from existing captures. Non-fatal, but NOT
 * silent: materialize runs real DDL derived from arbitrary response bodies, so a
 * column type/name collision is a plausible failure — and swallowing it left the
 * user with an empty per-app DB and no explanation anywhere.
 */
function materializeQuiet(store: SqliteStore): void {
  try {
    const { tables } = materialize(store);
    if (tables.length) {
      console.error(`Per-app DB: ${tables.map((t) => `${t.name}(${t.rows})`).join(', ')}`);
    }
  } catch (e) {
    console.error(`Warning: per-app DB build failed — ${redactText(errMsg(e))}`);
  }
}

/**
 * Let every app settle the identities its per-capture parse could not.
 *
 * Run at the points where the store has just stopped changing — the end of a
 * capture session, the end of a sync — because the whole reason an identity is
 * unresolved is that the capture that would settle it had not arrived yet.
 * Running it per capture would answer with whatever had arrived so far, which
 * is the guess this exists to avoid.
 *
 * Never fatal. This tidies attribution; it does not create data, and a store
 * that failed to reconcile is a store with a placeholder workspace in it, which
 * is exactly what it looked like a moment earlier.
 */
function reconcileAll(store: SqliteStore): void {
  for (const app of apps) {
    if (app.reconcile === undefined) continue;
    try {
      const { changed, note } = app.reconcile(store);
      if (changed === 0 && note === undefined) continue;
      console.error(`${app.id}: ${note ?? `${changed} identities settled`}`);
    } catch (e) {
      console.error(`Warning: ${app.id} reconcile failed — ${redactText(errMsg(e))}`);
    }
  }
}

function parsePort(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`Invalid port: ${v}`);
  return n;
}

/**
 * Restrict the installed apps to the config's allow-list, if it has one.
 * An unknown id is an error rather than a silent no-op: a typo'd adapter name
 * that quietly captured everything would be the opposite of what was asked for.
 */
function selectApps(configPath?: string): typeof apps {
  const allow = fileConfig(configPath).adapters;
  if (!allow || allow.length === 0) return apps;
  const known = new Set(apps.map((a) => a.id));
  const unknown = allow.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown adapter id(s) in config: ${unknown.join(', ')}. Installed: ${[...known].join(', ')}`,
    );
  }
  return apps.filter((a) => allow.includes(a.id));
}

/** Apply the config's retention bounds, if any. Reports what it removed. */
function applyRetention(store: SqliteStore, configPath?: string): void {
  const { retentionDays, maxCaptures } = fileConfig(configPath);
  if (retentionDays === undefined && maxCaptures === undefined) return;
  const removed = store.pruneCaptures({
    maxAgeMs: retentionDays === undefined ? undefined : retentionDays * 24 * 60 * 60 * 1000,
    maxRows: maxCaptures,
  });
  if (removed > 0) console.error(`Retention: pruned ${removed} old capture(s).`);
}

/** Default landing URL for passive capture — the first app's web host (`app.*` preferred). */
function defaultCaptureUrl(): string {
  const hosts = apps[0]?.hosts ?? [];
  const host = hosts.find((h) => h.startsWith('app.')) ?? hosts[0];
  return host ? `https://${host}/` : 'about:blank';
}

/**
 * Gather sessions across every installed app: paste-in credentials when both
 * `--token` and `--cookie` are given, else each app's local-store extraction.
 * Propagates an app extractor's throw (e.g. off macOS); returns [] only when an
 * app simply has no signed-in workspace.
 */
async function extractAllSessions(flags: CredFlags, adapterId?: string): Promise<Session[]> {
  const opts = flags['app-support'] ? { appSupportDir: flags['app-support'] } : undefined;
  const out: Session[] = [];
  for (const app of apps) {
    // Scoping matters beyond tidiness: every extractor that runs may raise its
    // own Keychain prompt, so asking three apps for credentials when one was
    // wanted is three consent dialogs.
    if (adapterId && app.id !== adapterId) continue;
    const provider = app.credentials;
    if (!provider) continue;
    if (flags.token && flags.cookie) {
      const s = provider.sessionFromInput?.({ token: flags.token, cookie: flags.cookie });
      if (s) out.push(s);
      continue;
    }
    out.push(...(await provider.extractSessions(opts)));
  }
  return out;
}

/**
 * Paste-in credentials if given, else extract from the app's local store.
 *
 * `adapterId` is not optional in spirit. Handing a session to another app's
 * request builder is the bug the WS sync path already guards against: a Trello
 * session reaching Slack's builder emits a literal `Cookie: cookieHeader`
 * header, and a Slack session reaching Trello's fires unauthenticated. Since
 * `apps[0]` is Slack, `sluice replay <any trello action>` did exactly that.
 */
async function acquireSession(flags: CredFlags, adapterId?: string): Promise<Session> {
  const sessions = await extractAllSessions(flags, adapterId);
  const first = sessions[0];
  if (!first) {
    throw new Error(
      adapterId
        ? `No signed-in ${adapterId} workspace found — sign in to it, or pass --token/--cookie.`
        : 'No signed-in workspace found — sign in, or pass --token/--cookie.',
    );
  }
  return first;
}

/** Never throws: returns ALL workspace sessions (one per team), or [] with a warning. */
async function bestEffortSessions(flags: CredFlags): Promise<Session[]> {
  let sessions: Session[] = [];
  try {
    sessions = await extractAllSessions(flags);
  } catch (e) {
    console.error(`Warning: no session (${errMsg(e)}).`);
    return [];
  }
  if (sessions.length) {
    console.error(`Sessions ready (${sessions.length}): ${sessions.map((s) => s.label).join(', ')}`);
  } else {
    console.error('Warning: no signed-in workspace found.');
  }
  return sessions;
}

function printServerBanner(server: StartServerResult, hasSession: boolean): void {
  console.log('');
  console.log('sluice web UI listening on 127.0.0.1 (loopback only)');
  // The token rides in the URL FRAGMENT, not the page. The served document no
  // longer contains it (see server.ts injectConfig), so this tokenized URL — not
  // the bare host — is the way in. The fragment is never sent to the server, so
  // opening it discloses the token to nobody but this browser; a bare
  // `curl 127.0.0.1:<port>/` now gets a tokenless page.
  //
  // When the terminal is on, the SEPARATE pty secret rides the same fragment as
  // `&p=` — a second capability the read token cannot substitute for.
  const frag = server.ptyToken ? `#k=${server.token}&p=${server.ptyToken}` : `#k=${server.token}`;
  console.log(`  Open:   ${server.url}${frag}`);
  console.log(`  Token:  ${server.token}  (shown here only — not embedded in any served page)`);
  console.log(`  Dev UI: http://localhost:5273/${frag}  (with \`pnpm webapp:dev\`)`);
  if (!hasSession) {
    console.log('  Note:   no session yet — run `sluice extract-token` or pass --token/--cookie.');
  }
  console.log('');
  console.log('Press Ctrl-C to stop.');
}

/** Resolves after SIGINT/SIGTERM has run `onStop`. Keeps the daemon alive. */
function runUntilSignal(onStop: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      console.error('\nShutting down…');
      try {
        await onStop();
      } catch (e) {
        console.error(errMsg(e));
      }
      resolve();
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
  });
}

function parseParams(entries: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of entries ?? []) {
    const i = kv.indexOf('=');
    if (i < 0) throw new Error(`Bad --param "${kv}" (expected key=value)`);
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      net: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice doctor [--net] — check the local environment (no secrets printed).\n' +
        '  --net also runs the checks that touch the network: a round-trip through a\n' +
        '        running proxy, and the TLS-pinning probe. Off by default so doctor\n' +
        '        stays fast, offline-safe, and makes no outbound request you did not ask for.',
    );
    return 0;
  }

  let hardOk = true;
  let warned = false;
  const line = (ok: boolean, label: string, detail = ''): void =>
    console.log(`${ok ? 'ok ' : 'XX '} ${label}${detail ? `  — ${detail}` : ''}`);
  /**
   * An advisory check. Previously these printed `XX` but were never folded into
   * the summary, so the standard first run showed a red line above a green
   * "doctor: OK" — which trains people to ignore the output. `!!` says "worth
   * knowing, not fatal" and is reflected in the summary.
   */
  const warn = (ok: boolean, label: string, detail = ''): void => {
    if (!ok) warned = true;
    console.log(`${ok ? 'ok ' : '!! '} ${label}${detail ? `  — ${detail}` : ''}`);
  };

  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0');
  const nodeOk = nodeMajor >= 20;
  hardOk = hardOk && nodeOk;
  line(nodeOk, `Node ${process.version}`, nodeOk ? '' : 'need >= 20');

  const darwin = process.platform === 'darwin';
  warn(
    darwin,
    `Platform ${process.platform}`,
    darwin ? '' : 'token extraction is macOS-only; use --token/--cookie paste-in elsewhere',
  );

  // Per-app sign-in probe — passive (reads local config only; no Keychain, no
  // network) and non-fatal, driven entirely off each app's credential provider.
  // Apps that ship a credential provider but no `listWorkspaces` are reported as
  // unverifiable rather than skipped: silently omitting them meant a broken
  // Trello cookie produced a clean "doctor: OK" and only surfaced when a tool
  // failed much later.
  for (const app of apps) {
    if (!app.credentials) continue;
    const listWorkspaces = app.credentials.listWorkspaces;
    if (!listWorkspaces) {
      warn(false, `${app.displayName} sign-in`, 'cannot be checked — this app exposes no passive workspace probe');
      continue;
    }
    let names: string[] = [];
    try {
      names = (await listWorkspaces()).map((w) => w.name);
    } catch {
      /* passive — leave names empty */
    }
    warn(
      names.length > 0,
      `${app.displayName} sign-in`,
      names.length > 0 ? names.join(', ') : 'no signed-in workspace found (sign in or use --token/--cookie)',
    );
  }

  // Probe the package that actually OWNS mockttp. Importing the bare specifier
  // resolved from @sluice/runner, which does not declare it, so this always
  // reported "not installed" — while cli.ts had already loaded mockttp into this
  // very process via its static `@sluice/interceptor` import.
  let mockttpOk = false;
  let mockttpDetail = '';
  try {
    const mod = await import('@sluice/interceptor');
    mockttpOk = typeof mod.MitmEngine === 'function';
    if (!mockttpOk) mockttpDetail = '@sluice/interceptor loaded but exposes no MitmEngine';
  } catch (e) {
    mockttpDetail = `proxy engine unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
  warn(mockttpOk, 'MITM proxy engine available', mockttpDetail);

  // A stale system proxy is worse than a missing one: it silently routes all
  // HTTPS on the machine into a port nothing is listening on.
  if (darwin) {
    try {
      const service = await detectNetworkService();
      const st = await getProxyState(service);
      if (st.enabled && st.port !== undefined) {
        const live = await isPortListening(st.port, st.host);
        warn(
          live,
          'System proxy',
          live
            ? `enabled → ${st.host}:${st.port} (listening)`
            : `enabled → ${st.host}:${st.port} but NOTHING is listening. Run \`sluice proxy off\` or start Sluice.`,
        );
      }
    } catch {
      /* advisory only — never fail doctor on a proxy read */
    }
  }

  // ── CA trust ────────────────────────────────────────────────────────────────
  // "The CA exists" and "the CA is trusted" are different questions, and only the
  // second one determines whether capture works. Generating a CA and forgetting
  // to trust it presents as every HTTPS request failing once the proxy is on,
  // with nothing in the output pointing at the cause.
  const caPath = join(
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Sluice')
      : join(homedir(), '.sluice'),
    'ca',
    'sluice-ca.cert',
  );
  if (!existsSync(caPath)) {
    // This used to offer `sluice start` as an equivalent second option. It is
    // not one: start calls ensureSluiceCA(), which GENERATES the certificate and
    // stops there — trusting it is `ca-install`'s job alone. Following the old
    // advice left users with a CA on disk that no keychain trusts, which fails
    // every HTTPS request through the proxy while doctor still summarised OK.
    warn(
      false,
      'Local CA',
      'not generated yet — run `sluice ca-install`. (`sluice start` creates the certificate but does NOT trust it, and an untrusted CA fails every HTTPS request through the proxy.)',
    );
  } else if (darwin) {
    let trusted = false;
    try {
      // Exit 0 means the chain verifies for SSL, which is exactly the property
      // the proxy needs and is not implied by the file existing.
      execFileSync('/usr/bin/security', ['verify-cert', '-c', caPath, '-p', 'ssl'], {
        stdio: 'ignore',
      });
      trusted = true;
    } catch {
      trusted = false;
    }
    warn(
      trusted,
      'Local CA trusted',
      trusted ? caPath : `generated but NOT trusted — run \`sluice ca-install\` (${caPath})`,
    );
  } else {
    warn(true, 'Local CA', `${caPath} (trust check is macOS-only)`);
  }

  // ── Port availability ───────────────────────────────────────────────────────
  // A port already in use is the most common reason `sluice start` dies, and the
  // failure arrives as EADDRINUSE from deep inside a library rather than as
  // advice. Checking both up front turns that into one readable line.
  const cfgForPorts = fileConfig(undefined);
  for (const [label, port] of [
    ['web UI', cfgForPorts.port ?? config.DEFAULT_HTTP_PORT],
    ['MITM proxy', cfgForPorts.proxyPort ?? config.DEFAULT_PROXY_PORT],
  ] as Array<[string, number]>) {
    const busy = await isPortListening(port);
    if (!busy) {
      warn(true, `Port ${port} (${label})`, 'free');
      continue;
    }
    // Something is listening. If it is OUR runner, that is the healthy case.
    const state = readRunState();
    const ours = state?.port === port || state?.proxyPort === port;
    warn(
      ours,
      `Port ${port} (${label})`,
      ours ? 'in use by a running Sluice' : 'in use by another process — pass --port / --proxy-port',
    );
  }

  // ── Network probes (opt-in) ─────────────────────────────────────────────────
  if (values.net) {
    const proxyPort = cfgForPorts.proxyPort ?? config.DEFAULT_PROXY_PORT;
    if (!(await isPortListening(proxyPort))) {
      warn(false, 'Proxy round-trip', `nothing listening on ${proxyPort} — start \`sluice start\` first`);
    } else {
      const rt = await probeThroughProxy(proxyPort, 'https://example.com/');
      warn(rt.ok, 'Proxy round-trip', rt.ok ? `example.com → HTTP ${rt.status}` : rt.detail);

      // The TLS-pinning question the plan makes this the resolution mechanism
      // for: if Slack pinned its certificates, this call would fail through a
      // MITM proxy while succeeding directly. api.test is Slack's documented
      // unauthenticated no-op, so the probe carries no credential.
      const pinned = await probeThroughProxy(proxyPort, 'https://slack.com/api/api.test');
      warn(
        pinned.ok,
        'Slack TLS pinning',
        pinned.ok
          ? `not pinned — api.test answered HTTP ${pinned.status} through the proxy`
          : `api.test did NOT complete through the proxy (${pinned.detail}). Certificate pinning would look exactly like this.`,
      );
    }
  }

  const dbPath = values.db ?? config.defaultDbPath();
  let dbOk = true;
  try {
    config.ensureSluiceHome();
  } catch {
    dbOk = false;
  }
  hardOk = hardOk && dbOk;
  line(dbOk, 'DB directory writable', dbPath);

  console.log('');
  if (!hardOk) console.log('doctor: problems found');
  else if (warned) console.log('doctor: OK (with warnings above)');
  else console.log('doctor: OK');
  return hardOk ? 0 : 1;
}

/**
 * Fetch a URL THROUGH a local proxy, reporting rather than throwing.
 *
 * Uses `fetch` with a dispatcher only when undici exposes one; otherwise it
 * falls back to a raw CONNECT, because the point of the probe is to work on the
 * Node the user actually has rather than to be elegant.
 */
async function probeThroughProxy(
  proxyPort: number,
  url: string,
): Promise<{ ok: boolean; status?: number; detail: string }> {
  const { request } = await import('node:https');
  const { connect } = await import('node:net');
  const target = new URL(url);

  return new Promise((resolve) => {
    const done = (r: { ok: boolean; status?: number; detail: string }): void => resolve(r);
    const socket = connect({ port: proxyPort, host: config.LOOPBACK_HOST }, () => {
      socket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`);
    });
    socket.setTimeout(10_000, () => {
      socket.destroy();
      done({ ok: false, detail: 'timed out' });
    });
    socket.once('error', (e) => done({ ok: false, detail: e.message }));
    socket.once('data', (chunk: Buffer) => {
      if (!/^HTTP\/1\.[01] 200/.test(chunk.toString('utf8'))) {
        socket.destroy();
        done({ ok: false, detail: `proxy refused CONNECT: ${chunk.toString('utf8').split('\r\n')[0]}` });
        return;
      }
      const req = request(
        {
          // `createConnection` rather than `socket`: the tunnel is already open,
          // and this is the typed way to hand an existing socket to https.request.
          createConnection: () => socket as unknown as ReturnType<typeof connect>,
          agent: false,
          servername: target.hostname,
          host: target.hostname,
          path: target.pathname,
          method: 'GET',
          // The proxy presents the LOCAL CA, which Node does not trust by
          // default even when the OS does. Accepting it here is the point of the
          // probe — we are testing reachability through the proxy, not the CA.
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          res.once('end', () => {
            socket.destroy();
            done({ ok: true, status: res.statusCode, detail: '' });
          });
        },
      );
      req.once('error', (e) => {
        socket.destroy();
        done({ ok: false, detail: e.message });
      });
      req.end();
    });
  });
}

async function cmdExtractToken(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      adapter: { type: 'string' },
      token: { type: 'string' },
      cookie: { type: 'string' },
      'app-support': { type: 'string' },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice extract-token [--adapter ID] [--token X --cookie Y] [--app-support DIR] [--db PATH]\n' +
        '  Read your local session and print a REDACTED summary. The token/cookie are\n' +
        '  never printed and never written to disk (only a RedactedSession is stored).\n' +
        '  --adapter scopes extraction to one app, so only that app prompts the Keychain.',
    );
    return 0;
  }

  if (values.adapter && !apps.some((a) => a.id === values.adapter)) {
    console.error(`Unknown adapter "${values.adapter}". Installed: ${apps.map((a) => a.id).join(', ')}`);
    return 1;
  }

  let session: Session;
  try {
    session = await acquireSession(values, values.adapter);
  } catch (e) {
    console.error(`extract-token failed: ${errMsg(e)}`);
    if (process.platform !== 'darwin') {
      console.error(
        'Extraction reads the macOS Keychain + the app\'s local store and only works on macOS. Use --token/--cookie paste-in.',
      );
    } else {
      console.error(
        'Make sure the desktop app is installed and you are signed in, or use --token/--cookie paste-in.',
      );
    }
    return 1;
  }

  const store = openStore(values.db);
  const redacted = redactSession(session);
  store.upsertSession(redacted);
  store.close();

  console.log('Extracted a live session (held in memory only; NOT written to disk):');
  console.log(`  id:              ${redacted.id}`);
  console.log(`  adapter:         ${redacted.adapterId}`);
  console.log(`  label:           ${redacted.label}`);
  console.log(`  workspaceId:     ${redacted.workspaceId ?? '(unknown)'}`);
  console.log(`  source:          ${redacted.source}`);
  console.log(`  credentialKinds: ${redacted.credentialKinds.join(', ')}`);
  console.log('');
  console.log('The token and cookie were not printed and not persisted.');
  console.log('Run `sluice serve` or `sluice start` to reconstruct + browse this session.');
  return 0;
}

/**
 * A SystemProxyOps over the macOS proxy helpers, for the EngineController.
 *
 * The network service is detected once and cached. `ours` compares the enabled
 * proxy against OUR loopback port, so the controller only ever clears a proxy it
 * actually set — never one the user configured for something else.
 */
function makeProxyOps(ourPort: number): import('./engine-controller.js').SystemProxyOps {
  let service: string | undefined;
  const svc = async (): Promise<string> => (service ??= await detectNetworkService());
  return {
    async on(port) {
      await setProxy(await svc(), config.LOOPBACK_HOST, port);
    },
    async off() {
      await clearProxy(await svc());
    },
    async state() {
      try {
        const st = await getProxyState(await svc());
        const ours =
          st.enabled &&
          (st.host === config.LOOPBACK_HOST || st.host === 'localhost') &&
          st.port === ourPort;
        return { supported: true, enabled: st.enabled, host: st.host, port: st.port, ours };
      } catch (e) {
        return { supported: false, enabled: false, ours: false, detail: errMsg(e) };
      }
    },
  };
}

/**
 * Build an EngineController wired to a (not-yet-created) server, plus the setters
 * that finish the wiring once the server exists.
 *
 * The forward-ref is unavoidable: the controller's engine needs the server's
 * `ingest`/`broadcastEngineStatus`, and the server needs the controller as its
 * `control` hooks. The mutable closures are assigned in one place immediately
 * after `startServer` returns.
 */
/**
 * How to spawn the isolated capture engine (§S1). Under tsx (dev) the child is a
 * `.ts` run through the same loader; from a bundle it is the sibling
 * `engine-child.js` run by plain node. Either way the command is `node` — never a
 * shell — and the child module path is derived from this file's own URL.
 */
function childEngineCommand(): { command: string; args: string[] } {
  const dev = import.meta.url.endsWith('.ts');
  const child = fileURLToPath(new URL(dev ? './engine-child.ts' : './engine-child.js', import.meta.url));
  return { command: process.execPath, args: dev ? ['--import', 'tsx', child] : [child] };
}

function makeController(opts: {
  proxyPort: number;
  adapters: App[];
  interceptHosts: string[];
  interceptAllHosts: boolean;
  /** Run the engine in an isolated child process (§S1). */
  isolated?: boolean;
}): {
  controller: EngineController;
  wire: (server: StartServerResult) => void;
} {
  let ingest: (c: Capture) => void = () => {};
  let publishStatus: (s: EngineStatus) => void = () => {};
  let publishEnv: () => void = () => {};

  const onCapture = (c: Capture): void => {
    try {
      ingest(c);
    } catch (e) {
      console.error(`ingest error: ${errMsg(e)}`);
    }
  };

  const buildEngine = (): EngineHandle => {
    if (opts.isolated) {
      // MitmEngine derives its TLS intercept list from adapter hostnames, so the
      // child needs only the flattened host list — not the adapter objects, which
      // do not cross a process boundary. Attribution + parse happen on ingest.
      const hosts = [...opts.adapters.flatMap((a) => a.hosts), ...opts.interceptHosts];
      const { command, args } = childEngineCommand();
      return new ChildEngine({
        command,
        args,
        env: {
          SLUICE_CHILD_PORT: String(opts.proxyPort),
          SLUICE_CHILD_HOSTS: hosts.join(','),
          SLUICE_CHILD_ALL_HOSTS: opts.interceptAllHosts ? '1' : '0',
        },
        onCapture,
        onStatus: (s) => publishStatus(s),
        onError: (e) => console.error(`engine error: ${errMsg(e)}`),
      });
    }
    return new MitmEngine({
      port: opts.proxyPort,
      adapters: opts.adapters,
      onCapture,
      onError: (e) => console.error(`engine error: ${errMsg(e)}`),
      onStatus: (s) => publishStatus(s),
      interceptHosts: opts.interceptHosts,
      interceptAllHosts: opts.interceptAllHosts,
    });
  };

  const controller = new EngineController({
    buildEngine,
    supervise: (engine, onStatus, port) =>
      superviseEngine({ engine, healthy: () => isPortListening(port), onStatus }),
    proxy: makeProxyOps(opts.proxyPort),
    onStatus: (s) => publishStatus(s),
    onEnvironment: () => publishEnv(),
    caInfo: () => {
      const path = sluiceCaCertPath();
      return { generated: existsSync(path), path: existsSync(path) ? path : undefined };
    },
  });

  const wire = (server: StartServerResult): void => {
    ingest = server.ingest;
    publishStatus = server.broadcastEngineStatus;
    publishEnv = () => void server.broadcastEnvironment();
  };
  return { controller, wire };
}

async function cmdServe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      'proxy-port': { type: 'string' },
      db: { type: 'string' },
      token: { type: 'string' },
      cookie: { type: 'string' },
      host: { type: 'string', multiple: true },
      'all-hosts': { type: 'boolean' },
      'app-support': { type: 'string' },
      config: { type: 'string' },
      isolated: { type: 'boolean' },
      ingest: { type: 'boolean' },
      terminal: { type: 'boolean' },
      'terminal-cwd': { type: 'string' },
      'terminal-model': { type: 'string' },
      'terminal-effort': { type: 'string' },
      'terminal-mcp': { type: 'string' },
      'terminal-no-mcp': { type: 'boolean' },
      'terminal-skip-permissions': { type: 'boolean' },
      'terminal-bin': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice serve [--port N] [--proxy-port N] [--db PATH] [--host H]... [--all-hosts] [--isolated] [--token X --cookie Y]\n' +
        '  Serves the dashboard. The engine starts IDLE — start/stop capture and the\n' +
        '  system proxy from the dashboard (or use `sluice start` to bring both up now).\n' +
        '\n' +
        '  --isolated               Run the capture engine in a separate process, so a\n' +
        '                           crash in the proxy cannot take the runner down; the\n' +
        '                           supervisor respawns it. Off by default (in-process).\n' +
        '  --ingest                 Accept passive captures from the MV3 browser extension\n' +
        '                           at POST /api/ingest (its own secret; prints below).\n' +
        '\n' +
        '  --terminal               Enable the embedded Claude Code terminal (OFF by default).\n' +
        '                           Launches ONLY `claude` (never a shell), with normal\n' +
        '                           permission prompting. Seeds the session with Sluice\n' +
        '                           context and auto-wires the Sluice MCP tools against this\n' +
        '                           store, so it can assess your captured traffic on request.\n' +
        '  --terminal-cwd DIR       Directory claude runs in (default: current dir).\n' +
        '  --terminal-model M       Model (default: claude-opus-4-8).\n' +
        '  --terminal-effort L      low|medium|high|xhigh|max (default: max).\n' +
        '  --terminal-mcp FILE      Use this MCP config instead of the auto-wired Sluice one.\n' +
        '  --terminal-no-mcp        Do not wire any MCP server (context prompt still seeded).\n' +
        '  --terminal-skip-permissions  Launch with --dangerously-skip-permissions (NO prompts).\n' +
        '                           Off by default; only for a dir/account you fully trust.\n' +
        '  --terminal-bin PATH      Path to the claude binary (default: found on PATH).',
    );
    return 0;
  }

  const cfg = fileConfig(values.config);
  const port = parsePort(values.port, cfg.port ?? config.DEFAULT_HTTP_PORT);
  const proxyPort = parsePort(values['proxy-port'], cfg.proxyPort ?? config.DEFAULT_PROXY_PORT);
  const store = openStore(resolveDb(values.db, values.config));
  applyRetention(store, values.config);
  await seedWorkspaces(store, values['app-support']);
  materializeQuiet(store);
  // BEFORE `selectApps`, because an external adapter's hosts widen the proxy's
  // TLS-intercept list — the single most privacy-relevant thing loading one
  // does. `describeDiscovery` prints those hosts, so the widening is stated
  // every time rather than left in a config file someone edited months ago.
  for (const line of describeDiscovery(await installExternalAdapters())) console.error(line);
  const adapters = selectApps(values.config);
  const sessions = await bestEffortSessions(values);
  for (const s of sessions) store.upsertSession(redactSession(s));

  const { controller, wire } = makeController({
    proxyPort,
    adapters,
    interceptHosts: [...(cfg.interceptHosts ?? []), ...(values.host ?? [])],
    interceptAllHosts: Boolean(values['all-hosts']),
    isolated: Boolean(values.isolated),
  });

  // The embedded terminal is strictly opt-in. Building the hooks here (not in
  // server.ts) is what keeps node-pty out of every mode that does not use it, and
  // keeps the launcher's fixed argv next to the flags that shape it.
  let terminal: TerminalHooks | undefined;
  if (values.terminal) {
    const cwd = resolve(values['terminal-cwd'] ?? process.cwd());
    try {
      terminal = makeClaudeTerminal({
        cwd,
        model: values['terminal-model'],
        effort: values['terminal-effort'] as Effort | undefined,
        mcpConfig: values['terminal-mcp'] ? resolve(values['terminal-mcp']) : undefined,
        wireSluiceMcp: !values['terminal-no-mcp'],
        skipPermissions: Boolean(values['terminal-skip-permissions']),
        binPath: values['terminal-bin'],
        // So the embedded session knows WHERE the captures are and WHICH apps are
        // in scope — the whole point of "assess the traffic I just caught".
        dbPath: store.db.name,
        appNames: adapters.map((a) => a.displayName),
      });
    } catch (e) {
      console.error(`Cannot enable --terminal: ${errMsg(e)}`);
      return 1;
    }
  }

  const server = await startServer({
    store,
    adapters,
    port,
    getSessions: () => sessions,
    engine: controller,
    control: controller,
    terminal,
    ingest: Boolean(values.ingest),
  });
  wire(server);
  printServerBanner(server, sessions.length > 0);
  if (server.ingestToken) {
    console.log('');
    console.log('  Extension ingest ENABLED — POST /api/ingest');
    console.log(`    Ingest token: ${server.ingestToken}`);
    console.log('    Paste it (and this URL) into the Sluice browser extension\'s options.');
  }
  if (terminal) {
    console.log('');
    console.log('  ⚠ Terminal ENABLED — the dashboard can launch an interactive Claude Code');
    console.log(`    session: ${terminal.describe()}`);
    console.log('    It runs as you, and the session persists across reloads (re-attaches).');
    if (values['terminal-skip-permissions']) {
      console.log('  ⛔ SKIP-PERMISSIONS is ON — the session runs --dangerously-skip-permissions');
      console.log('     and will NOT prompt before editing files or running commands. Only leave');
      console.log('     this on for a directory and account you fully trust.');
    }
  }
  console.log('  Capture: idle — start it from the dashboard (Control), or run `sluice start`.');
  writeRunState({ pid: process.pid, port, db: store.db.name, mode: 'serve', startedAt: Date.now(), proxyPort });

  await runUntilSignal(async () => {
    clearRunState();
    // Route shutdown through the controller so a UI-set system proxy is restored
    // even in serve mode (cmdStart's cleanup does its own restore).
    await controller.shutdown();
    await server.close();
    store.close();
  });
  return 0;
}

async function cmdStart(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      'proxy-port': { type: 'string' },
      db: { type: 'string' },
      token: { type: 'string' },
      cookie: { type: 'string' },
      'app-support': { type: 'string' },
      config: { type: 'string' },
      host: { type: 'string', multiple: true },
      'all-hosts': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log('sluice start [--port N] [--proxy-port N] [--db PATH] [--token X --cookie Y]');
    console.log('             [--host HOSTNAME]…   also decrypt these hosts (repeatable, wildcards ok)');
    console.log('             [--all-hosts]        decrypt everything, not just the adapters\' hosts');
    return 0;
  }

  const cfg = fileConfig(values.config);
  const port = parsePort(values.port, cfg.port ?? config.DEFAULT_HTTP_PORT);
  const proxyPort = parsePort(values['proxy-port'], cfg.proxyPort ?? config.DEFAULT_PROXY_PORT);
  const store = openStore(resolveDb(values.db, values.config));
  applyRetention(store, values.config);
  await seedWorkspaces(store, values['app-support']);
  materializeQuiet(store);
  const adapters = selectApps(values.config);
  const sessions = await bestEffortSessions(values);
  for (const s of sessions) store.upsertSession(redactSession(s));

  // The engine needs onCapture/onStatus at construction, but both funnels live in
  // the server (built next). Forward-reference them through mutable closures.
  let ingest: (c: Capture) => void = () => {};
  let publishStatus: (s: EngineStatus) => void = () => {};
  const engine = new MitmEngine({
    port: proxyPort,
    adapters,
    onCapture: (c) => {
      try {
        ingest(c);
      } catch (e) {
        console.error(`ingest error: ${errMsg(e)}`);
      }
    },
    onError: (e) => console.error(`engine error: ${errMsg(e)}`),
    onStatus: (s) => publishStatus(s),
    interceptHosts: [...(cfg.interceptHosts ?? []), ...(values.host ?? [])],
    interceptAllHosts: values['all-hosts'] ?? cfg.interceptAllHosts ?? false,
  });

  const server = await startServer({
    store,
    adapters,
    port,
    getSessions: () => sessions,
    engine,
  });
  ingest = server.ingest;
  publishStatus = server.broadcastEngineStatus;

  /** Restarts the engine if it stops answering; see packages/interceptor/supervisor.ts. */
  let supervisor: Supervisor | undefined;

  try {
    const started = await engine.start();
    console.log('');
    console.log('MITM proxy engine started (Engine A).');
    console.log(`  Proxy:   127.0.0.1:${started.port}`);
    console.log(`  CA cert: ${started.caPath}`);
    // Which hosts get decrypted is the single most privacy-relevant thing this
    // command does, so it is stated rather than left to the source.
    const scoped = engine.interceptedHosts();
    if (scoped === undefined) {
      console.log('  Decrypting: EVERY host (--all-hosts). Unrelated traffic will be stored.');
    } else if (scoped.length === 0) {
      console.log('  Decrypting: nothing — no adapters are installed and no --host was given.');
    } else {
      console.log(`  Decrypting: ${scoped.join(', ')}`);
      console.log('              everything else is tunnelled through unread. Add --host to widen.');
    }
    console.log('  Trust the CA (macOS, reversible, SSL-only, no sudo):');
    console.log(
      `    security add-trusted-cert -r trustRoot -p ssl -k "$HOME/Library/Keychains/login.keychain-db" "${started.caPath}"`,
    );
    const appName = apps[0]?.displayName ?? 'the app';
    console.log(`  Route the ${appName} desktop app through it (fully quit ${appName} first):`);
    console.log(
      `    open -a ${appName} --args --proxy-server=127.0.0.1:${started.port} --proxy-bypass-list="<-loopback>"`,
    );
    // Supervision starts only once the engine is genuinely up, so a start that
    // failed is reported as a failed start rather than as the first of five
    // restart attempts.
    supervisor = superviseEngine({
      engine,
      // The only detector available. mockttp swallows post-start server errors
      // and exposes no server-level event, so "is anything still listening?" is
      // what there is — it cannot tell a dead listener from a wedged one, and
      // it does catch the case that actually happens, which is the port going
      // away underneath a session nobody is watching.
      healthy: () => isPortListening(started.port),
      onStatus: (st) => publishStatus?.(st),
    });
  } catch (e) {
    console.error(`Failed to start the MITM engine: ${errMsg(e)}`);
    console.error('Run `sluice doctor` to check the environment. The web UI + replay still work without it.');
  }

  printServerBanner(server, sessions.length > 0);
  writeRunState({ pid: process.pid, port, db: store.db.name, mode: 'start (mitm)', startedAt: Date.now(), proxyPort });

  await runUntilSignal(async () => {
    clearRunState();
    // Before the engine: otherwise a deliberate shutdown looks exactly like a
    // crash to the probe, and the supervisor restarts what is being torn down.
    supervisor?.stop();
    try {
      await engine.stop();
    } catch {
      /* already stopped */
    }
    // If this process pointed the system proxy at itself, put it back. Leaving
    // it set sends ALL of the machine's HTTPS to a port that just closed, which
    // looks like the network is broken rather than like Sluice exited.
    await restoreSystemProxyIfOurs(proxyPort);
    await server.close();
    reconcileAll(store);
    store.close();
  });
  return 0;
}

/**
 * Clear the macOS system proxy if — and only if — it currently points at the
 * loopback port this process was serving. We never touch a proxy somebody else
 * configured.
 */
async function restoreSystemProxyIfOurs(proxyPort: number): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    const service = await detectNetworkService();
    const st = await getProxyState(service);
    if (!st.enabled) return;
    const ours = st.port === proxyPort && (st.host === config.LOOPBACK_HOST || st.host === 'localhost');
    if (!ours) return;
    await clearProxy(service);
    console.log(`Restored the system proxy (was pointing at ${st.host}:${st.port}).`);
  } catch (e) {
    console.error(
      `Warning: could not restore the system proxy — run \`sluice proxy off\`. (${errMsg(e)})`,
    );
  }
}

async function cmdCapture(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      'cdp-port': { type: 'string' },
      url: { type: 'string' },
      db: { type: 'string' },
      headless: { type: 'boolean' },
      'chrome-profile': { type: 'string' },
      'no-launch': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice capture [--url URL] [--cdp-port 9222] [--port 7788] [--headless] [--no-launch] [--db PATH]\n' +
        '  Passively capture your browser\'s API traffic via Chrome DevTools.\n' +
        '  No proxy, no CA cert, no Keychain — it only OBSERVES the traffic the page already makes.',
    );
    return 0;
  }

  const port = parsePort(values.port, config.DEFAULT_HTTP_PORT);
  const cdpPort = parsePort(values['cdp-port'], config.DEFAULT_CDP_PORT);
  const startUrl = values.url ?? defaultCaptureUrl();
  const profileDir = values['chrome-profile'] ?? defaultChromeProfileDir();
  const store = openStore(values.db);
  await seedWorkspaces(store);
  const adapters = apps;

  // Passive capture needs NO credentials — nothing here touches the Keychain.
  const server = await startServer({ store, adapters, port, getSessions: () => [] });

  let chrome: LaunchedChrome | undefined;
  if (values['no-launch']) {
    console.log(`Attaching to an existing Chrome on debug :${cdpPort} (start it with --remote-debugging-port=${cdpPort}).`);
  } else {
    try {
      chrome = await launchDebugChrome({
        port: cdpPort,
        startUrl,
        headless: Boolean(values.headless),
        userDataDir: profileDir,
      });
      console.log(`Launched a dedicated Chrome (debug :${cdpPort}, profile ${profileDir}).`);
    } catch (e) {
      console.error(`Failed to launch Chrome: ${errMsg(e)}`);
      await server.close();
      store.close();
      return 1;
    }
  }

  const engine = new CdpEngine({
    port: cdpPort,
    adapters,
    onCapture: (c) => {
      try {
        server.ingest(c);
      } catch (e) {
        console.error(`ingest error: ${errMsg(e)}`);
      }
    },
    onError: (e) => console.error(`engine error: ${errMsg(e)}`),
    // This engine stops itself when the attached tab closes, so pushing the
    // transition is the only way the UI (and the user) find out.
    onStatus: (s) => {
      server.broadcastEngineStatus(s);
      if (s.state === 'stopped' || s.state === 'error') {
        console.error(`capture engine ${s.state}${s.detail ? `: ${s.detail}` : ''}`);
      }
    },
  });

  try {
    await engine.start();
    console.log('Passive CDP capture running (Engine C) — Sluice makes ZERO requests on your behalf.');
  } catch (e) {
    console.error(`Failed to attach CDP: ${errMsg(e)}`);
    console.error('Chrome may still be starting, or was not launched with the debug port.');
  }

  printServerBanner(server, false);
  writeRunState({ pid: process.pid, port, db: store.db.name, mode: 'capture (cdp)', startedAt: Date.now() });
  console.log('Log into the app in the launched Chrome window, then click around — captures stream live into the UI.');

  await runUntilSignal(async () => {
    try {
      await engine.stop();
    } catch {
      /* already stopped */
    }
    chrome?.close();
    await server.close();
    reconcileAll(store);
    store.close();
  });
  return 0;
}

// ── the cursor worklist drainer (`sluice replay --all`) ──────────────────────

/** How many claims to take per round trip. Small enough that a Ctrl-C strands little. */
const CLAIM_BATCH = 25;

interface DrainFlags extends CredFlags {
  db?: string;
  adapter?: string;
  container?: string;
  'dry-run'?: boolean;
}

/**
 * Describe a claimed item. Deliberately says nothing about `reason` or `depth`,
 * even though `WorkItem` declares both: the `cursors` table has no column for
 * either, so every item read back from the store carries them as undefined.
 * Printing "depth 0" for a page five hops deep is worse than not printing it.
 */
function describeWorkItem(w: WorkItem): string {
  const bits = [w.adapterId, w.actionId];
  if (w.containerId) bits.push(`container=${w.containerId}`);
  if (w.cursor) bits.push(`cursor=${w.cursor.slice(0, 16)}${w.cursor.length > 16 ? '…' : ''}`);
  return bits.join('  ');
}

/**
 * Say what the worklist holds, in a way that distinguishes "drained" from "broken".
 *
 * Worth its own function because an empty worklist is the NORMAL result today:
 * cursor seeds are produced by `nextCursors` on a replayed response, and passive
 * capture does not enqueue any. Printing nothing at all would read as a hang or
 * a silently swallowed error.
 */
function reportWorklist(store: SqliteStore): void {
  const c = store.countCursors();
  console.log(
    `Worklist: ${c.pending} pending, ${c.running} running, ${c.done} done, ${c.failed} failed.`,
  );
  if (c.pending + c.running === 0) {
    console.log('Nothing to replay — the cursor worklist is empty.');
    console.log(
      'Work is enqueued when a replayed response names more pages, so an empty\n' +
        'worklist straight after passive capture is expected, not a fault.',
    );
  }
}

/**
 * Drain the `cursors` worklist: claim → replay → ingest → settle, until it is
 * empty or the replay rails refuse.
 *
 * The pieces existed and nothing joined them — §F1 built the table, §F2's
 * `nextCursors` fills it, and until now nothing took work off it, so a paginated
 * capture stopped at page one forever.
 */
async function drainCursors(flags: DrainFlags, adapters: typeof apps): Promise<number> {
  const store = openStore(flags.db);
  const wantContainer = flags.container;

  if (flags['dry-run']) {
    reportWorklist(store);
    // Filtered exactly as the real drain filters — by `--adapter` (which is what
    // `claimCursors` takes) and by `--container`, and by nothing else. A dry run
    // that quietly hid work the real run would attempt is worse than no dry run.
    const pending = store
      .listCursors({ state: 'pending', limit: 10_000 })
      .filter((w) => !flags.adapter || w.adapterId === flags.adapter)
      .filter((w) => !wantContainer || w.containerId === wantContainer);
    store.close();
    if (pending.length === 0) {
      if (wantContainer || flags.adapter) console.log('Nothing pending matches that filter.');
      return 0;
    }
    console.log(`\nWould replay ${pending.length} item(s) — nothing was claimed:`);
    for (const w of pending) console.log(`  ${describeWorkItem(w)}`);
    return 0;
  }

  // A drainer killed mid-flight leaves its claims `running`, and nothing else
  // ever returns them; without this the worklist looks permanently busy.
  const released = store.releaseStaleCursors();
  if (released > 0) console.error(`Released ${released} stranded claim(s) from an earlier run.`);
  reportWorklist(store);

  // Sessions are cached per adapter — and so are FAILURES. Re-extracting per work
  // item would raise one Keychain consent prompt per page.
  const sessions = new Map<string, Session | undefined>();
  const sessionFor = async (adapterId: string): Promise<Session | undefined> => {
    if (sessions.has(adapterId)) return sessions.get(adapterId);
    let session: Session | undefined;
    try {
      session = await acquireSession(flags, adapterId);
    } catch (e) {
      console.error(`No ${adapterId} session (${errMsg(e)}) — leaving its work queued.`);
    }
    sessions.set(adapterId, session);
    return session;
  };

  let replayed = 0;
  let failed = 0;
  let skipped = 0;
  let queued = 0;
  let denied: ReplayDeniedError | undefined;

  drain: while (true) {
    const batch = store.claimCursors(CLAIM_BATCH, flags.adapter);
    if (batch.length === 0) break;

    for (const item of batch) {
      // Skipped items stay `running` and are returned to the worklist below —
      // the store has no per-item release, and marking work "done" that was never
      // attempted would lose the page.
      if (wantContainer && item.containerId !== wantContainer) {
        skipped += 1;
        continue;
      }
      const adapter = adapters.find((a) => a.id === item.adapterId);
      if (!adapter) {
        store.completeCursor(item.id, `no installed adapter "${item.adapterId}"`);
        failed += 1;
        console.error(`  skip: ${describeWorkItem(item)} — no such adapter`);
        continue;
      }
      const action = adapter.listReplayActions().find((a) => a.id === item.actionId);
      if (!action) {
        store.completeCursor(item.id, `unknown action "${item.actionId}"`);
        failed += 1;
        console.error(`  skip: ${describeWorkItem(item)} — no such replay action`);
        continue;
      }
      // Deliberately after both lookups: a seed nothing can resolve is settled
      // without ever asking the OS for a credential.
      const session = await sessionFor(adapter.id);
      if (!session) {
        skipped += 1;
        continue;
      }

      try {
        const params: Record<string, string> = {};
        for (const p of action.params) if (p.default != null) params[p.name] = p.default;
        Object.assign(params, item.params ?? {});
        // The cursor and the container live on the WorkItem, not in `params`;
        // find where THIS action wants them rather than assuming the names.
        const cursorParam = action.params.find((p) => p.kind === 'cursor');
        if (item.cursor && cursorParam) params[cursorParam.name] = item.cursor;
        const containerParam = action.params.find((p) => p.kind === 'containerId');
        if (item.containerId && containerParam && params[containerParam.name] === undefined) {
          params[containerParam.name] = item.containerId;
        }

        const req = faithfulReplayRequest(store, adapter.buildReplayRequest(action, params, session));
        const capture = await runReplay(req); // secret-redacted Capture
        capture.adapterId = adapter.id; // attribute so the Cartographer + stats include it
        store.insertCapture(capture);
        const counts = store.applyParseResult(adapter.parse(capture), capture.ts || Date.now());

        // The follow-on pages. Without this the drain replays one page and stops:
        // nothing else in the CLI feeds the worklist.
        //
        // No depth bound here, and that is not an oversight. `CursorSeed.depth`
        // has no column in the `cursors` table, so it does not survive a claim —
        // any hop counter written here would read back as undefined and bound
        // nothing while looking like it did. What actually bounds the drain is
        // real: `enqueueCursors` dedupes on (adapter, action, container, cursor)
        // across every state, so a page is enqueued at most once ever, and
        // `replayBudget` refuses long before a runaway fan-out could matter.
        const added = store.enqueueCursors(adapter.nextCursors?.(capture) ?? []);
        queued += added;

        const apiErr = apiErrorText(capture);
        store.completeCursor(item.id, apiErr ?? undefined);
        if (apiErr) failed += 1;
        else replayed += 1;
        console.error(
          `  ${item.actionId}${item.containerId ? ` ${item.containerId}` : ''}` +
            `  HTTP ${capture.status ?? '?'}${apiErr ? ` (${apiErr})` : ''}` +
            `  +${counts.items} item(s), +${added} queued`,
        );
      } catch (e) {
        if (e instanceof ReplayDeniedError) {
          denied = e;
          // The budget refills; a rails denial never does. So a spent budget
          // leaves the item claimed (released just below, back to pending) while
          // a refused request is settled — re-queuing it would loop forever
          // against a check that will always say no.
          if (e.code !== 'rate_budget_exhausted') {
            store.completeCursor(item.id, `[${e.code}] ${errMsg(e)}`);
            failed += 1;
          }
          break drain;
        }
        store.completeCursor(item.id, errMsg(e));
        failed += 1;
        console.error(`  ${item.actionId}: ${errMsg(e)}`);
      }
    }
  }

  const stranded = store.releaseStaleCursors();
  store.close();

  console.log(
    `Drained: ${replayed} replayed, ${failed} failed, ${skipped} skipped; ${queued} new page(s) queued.`,
  );
  if (stranded > 0) console.log(`Returned ${stranded} unfinished item(s) to the worklist.`);
  if (denied) {
    console.error(`Stopped: [${denied.code}] ${errMsg(denied)}`);
    if (denied.code === 'rate_budget_exhausted') {
      console.error('The replay budget refills — re-run `sluice replay --all` to continue.');
      return 0;
    }
    console.error('That seed asks for something the replay rails refuse; it is marked failed.');
    return 1;
  }
  return 0;
}

async function cmdReplay(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      action: { type: 'string' },
      flow: { type: 'string' },
      param: { type: 'string', multiple: true },
      adapter: { type: 'string' },
      container: { type: 'string' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      db: { type: 'string' },
      token: { type: 'string' },
      cookie: { type: 'string' },
      'app-support': { type: 'string' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice replay <actionId> [--param k=v ...] [--adapter ID] [--token X --cookie Y] [--db PATH]\n' +
        'sluice replay --flow <templateId|primaryKey> [--param k=v ...] [--adapter ID] [--db PATH]\n' +
        'sluice replay --list [--adapter ID]   list available replay actions\n' +
        'sluice replay --all [--container ID] [--adapter ID] [--dry-run]\n' +
        '  Drain the cursor worklist: replay every queued page, ingest it, and queue\n' +
        '  whatever it names next. --dry-run prints what it would replay and claims\n' +
        '  nothing. Stops cleanly when the replay budget is spent.\n' +
        '  --flow runs a learned multi-step template (see `sluice learn-flows`).',
    );
    return 0;
  }

  const adapters = values.adapter ? apps.filter((a) => a.id === values.adapter) : apps;
  if (values.adapter && adapters.length === 0) {
    console.error(`Unknown adapter "${values.adapter}". Installed: ${apps.map((a) => a.id).join(', ')}`);
    return 1;
  }

  if (values.all) {
    if (values.action ?? positionals[0]) {
      console.error('Pass either an action id or --all, not both.');
      return 1;
    }
    return drainCursors(values, adapters);
  }

  if (values.list) {
    for (const a of adapters) {
      for (const act of a.listReplayActions()) {
        console.log(`${act.id}  [${act.method}] ${act.label}`);
        for (const p of act.params) {
          console.log(`    --param ${p.name}=<${p.kind}>${p.required ? ' (required)' : ''}`);
        }
      }
    }
    return 0;
  }

  if (values.flow) {
    if (values.all || values.list || values.action || positionals[0]) {
      console.error('Pass --flow alone (with --param / --adapter / --db), not with an action id or --all.');
      return 1;
    }
    let params: Record<string, string>;
    try {
      params = parseParams(values.param);
    } catch (e) {
      console.error(errMsg(e));
      return 1;
    }
    const store = openStore(values.db);
    try {
      let tmpl = store.getFlowTemplate(values.flow);
      if (!tmpl && values.adapter) {
        tmpl = store.getFlowTemplateByPrimary(values.adapter, values.flow);
      }
      if (!tmpl) {
        // try primaryKey match across adapters when unique
        const hits = store.listFlowTemplates({ primaryKey: values.flow, limit: 5 });
        if (hits.length === 1) tmpl = hits[0];
        else if (hits.length > 1) {
          console.error(
            `Ambiguous primaryKey "${values.flow}". Pass --adapter. Matches: ${hits
              .map((h) => `${h.adapterId}:${h.id}`)
              .join(', ')}`,
          );
          return 1;
        }
      }
      if (!tmpl) {
        console.error(`Unknown flow template "${values.flow}". Run \`sluice learn-flows\` or \`sluice flows list\`.`);
        return 1;
      }
      const app = apps.find((a) => a.id === tmpl!.adapterId);
      if (!app) {
        console.error(`No installed app for adapter "${tmpl.adapterId}".`);
        return 1;
      }
      let session: Session;
      try {
        session = await acquireSession(values, app.id);
      } catch (e) {
        console.error(`No session: ${errMsg(e)}`);
        return 1;
      }
      const result = await runFlowReplay({
        template: tmpl,
        params,
        session,
        io: {
          build: (step, s, ctx) =>
            buildFlowStepRequest(tmpl!, step, s, {
              params: ctx.params,
              priorResponses: ctx.priorResponses,
              resolvePath: resolveJsonPath,
              allowedHosts: app.hosts,
            }),
          run: (req) => runReplay(req),
          record: (c) => {
            c.adapterId = app.id;
            store.insertCapture(c);
            store.applyParseResult(app.parse(c), c.ts || Date.now());
          },
        },
      });
      if (result.flow) {
        try {
          store.upsertFlow(result.flow);
        } catch {
          /* best-effort */
        }
      }
      console.log(
        `flow ${tmpl.primaryKey}: ${result.ok ? 'ok' : 'FAILED'}${result.error ? ` — ${result.error}` : ''}`,
      );
      if (result.flow?.id) console.log(`parent flow id: ${result.flow.id}`);
      for (const s of result.steps) {
        console.log(
          `  [${s.seq}] ${s.status.padEnd(9)} ${s.method} ${s.path}${s.operation ? ` (${s.operation})` : ''}` +
            `${s.httpStatus != null ? ` → ${s.httpStatus}` : ''}${s.detail ? ` — ${s.detail}` : ''}`,
        );
      }
      return result.ok ? 0 : 1;
    } finally {
      store.close();
    }
  }

  const actionId = values.action ?? positionals[0];
  if (!actionId) {
    console.error('Provide an action id (positional or --action). Use `--list` to see actions.');
    return 1;
  }

  let found: { adapter: (typeof adapters)[number]; action: ReturnType<(typeof adapters)[number]['listReplayActions']>[number] } | undefined;
  for (const a of adapters) {
    const act = a.listReplayActions().find((x) => x.id === actionId);
    if (act) {
      found = { adapter: a, action: act };
      break;
    }
  }
  if (!found) {
    console.error(`Unknown action "${actionId}". Use \`--list\`.`);
    return 1;
  }

  let session: Session;
  try {
    // The action's OWN adapter, not whichever app happens to be first.
    session = await acquireSession(values, found.adapter.id);
  } catch (e) {
    console.error(`No session: ${errMsg(e)}`);
    return 1;
  }

  let params: Record<string, string>;
  try {
    params = parseParams(values.param);
  } catch (e) {
    console.error(errMsg(e));
    return 1;
  }

  const store = openStore(values.db);
  const req = faithfulReplayRequest(store, found.adapter.buildReplayRequest(found.action, params, session));
  const capture = await runReplay(req); // secret-redacted Capture
  capture.adapterId = found.adapter.id; // attribute so the Cartographer + stats include it
  const parsed = found.adapter.parse(capture);
  const apiErr = apiErrorText(capture);
  if (apiErr) console.error(`replay ${actionId}: ${found.adapter.displayName} said "${apiErr}"`);

  store.insertCapture(capture);
  const counts = store.applyParseResult(parsed, capture.ts || Date.now());
  store.close();

  console.log(
    `replay ${actionId}: HTTP ${capture.status ?? '?'} ${capture.method} ${capture.host}${capture.path}`,
  );
  console.log(
    `entities: workspaces=${counts.workspaces} actors=${counts.actors} containers=${counts.containers} items=${counts.items}`,
  );
  return 0;
}

// ── export ───────────────────────────────────────────────────────────────────

type ExportFormat = 'json' | 'ndjson' | 'markdown' | 'sqlite';

const EXPORT_EXT: Record<ExportFormat, string> = {
  json: '.json',
  ndjson: '.ndjson',
  markdown: '.md',
  sqlite: '.db',
};

function isExportFormat(v: string): v is ExportFormat {
  return v === 'json' || v === 'ndjson' || v === 'markdown' || v === 'sqlite';
}

/** Everything one container's export needs, read once and handed to a renderer. */
interface ExportBundle {
  workspace?: Workspace;
  container?: Container;
  actors: Actor[];
  items: Item[];
}

function readBundle(store: SqliteStore, containerId: string, container?: Container): ExportBundle {
  return {
    workspace: container
      ? store.listWorkspaces().find((w) => w.id === container.workspaceId)
      : undefined,
    container,
    actors: container ? store.listActors(container.workspaceId) : [],
    items: store.listItems(containerId, { limit: 1_000_000 }),
  };
}

/**
 * An ISO timestamp that cannot throw. `new Date(x).toISOString()` raises a
 * RangeError on a NaN or out-of-range `ts`, and an item with a garbage timestamp
 * is a parser bug that must not also make the export unreadable.
 */
function isoTs(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '(unknown time)' : d.toISOString();
}

/**
 * The original format, byte-for-byte. The shape is frozen on purpose — this is
 * the one output that predates `--format`, so something out there parses it.
 */
function renderJson(b: ExportBundle): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      workspace: b.workspace,
      container: b.container,
      itemCount: b.items.length,
      items: b.items,
    },
    null,
    2,
  );
}

/**
 * One item per line and nothing else — no header record, no envelope. The point
 * of NDJSON is that `jq`, `wc -l` and a streaming reader all work on it without
 * knowing anything about Sluice, and a leading line of a different shape breaks
 * every one of them. The container is named by the file, not by the contents.
 */
function renderNdjson(b: ExportBundle): string {
  return b.items.map((i) => JSON.stringify(i)).join('\n') + (b.items.length ? '\n' : '');
}

/** The format a human actually reads: a dated, attributed transcript. */
function renderTranscript(b: ExportBundle): string {
  const name = b.container?.name ?? b.container?.id ?? 'Export';
  const named = new Map(b.actors.map((a) => [a.id, a.displayName ?? a.handle]));
  const meta = [b.workspace?.name, b.container?.kind, `${b.items.length} item(s)`]
    .filter((s) => Boolean(s))
    .join(' · ');

  const out = [`# ${name}`, '', `*${meta} — exported ${new Date().toISOString()}*`, ''];
  if (b.container?.topic) out.push(`> ${b.container.topic}`, '');
  // Oldest first. The store answers newest-first because that is what a UI and a
  // paging script want; a transcript is the one consumer that reads forwards,
  // and reversing it here keeps every other format on the store's order.
  for (const item of [...b.items].reverse()) {
    const who = (item.authorId ? named.get(item.authorId) : undefined) ?? item.authorId ?? 'unknown';
    out.push(`### ${isoTs(item.ts)} — ${who}`, '', item.text.trim() || '*(no text)*', '');
  }
  if (b.items.length === 0) out.push('*(no items captured for this container yet)*', '');
  return out.join('\n');
}

/**
 * A standalone SQLite file holding just this container's rows.
 *
 * Core's schema rather than a hand-rolled flat one, for two reasons: an export
 * that answers the same queries as `~/.sluice/sluice.db` is worth more than a
 * prettier column list, and `applyParseResult` already knows how to write every
 * entity — including the `items_fts` index, so the dump arrives searchable.
 * The capture, cursor and session tables come along EMPTY, which is the point:
 * an export carries entities, never raw traffic and never anything session-shaped.
 */
function writeSqliteExport(path: string, b: ExportBundle): void {
  // A fresh file every time. SqliteStore opens an existing database happily, so
  // exporting twice into one path would otherwise merge two dumps.
  for (const p of [path, `${path}-wal`, `${path}-shm`]) rmSync(p, { force: true });
  const out = new SqliteStore(path);
  try {
    out.applyParseResult(
      {
        workspaces: b.workspace ? [b.workspace] : [],
        actors: b.actors,
        containers: b.container ? [b.container] : [],
        items: b.items,
      },
      Date.now(),
    );
  } finally {
    // Closing checkpoints the WAL, so the .db is complete on its own — a file
    // copied away without its -wal sidecar would otherwise be missing rows.
    out.close();
  }
}

/** A filename that is readable AND unique: the container's name plus its id. */
function exportFileName(containerId: string, format: ExportFormat, container?: Container): string {
  const slug = (s: string): string =>
    s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const base = [slug(container?.name ?? ''), slug(containerId)].filter(Boolean).join('-');
  return `${base || 'export'}${EXPORT_EXT[format]}`;
}

/** Every text format. sqlite is the one that has to be a file, and is not here. */
function renderExport(format: Exclude<ExportFormat, 'sqlite'>, b: ExportBundle): string {
  if (format === 'ndjson') return renderNdjson(b);
  return format === 'markdown' ? renderTranscript(b) : renderJson(b);
}

/** Write one container in `format`. */
function writeExport(path: string, format: ExportFormat, bundle: ExportBundle): void {
  if (format === 'sqlite') writeSqliteExport(path, bundle);
  else writeFileSync(path, renderExport(format, bundle));
}

async function cmdExport(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      container: { type: 'string' },
      out: { type: 'string' },
      format: { type: 'string' },
      all: { type: 'boolean' },
      db: { type: 'string' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice export <containerId> [--format json|ndjson|markdown|sqlite] [--out PATH] [--db PATH]\n' +
        'sluice export --all --out DIR [--format …]   every container, one file each\n' +
        'sluice export --list                         list containers\n' +
        '\n' +
        '  json      one document per container (default; also the stdout format)\n' +
        '  ndjson    one item per line — streams, and every JSON tool can read it\n' +
        '  markdown  a dated, attributed transcript, for reading\n' +
        '  sqlite    a standalone .db of just that container, openable by anything\n' +
        '\n' +
        '  --out is a FILE for one container, or an existing DIR (then the filename is\n' +
        '  derived from the container). sqlite cannot be written to stdout.',
    );
    return 0;
  }

  const requested = values.format ?? 'json';
  if (!isExportFormat(requested)) {
    console.error(`Unknown --format "${requested}". Use: json | ndjson | markdown | sqlite.`);
    return 1;
  }
  const format: ExportFormat = requested;

  const store = openStore(values.db);

  if (values.list) {
    for (const c of store.listContainers()) {
      console.log(`${c.id}  [${c.kind}] ${c.name}`);
    }
    store.close();
    return 0;
  }

  const containers = store.listContainers();

  if (values.all) {
    // One file per container needs somewhere to put them; writing several
    // documents to one stdout stream would produce a file no parser accepts.
    if (!values.out) {
      console.error('--all writes one file per container — pass --out DIR.');
      store.close();
      return 1;
    }
    if (existsSync(values.out) && !statSync(values.out).isDirectory()) {
      console.error(`--out must be a directory when exporting every container: ${values.out}`);
      store.close();
      return 1;
    }
    mkdirSync(values.out, { recursive: true });
    if (containers.length === 0) {
      console.error('No containers to export — capture or sync some structure first.');
      store.close();
      return 0;
    }
    let items = 0;
    for (const c of containers) {
      const bundle = readBundle(store, c.id, c);
      const path = join(values.out, exportFileName(c.id, format, c));
      writeExport(path, format, bundle);
      items += bundle.items.length;
      console.error(`  ${path}  (${bundle.items.length} item(s))`);
    }
    store.close();
    console.error(`Wrote ${containers.length} container(s), ${items} item(s) to ${values.out}`);
    return 0;
  }

  const containerId = values.container ?? positionals[0];
  if (!containerId) {
    console.error('Provide a container id (positional or --container), or --all. Use `--list`.');
    store.close();
    return 1;
  }

  const bundle = readBundle(store, containerId, containers.find((c) => c.id === containerId));
  store.close();
  // A typo'd id produced a valid, empty export and exited 0 — silently. Said on
  // stderr so stdout and the exit code stay exactly what a script expects.
  if (!bundle.container) {
    console.error(
      `No container "${containerId}" in this store (see \`--list\`) — exporting ${bundle.items.length} matching item(s).`,
    );
  }

  if (!values.out) {
    if (format === 'sqlite') {
      console.error('sqlite is a file format — pass --out FILE (or --out DIR).');
      return 1;
    }
    const text = renderExport(format, bundle);
    // The file variants end exactly where the renderer says; a terminal wants a
    // final newline, which is why `--out FILE` and stdout differ by one byte.
    process.stdout.write(text.endsWith('\n') || text === '' ? text : `${text}\n`);
    return 0;
  }

  // An existing directory means "name the file for me"; anything else is the
  // literal path the user typed, which is what `--out FILE` has always meant.
  const path =
    existsSync(values.out) && statSync(values.out).isDirectory()
      ? join(values.out, exportFileName(containerId, format, bundle.container))
      : values.out;
  writeExport(path, format, bundle);
  console.error(`Wrote ${bundle.items.length} items to ${path}`);
  return 0;
}

/**
 * Write captured traffic out as an NDJSON fixture the mock runner can replay.
 *
 * This is what makes the codebase workable without credentials. Everything that
 * exercises a parser today needs a live, signed-in account for the service in
 * question, so anyone without one cannot test the store, the WS protocol or the
 * dashboard at all. A fixture recorded once unblocks all of it.
 *
 * Two decisions worth stating, because both are easy to get backwards:
 *
 * Redaction runs AGAIN here even though captures are redacted on the way into
 * the store. A fixture is the one artifact that leaves the machine — it gets
 * committed, attached to an issue, sent to a maintainer — so it is worth paying
 * for a second pass rather than trusting that every engine got it right.
 *
 * Assets and binaries are skipped by default. fast.com's speed-test payloads are
 * ~25 MiB EACH; a recorder that takes everything an adapter claims produces a
 * multi-hundred-megabyte file, and Trello's host-only match means its entire JS
 * bundle is attributed to the adapter. `classify()` is what makes that skip
 * mechanical rather than a rule someone has to remember.
 */
async function cmdRecord(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      adapter: { type: 'string' },
      limit: { type: 'string' },
      since: { type: 'string' },
      'include-assets': { type: 'boolean' },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice record [--out FILE] [--adapter ID] [--limit N] [--since MINUTES] [--db PATH]\n' +
        '              [--include-assets]\n' +
        '\n' +
        "Write captures as NDJSON — one JSON Capture per line — for @sluice/adapter-sdk's\n" +
        'mock runner to replay without credentials. Re-redacted on the way out.\n' +
        'Static assets and large binaries are skipped unless --include-assets.',
    );
    return 0;
  }

  const store = openStore(values.db);
  const limit = values.limit ? Number(values.limit) : 10_000;
  if (!Number.isFinite(limit) || limit <= 0) {
    console.error('--limit must be a positive number.');
    store.close();
    return 1;
  }
  const sinceMinutes = values.since ? Number(values.since) : undefined;
  if (sinceMinutes !== undefined && !Number.isFinite(sinceMinutes)) {
    console.error('--since must be a number of minutes.');
    store.close();
    return 1;
  }

  const captures = store.listCaptures({
    adapterId: values.adapter,
    limit,
    sinceTs: sinceMinutes === undefined ? undefined : Date.now() - sinceMinutes * 60_000,
  });
  store.close();

  const skipped = { asset: 0, binary: 0 };
  const lines: string[] = [];
  // Oldest first: the mock runner replays in timestamp order anyway, but a
  // fixture that reads chronologically is far easier to reason about by hand.
  for (const capture of [...captures].reverse()) {
    const app = apps.find((a) => a.id === capture.adapterId);
    const kind = app?.classify?.(capture)?.class;
    if (!values['include-assets'] && (kind === 'asset' || kind === 'binary')) {
      skipped[kind] += 1;
      continue;
    }
    lines.push(
      JSON.stringify({
        ...capture,
        url: redactUrl(capture.url),
        reqHeaders: redactHeaders(capture.reqHeaders ?? {}),
        resHeaders: redactHeaders(capture.resHeaders ?? {}),
        reqBody: capture.reqBody === null ? null : redactText(capture.reqBody),
        resBody: capture.resBody === null ? null : redactText(capture.resBody),
      }),
    );
  }

  const ndjson = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  if (values.out) {
    writeFileSync(values.out, ndjson);
    console.error(`Wrote ${lines.length} captures to ${values.out}`);
  } else {
    process.stdout.write(ndjson);
  }
  const dropped = skipped.asset + skipped.binary;
  if (dropped > 0) {
    console.error(
      `Skipped ${dropped} (${skipped.asset} asset, ${skipped.binary} binary) — pass --include-assets to keep them.`,
    );
  }
  return 0;
}

/**
 * Replay a recorded NDJSON fixture as if it were arriving live.
 *
 * The counterpart to `sluice record`, and the reason both exist: without it, the
 * only way to exercise the store, the WS protocol and the dashboard is to hold
 * live credentials for a real service. Captures are fed through the SAME ingest
 * funnel the capture engines use, so what this exercises is exercised exactly as
 * production does it — attribution, redaction, parsing, the entity broadcast.
 *
 * Serves the dashboard while it runs, so you can watch the replay land.
 */
async function cmdMock(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      speed: { type: 'string' },
      port: { type: 'string' },
      db: { type: 'string' },
      loop: { type: 'boolean' },
      serve: { type: 'boolean' },
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const file = positionals[0];
  if (values.help || !file) {
    // Asking for help succeeds; forgetting the argument does not. Conflating
    // them makes `--help` exit 1, which breaks anything that shells out to it.
    const usage = values.help ? console.log : console.error;
    usage(
      'sluice mock <fixture.ndjson> [--speed 1|10|100] [--serve] [--loop] [--port N] [--db PATH]\n' +
        '\n' +
        'Replay captures recorded by `sluice record` through the real ingest path.\n' +
        '--speed divides the recorded gaps (default 10); --serve also starts the dashboard.',
    );
    return values.help ? 0 : 1;
  }
  if (!existsSync(file)) {
    console.error(`Fixture not found: ${file}`);
    return 1;
  }

  const speed = values.speed === undefined ? 10 : Number(values.speed);
  if (!Number.isFinite(speed) || speed <= 0) {
    console.error('--speed must be a positive number.');
    return 1;
  }

  const { captures, skipped } = parseNdjson(readFileSync(file, 'utf8'));
  if (skipped.length > 0) {
    // Named, not counted: a fixture is hand-scrubbed, and "3 lines were bad" is
    // not enough to go and fix them.
    console.error(`Skipped ${skipped.length} malformed line(s): ${skipped.slice(0, 10).join(', ')}`);
  }
  if (captures.length === 0) {
    console.error('Nothing to replay.');
    return 1;
  }

  const store = openStore(resolveDb(values.db, values.config));
  const adapters = selectApps(values.config);
  const port = parsePort(values.port, fileConfig(values.config).port ?? config.DEFAULT_HTTP_PORT);
  const server = await startServer({ store, adapters, port, getSessions: () => [] });

  console.error(`Replaying ${captures.length} capture(s) at ${speed}x from ${file}`);
  if (values.serve) printServerBanner(server, false);

  const controller = new AbortController();
  const stopping = runUntilSignal(async () => {
    controller.abort();
    await server.close();
    store.close();
  });

  do {
    const done = await runMockCaptures(captures, server.ingest, {
      speed,
      signal: controller.signal,
      onProgress: (n, total) => {
        if (n === total || n % 100 === 0) process.stderr.write(`\r  ${n}/${total}`);
      },
    });
    process.stderr.write(`\r  ${done}/${captures.length} replayed\n`);
  } while (values.loop && !controller.signal.aborted);

  if (!values.serve) {
    await server.close();
    store.close();
    return 0;
  }
  await stopping;
  return 0;
}

async function cmdProxy(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      service: { type: 'string' },
      'proxy-port': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const sub = positionals[0];
  if (values.help || !sub) {
    console.log(
      'sluice proxy <on|off|status> [--service NAME] [--proxy-port N]\n' +
        '  Toggle the macOS system web proxy so the desktop app routes through Sluice.\n' +
        '  `on`/`off` may need admin — if so, the exact `sudo networksetup …` command is printed.',
    );
    return values.help ? 0 : 1;
  }
  let service: string;
  try {
    service = values.service ?? (await detectNetworkService());
  } catch (e) {
    console.error(errMsg(e));
    return 1;
  }
  const proxyPort = parsePort(values['proxy-port'], config.DEFAULT_PROXY_PORT);
  try {
    if (sub === 'status') {
      const st = await getProxyState(service);
      console.log(`Network service: ${service}`);
      console.log(st.enabled ? `System proxy: ON → ${st.host}:${st.port}` : 'System proxy: OFF');
      return 0;
    }
    if (sub === 'on') {
      await setProxy(service, config.LOOPBACK_HOST, proxyPort);
      console.log(`System proxy ON → ${config.LOOPBACK_HOST}:${proxyPort} (service: ${service}).`);
      console.log('Now run `sluice start` to capture. Run `sluice proxy off` when you are done.');
      return 0;
    }
    if (sub === 'off') {
      await clearProxy(service);
      console.log(`System proxy OFF (service: ${service}).`);
      return 0;
    }
    console.error(`Unknown subcommand "${sub}". Use: on | off | status.`);
    return 1;
  } catch (e) {
    console.error(errMsg(e));
    return 1;
  }
}

function loginKeychain(): string {
  return join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
}

async function cmdCaInstall(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log("sluice ca-install\n  Generate (if needed) and trust Sluice's local CA in your login keychain.");
    return 0;
  }
  const { caPath } = await ensureSluiceCA();
  const keychain = loginKeychain();
  console.log(`Sluice CA: ${caPath}`);
  console.log('Trusting it in your login keychain (you may be prompted for your password)…');
  try {
    execFileSync(
      '/usr/bin/security',
      ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', keychain, caPath],
      { stdio: 'inherit' },
    );
    console.log('CA trusted. Remove it later with `sluice ca-uninstall`.');
    return 0;
  } catch (e) {
    console.error(`Failed to trust the CA: ${errMsg(e)}`);
    console.error(`Run manually: security add-trusted-cert -r trustRoot -p ssl -k "${keychain}" "${caPath}"`);
    return 1;
  }
}

async function cmdCaUninstall(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log("sluice ca-uninstall\n  Remove trust for Sluice's local CA.");
    return 0;
  }
  const { caPath } = await ensureSluiceCA();
  try {
    execFileSync('/usr/bin/security', ['remove-trusted-cert', '-d', caPath], { stdio: 'inherit' });
    console.log('CA trust removed.');
    return 0;
  } catch (e) {
    console.error(`Failed to remove CA trust: ${errMsg(e)}`);
    console.error(`Run manually: security remove-trusted-cert -d "${caPath}"`);
    return 1;
  }
}

async function cmdSync(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      workspace: { type: 'string' },
      db: { type: 'string' },
      'app-support': { type: 'string' },
      token: { type: 'string' },
      cookie: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice sync [--workspace NAME] [--db PATH]\n' +
        '  Reconstruct structure (conversations.list + users.list) for EVERY signed-in\n' +
        '  workspace, or just one via --workspace <name|team-id>.',
    );
    return 0;
  }

  let sessions: Session[];
  try {
    sessions = await extractAllSessions(values);
  } catch (e) {
    console.error(`No sessions: ${errMsg(e)}`);
    return 1;
  }
  if (sessions.length === 0) {
    console.error('No signed-in workspaces found.');
    return 1;
  }

  const wanted = values.workspace?.toLowerCase();
  const picked = wanted
    ? sessions.filter((s) => s.label.toLowerCase().includes(wanted) || s.workspaceId === values.workspace)
    : sessions;
  if (picked.length === 0) {
    console.error(`No workspace matching "${values.workspace}". Have: ${sessions.map((s) => s.label).join(', ')}`);
    return 1;
  }

  const store = openStore(values.db);
  for (const s of picked) {
    store.upsertSession(redactSession(s));
    const app = apps.find((a) => a.id === s.adapterId);
    if (!app) continue;
    let containers = 0;
    let actors = 0;
    let items = 0;
    // Replay each app's no-argument "structure" actions (conversations.list,
    // users.list, …) — the ones with no required params.
    for (const action of app.listReplayActions()) {
      if (action.params.some((p) => p.required)) continue;
      const params: Record<string, string> = {};
      for (const p of action.params) if (p.default != null) params[p.name] = p.default;
      try {
        const req = faithfulReplayRequest(store, app.buildReplayRequest(action, params, s));
        const capture = await runReplay(req);
        capture.adapterId = app.id; // attribute so the Cartographer + stats include it
        store.insertCapture(capture);
        const apiErr = apiErrorText(capture);
        if (apiErr) console.error(`  ${s.label} ${action.id}: ${apiErr}`);
        const counts = store.applyParseResult(app.parse(capture), capture.ts || Date.now());
        containers += counts.containers;
        actors += counts.actors;
        items += counts.items;
      } catch (e) {
        console.error(`  ${s.label} ${action.id}: ${errMsg(e)}`);
      }
    }
    // Neutral nouns, and `items` included. The old line said "+N channels, +N
    // users" — Slack's vocabulary — and counted only containers+actors, so a
    // Trello sync that fetched 198 cards (items) reported "+0 channels, +0 users"
    // and looked like a failure. Report what was actually reconstructed.
    console.log(
      `${s.label}: +${containers} containers, +${actors} actors, +${items} items`,
    );
  }
  reconcileAll(store);
  materializeQuiet(store);
  store.close();
  return 0;
}

async function cmdBuildDb(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { db: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(
      'sluice build-db [--db PATH]\n  Materialize per-app tables (one per collection, e.g. channels, users) from captured responses.',
    );
    return 0;
  }
  const store = openStore(values.db);
  const { tables } = materialize(store);
  store.close();
  if (tables.length === 0) {
    console.log('No per-app tables derived yet — capture some traffic first.');
    return 0;
  }
  console.log('Materialized per-app tables:');
  for (const t of tables) console.log(`  ${t.name.padEnd(18)} ${t.rows} row(s)`);
  return 0;
}

async function cmdApiDoc(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      out: { type: 'string' },
      host: { type: 'string' },
      app: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice apidoc [--out FILE] [--host a,b] [--app id] [--db PATH]\n' +
        '  Render an endpoint catalog (Markdown) from captured traffic.\n' +
        '  --host scopes to hosts containing any of the comma-separated substrings;\n' +
        '  --app scopes to one adapter id.',
    );
    return 0;
  }
  const store = openStore(values.db);
  const hostContains = values.host
    ? values.host.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const md = renderMarkdown(buildApiMap(store, { hostContains, adapterId: values.app }));
  store.close();
  if (values.out) {
    writeFileSync(values.out, md);
    console.error(`Wrote API docs to ${values.out}`);
  } else {
    process.stdout.write(`${md}\n`);
  }
  return 0;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * `sluice prune` — bound the capture store. Sluice captures ALL traffic with
 * bodies up to 5 MB and previously had no expiry, so the DB grew forever.
 */
async function cmdPrune(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      days: { type: 'string' },
      'max-rows': { type: 'string' },
      vacuum: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice prune [--days N] [--max-rows N] [--vacuum] [--db PATH]\n' +
        '  Delete old captures. --days drops anything older than N days;\n' +
        '  --max-rows keeps only the newest N. Both may be combined.\n' +
        '  --vacuum reclaims the file space afterwards (rewrites the DB).',
    );
    return 0;
  }
  const days = values.days === undefined ? undefined : Number(values.days);
  const maxRows = values['max-rows'] === undefined ? undefined : Number(values['max-rows']);
  if (days !== undefined && (!Number.isFinite(days) || days <= 0)) {
    console.error('--days must be a positive number.');
    return 1;
  }
  if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 0)) {
    console.error('--max-rows must be a non-negative integer.');
    return 1;
  }
  if (days === undefined && maxRows === undefined) {
    console.error('Nothing to do — pass --days and/or --max-rows. See `sluice prune --help`.');
    return 1;
  }

  const store = openStore(values.db);
  const before = store.countCaptures();
  const removed = store.pruneCaptures({
    maxAgeMs: days === undefined ? undefined : days * 24 * 60 * 60 * 1000,
    maxRows,
    vacuum: Boolean(values.vacuum),
  });
  const after = store.countCaptures();
  store.close();
  console.log(`Pruned ${removed} capture(s): ${before} → ${after}.`);
  return 0;
}

/**
 * `sluice wipe` — the panic button. Documented in the plan and in SECURITY.md as
 * the mechanism behind "reversible trust", but never actually implemented.
 */
async function cmdWipe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      all: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice wipe [--all] [--yes] [--db PATH]\n' +
        '  Delete the capture database. --all additionally removes the local CA\n' +
        '  (untrusting it first) and the dedicated Chrome capture profile.\n' +
        '  Destructive and irreversible — pass --yes to skip the confirmation.',
    );
    return 0;
  }

  const dbPath = values.db ?? config.defaultDbPath();
  const targets: string[] = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  // dirname(sluiceCaCertPath()) rather than sluiceHome()/ca: on macOS the CA
  // lives under ~/Library/Application Support/Sluice, not ~/.sluice, so the old
  // path pointed at a directory that never exists and `wipe --all` silently
  // left the certificate behind.
  const caDir = dirname(sluiceCaCertPath());
  const profileDir = defaultChromeProfileDir();
  if (values.all) targets.push(caDir, profileDir);

  console.log('This will permanently delete:');
  for (const t of targets) console.log(`  ${t}${existsSync(t) ? '' : '  (not present)'}`);

  if (!values.yes) {
    console.error('\nRefusing to wipe without confirmation. Re-run with --yes.');
    return 1;
  }

  if (values.all && process.platform === 'darwin' && existsSync(caDir)) {
    // Untrust before deleting: removing the file alone leaves a trusted cert in
    // the keychain with no corresponding key, which is worse than either state.
    try {
      const certPath = join(caDir, 'sluice-ca.cert');
      if (existsSync(certPath)) {
        execFileSync('/usr/bin/security', ['remove-trusted-cert', '-d', certPath], { stdio: 'ignore' });
        console.log('Removed CA trust.');
      }
    } catch {
      console.error('Warning: could not remove CA trust automatically — run `sluice ca-uninstall`.');
    }
  }

  let removed = 0;
  for (const t of targets) {
    try {
      if (!existsSync(t)) continue;
      rmSync(t, { recursive: true, force: true });
      removed++;
    } catch (e) {
      console.error(`Failed to remove ${t}: ${errMsg(e)}`);
    }
  }
  console.log(`Wiped ${removed} item(s).`);
  return 0;
}


/** `sluice adapters` — what this build can capture, and how each authenticates. */
/**
 * Turn an installed app on or off, by editing the home config.
 *
 * Exists because the allow-list was a config key you had to know about and
 * hand-edit, and the thing it controls is not a preference — it is **which
 * hosts the proxy decrypts**. A setting with that consequence should be one
 * command and should print what it changed.
 *
 * Writes `~/.sluice/config.json` specifically, not whatever config `loadConfig`
 * finds by walking up from the working directory. Enabling an app from inside a
 * repo, into that repo's config, would silently do nothing the next time you ran
 * Sluice from anywhere else.
 */
async function cmdApp(args: string[]): Promise<number> {
  const [action, id] = args;
  if (action === undefined || action === '--help' || action === '-h') {
    console.log(
      'sluice app list\n' +
        'sluice app enable <id>\n' +
        'sluice app disable <id>\n\n' +
        '  Which installed apps this machine uses. A disabled app contributes no MCP\n' +
        "  tools and — the part that matters — none of its hosts to the proxy's\n" +
        '  TLS-intercept list, so its traffic is tunnelled through unread.\n\n' +
        `  Stored in ${externalConfigPath()}. Redaction is NOT narrowed: every\n` +
        '  installed app\'s token shapes stay registered, because redaction runs\n' +
        '  before a capture is attributed and a disabled app\'s secrets could still\n' +
        '  appear in traffic you do capture.',
    );
    return 0;
  }

  const configPath = externalConfigPath();
  const current = readEnabledAdapterIds();
  const known = apps.map((a) => a.id);

  if (action === 'list') {
    for (const a of apps) {
      const on = current === undefined || current.includes(a.id);
      console.log(`  ${on ? '●' : '○'} ${a.id.padEnd(8)} ${a.displayName.padEnd(12)} ${a.hosts.join(', ')}`);
    }
    console.log(
      current === undefined
        ? '\nAll installed apps are enabled (no allow-list set).'
        : `\nAllow-list in ${configPath}: ${current.join(', ')}`,
    );
    return 0;
  }

  if (action !== 'enable' && action !== 'disable') {
    console.error(`Unknown action "${action}". Try: list, enable, disable.`);
    return 1;
  }
  if (id === undefined || !known.includes(id)) {
    console.error(`Unknown app "${id ?? ''}". Installed: ${known.join(', ')}`);
    return 1;
  }

  // Absent means "all", so disabling one has to write the OTHERS out explicitly
  // — otherwise the first disable would produce a one-entry list that enabled
  // exactly the app being turned off.
  const before = current ?? known;
  const next =
    action === 'enable'
      ? [...new Set([...before, id])]
      : before.filter((x) => x !== id);
  if (next.length === 0) {
    console.error('That would disable every app. Sluice would capture nothing; refusing.');
    return 1;
  }

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      console.error(`${configPath} is not valid JSON — fix or remove it first.`);
      return 1;
    }
  }
  config.adapters = next;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const enabled = apps.filter((a) => next.includes(a.id));
  console.log(`${action === 'enable' ? 'Enabled' : 'Disabled'} ${id}. Now active: ${next.join(', ')}`);
  console.log(`Proxy will decrypt: ${enabled.flatMap((a) => a.hosts).join(', ')}`);
  console.log(`Written to ${configPath}`);
  return 0;
}

async function cmdAdapters(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log(
      'sluice adapters [--json] [--config PATH]\n' +
        '  List installed apps: hosts, credential source, MCP tools.\n' +
        `  Also loads any external adapters named in ${externalConfigPath()} and\n` +
        '  reports the ones it refused, so a rejection is diagnosable without starting a capture.',
    );
    return 0;
  }
  // Load them HERE too, not only in `sluice start`: "why is my adapter not
  // working?" is a question you ask before capturing anything, and an answer
  // that requires starting a proxy to see is not an answer.
  const discovery = await installExternalAdapters();
  const selected = selectApps(values.config);
  const rows = selected.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    hosts: a.hosts,
    credentials: a.credentials ? (a.credentials.listWorkspaces ? 'local-store (probeable)' : 'local-store') : 'none',
    replayActions: a.listReplayActions().length,
    mcpTools: (a.mcpTools?.() ?? []).map((t) => t.name),
  }));
  if (values.json) {
    console.log(JSON.stringify({ adapters: rows, external: discovery }, null, 2));
    return 0;
  }
  for (const line of describeDiscovery(discovery)) console.log(line);
  if (discovery.loaded.length > 0 || discovery.rejected.length > 0) console.log('');
  for (const r of rows) {
    console.log(`${r.displayName}  (${r.id})`);
    console.log(`  hosts:        ${r.hosts.join(', ')}`);
    console.log(`  credentials:  ${r.credentials}`);
    console.log(`  replay:       ${r.replayActions} action(s)`);
    console.log(`  mcp tools:    ${r.mcpTools.length ? r.mcpTools.join(', ') : '—'}`);
  }
  if (rows.length !== apps.length) {
    console.log(`\n(${apps.length - rows.length} installed app(s) hidden by the config's adapters allow-list.)`);
  }
  return 0;
}

/**
 * The runner writes a small state file while serving so `status`/`stop` have
 * something to talk to. There is no IPC channel — a pid plus the bound port is
 * everything those two commands actually need.
 */
interface RunState {
  pid: number;
  port: number;
  db: string;
  mode: string;
  startedAt: number;
  /**
   * The MITM proxy port, when this runner has one. Recorded so `doctor` can tell
   * "our own proxy is listening" from "something else has the port" — without it
   * a perfectly healthy `sluice start` reports its own proxy as a conflict.
   */
  proxyPort?: number;
}

function statePath(): string {
  return join(config.sluiceHome(), 'runner.json');
}

function writeRunState(st: RunState): void {
  try {
    config.ensureSluiceHome();
    writeFileSync(statePath(), JSON.stringify(st, null, 2));
  } catch {
    /* status/stop are conveniences — never fail a capture over them */
  }
}

function clearRunState(): void {
  try {
    rmSync(statePath(), { force: true });
  } catch {
    /* same */
  }
}

function readRunState(): RunState | undefined {
  try {
    if (!existsSync(statePath())) return undefined;
    return JSON.parse(readFileSync(statePath(), 'utf8')) as RunState;
  } catch {
    return undefined;
  }
}

/** Is that pid actually alive? Signal 0 tests existence without delivering one. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdStatus(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean' }, db: { type: 'string' }, config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('sluice status [--json] [--db PATH]\n  Report the running daemon (if any) and store size.');
    return 0;
  }

  const st = readRunState();
  const running = st !== undefined && pidAlive(st.pid);
  const dbPath = resolveDb(values.db, values.config);
  let captures = 0;
  try {
    const store = openStore(dbPath);
    captures = store.countCaptures();
    store.close();
  } catch {
    /* store may not exist yet */
  }

  const out = {
    running,
    pid: running ? st?.pid : undefined,
    port: running ? st?.port : undefined,
    mode: running ? st?.mode : undefined,
    uptimeSec: running && st ? Math.round((Date.now() - st.startedAt) / 1000) : undefined,
    db: dbPath,
    captures,
  };
  if (values.json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  if (running && st) {
    console.log(`running   pid ${st.pid} · ${st.mode} · http://${config.LOOPBACK_HOST}:${st.port}/ · up ${out.uptimeSec}s`);
  } else {
    console.log('stopped   no runner is serving');
    if (st) console.log(`          (stale state file for pid ${st.pid}; it is not running)`);
  }
  console.log(`db        ${dbPath}`);
  console.log(`captures  ${captures}`);
  return running ? 0 : 1;
}

async function cmdStop(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log('sluice stop [--force]\n  Ask a running runner to shut down (SIGTERM; --force sends SIGKILL).');
    return 0;
  }
  const st = readRunState();
  if (!st) {
    console.error('No runner state found — nothing to stop.');
    return 1;
  }
  if (!pidAlive(st.pid)) {
    console.error(`No process ${st.pid}; clearing the stale state file.`);
    clearRunState();
    return 1;
  }
  try {
    process.kill(st.pid, values.force ? 'SIGKILL' : 'SIGTERM');
  } catch (e) {
    console.error(`Could not signal pid ${st.pid}: ${errMsg(e)}`);
    return 1;
  }
  console.log(`Sent ${values.force ? 'SIGKILL' : 'SIGTERM'} to pid ${st.pid}.`);
  // A clean shutdown clears its own state; --force cannot, so do it here.
  if (values.force) clearRunState();
  return 0;
}


/**
 * `sluice auth` — how this service authenticates you, derived from what you
 * captured. Answers "which endpoint issues my session, and which one refreshes
 * it" without ever printing a secret.
 */
async function cmdAuth(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      app: { type: 'string' },
      json: { type: 'boolean' },
      hints: { type: 'boolean' },
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice auth [--app id] [--hints] [--json] [--db PATH]\n' +
        '  Map the auth flow from captured traffic: which endpoints issue credentials,\n' +
        '  which refresh them, and what later traffic depends on them.\n' +
        '  --hints also lists per-capture credential candidates.\n' +
        '  Never prints a secret — names, endpoints and redacted previews only.',
    );
    return 0;
  }

  const store = openStore(resolveDb(values.db, values.config));
  const captures = store.listCaptures({ limit: 1_000_000, adapterId: values.app });
  const flow = mapAuthFlow(captures, values.app ?? null);

  const hints = values.hints
    ? captures
        .flatMap((c) => reconstructCredentials(c, selectApps(values.config)))
        .filter((h, i, all) => all.findIndex((o) => o.name === h.name && o.location === h.location) === i)
        .sort((a, b) => b.confidence - a.confidence)
    : [];
  store.close();

  if (values.json) {
    console.log(JSON.stringify({ flow, hints }, null, 2));
    return 0;
  }

  if (flow.sampleCount === 0) {
    console.error('No captures to analyse. Capture some traffic first (`sluice capture`).');
    return 1;
  }
  console.log(`Analysed ${flow.sampleCount} capture(s)${values.app ? ` for ${values.app}` : ''}.\n`);

  if (flow.issuers.length === 0) {
    console.log('No credential-issuing endpoint observed.');
    console.log('That usually means capture started AFTER you signed in — the issuing');
    console.log('response was never seen. Sign out and back in while capturing to map it.');
  } else {
    console.log('Credential issuers (most depended-upon first):');
    for (const i of flow.issuers) {
      const label =
        i.role === 'refresh' ? 'REFRESH' : i.role === 'login' ? 'login  ' : i.role === 'issues-unused' ? 'unused ' : 'unknown';
      console.log(`  [${label}] ${i.endpoint}`);
      console.log(`             mints: ${i.mints.join(', ')}`);
      console.log(`             seen ${i.observations}×, ${i.dependentRequests} later request(s) depend on it`);
      if (i.sample) console.log(`             sample: ${i.sample}`);
    }
  }

  if (flow.unexplainedCredentials.length > 0) {
    console.log(`\nUsed but never seen issued: ${flow.unexplainedCredentials.join(', ')}`);
    console.log('(captured after they were minted — their origin is outside this window)');
  }

  if (values.hints) {
    console.log(`\nCredential candidates (${hints.length}):`);
    for (const h of hints) {
      console.log(`  ${h.role.padEnd(15)} ${h.location}/${h.name}  ${h.valuePreview}  (confidence ${h.confidence})`);
    }
  }
  return 0;
}


// ── flows / learn-flows ──────────────────────────────────────────────────────

async function cmdFlows(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(
      'sluice flows list [--adapter ID] [--source observed|pinned|replay|learned] [--q TEXT] [--db PATH]\n' +
        'sluice flows show <id> [--db PATH]\n' +
        'sluice flows pin <id> [--db PATH]\n' +
        'sluice flows unpin <id> [--db PATH]\n' +
        'sluice flows pin-captures --primary <captureId> --capture <id> [--capture <id> ...] [--label TEXT] [--adapter ID] [--db PATH]\n' +
        'sluice flows templates [--adapter ID] [--db PATH]',
    );
    return sub ? 0 : 1;
  }

  if (sub === 'list') {
    const { values } = parseArgs({
      args: rest,
      options: {
        adapter: { type: 'string' },
        source: { type: 'string' },
        q: { type: 'string' },
        db: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) return cmdFlows(['help']);
    const store = openStore(values.db);
    try {
      const flows = store.listFlows({
        adapterId: values.adapter,
        source: values.source as 'observed' | 'pinned' | 'replay' | 'learned' | undefined,
        q: values.q,
        limit: 200,
      });
      if (flows.length === 0) {
        console.log('(no flows — run `sluice learn-flows` after capturing traffic)');
        return 0;
      }
      for (const f of flows) {
        const primaryOp =
          f.steps.find((s) => s.captureId === f.primaryCaptureId)?.operation ??
          f.steps.find((s) => s.role === 'primary')?.operation ??
          '?';
        console.log(
          `${f.id}  [${f.source}] ${f.adapterId}  ${primaryOp}  steps=${f.steps.length}` +
            (f.label ? `  ${f.label}` : ''),
        );
      }
      return 0;
    } finally {
      store.close();
    }
  }

  if (sub === 'templates') {
    const { values } = parseArgs({
      args: rest,
      options: { adapter: { type: 'string' }, db: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) return cmdFlows(['help']);
    const store = openStore(values.db);
    try {
      const tmpls = store.listFlowTemplates({ adapterId: values.adapter, limit: 200 });
      if (tmpls.length === 0) {
        console.log('(no templates — run `sluice learn-flows`)');
        return 0;
      }
      for (const t of tmpls) {
        const params = t.flowParams.map((p) => p.name + (p.required ? '*' : '')).join(',') || '-';
        console.log(
          `${t.id}  ${t.adapterId}  ${t.primaryKey}  steps=${t.steps.length}  samples=${t.sampleCount}  params=${params}`,
        );
      }
      return 0;
    } finally {
      store.close();
    }
  }

  if (sub === 'show') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { db: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) return cmdFlows(['help']);
    const id = positionals[0];
    if (!id) {
      console.error('Provide a flow or template id.');
      return 1;
    }
    const store = openStore(values.db);
    try {
      const flow = store.getFlow(id);
      if (flow) {
        console.log(JSON.stringify(flow, null, 2));
        return 0;
      }
      const tmpl = store.getFlowTemplate(id);
      if (tmpl) {
        // Drop request fingerprints' values that might look secret-adjacent; show structure only.
        const safe = {
          ...tmpl,
          steps: tmpl.steps.map((s) => ({
            seq: s.seq,
            role: s.role,
            method: s.method,
            path: s.path,
            operation: s.operation,
            required: s.required,
            support: s.support,
            delayMsP50: s.delayMsP50,
            unreproducible: s.unreproducible,
            unreproducibleReason: s.unreproducibleReason,
            params: s.params
              ? Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, { kind: v.kind, name: 'name' in v ? v.name : undefined, fromStep: 'fromStep' in v ? v.fromStep : undefined, jsonPath: 'jsonPath' in v ? v.jsonPath : undefined }]))
              : undefined,
            hasRequestTemplate: Boolean(s.request),
          })),
        };
        console.log(JSON.stringify(safe, null, 2));
        return 0;
      }
      console.error(`No flow or template "${id}".`);
      return 1;
    } finally {
      store.close();
    }
  }

  if (sub === 'pin' || sub === 'unpin') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { db: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) return cmdFlows(['help']);
    const id = positionals[0];
    if (!id) {
      console.error(`Provide a flow id to ${sub}.`);
      return 1;
    }
    const store = openStore(values.db);
    try {
      const got = sub === 'pin' ? store.pinFlow(id) : store.unpinFlow(id);
      if (!got) {
        console.error(`No flow "${id}".`);
        return 1;
      }
      console.log(`${sub}ned ${got.id} → source=${got.source}`);
      return 0;
    } finally {
      store.close();
    }
  }

  if (sub === 'pin-captures') {
    const { values } = parseArgs({
      args: rest,
      options: {
        primary: { type: 'string' },
        capture: { type: 'string', multiple: true },
        label: { type: 'string' },
        adapter: { type: 'string' },
        db: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) return cmdFlows(['help']);
    if (!values.primary) {
      console.error('Pass --primary <captureId>.');
      return 1;
    }
    const caps = values.capture ?? [];
    if (caps.length === 0) {
      console.error('Pass at least one --capture <id>.');
      return 1;
    }
    const store = openStore(values.db);
    try {
      const flow = store.createPinnedFlow({
        primaryCaptureId: values.primary,
        captureIds: caps,
        label: values.label,
        adapterId: values.adapter,
      });
      console.log(`pinned flow ${flow.id}  steps=${flow.steps.length}  primary=${flow.primaryCaptureId}`);
      return 0;
    } catch (e) {
      console.error(errMsg(e));
      return 1;
    } finally {
      store.close();
    }
  }

  console.error(`Unknown flows subcommand "${sub}".`);
  await cmdFlows(['help']);
  return 1;
}

async function cmdLearnFlows(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      adapter: { type: 'string' },
      'window-ms': { type: 'string' },
      'min-steps': { type: 'string' },
      'min-samples': { type: 'string' },
      'no-cluster': { type: 'boolean' },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'sluice learn-flows [--adapter ID] [--window-ms 1000] [--min-steps 2] [--min-samples 1] [--no-cluster] [--db PATH]\n' +
        '  Cluster recent captures into interaction flows, then learn multi-step templates.\n' +
        '  Observation-only: only mitm/cdp/ext bursts train; replay traffic is ignored.',
    );
    return 0;
  }

  const store = openStore(values.db);
  try {
    let clustered = 0;
    if (!values['no-cluster']) {
      const windowMs = values['window-ms'] ? Number(values['window-ms']) : undefined;
      const minSteps = values['min-steps'] ? Number(values['min-steps']) : undefined;
      const proposed = clusterCapturesIntoFlows(store, {
        adapterId: values.adapter,
        windowMs: Number.isFinite(windowMs) ? windowMs : undefined,
        minSteps: Number.isFinite(minSteps) ? minSteps : undefined,
      });
      for (const p of proposed) {
        store.upsertFlow(p);
        clustered++;
      }
      console.log(`clustered ${clustered} flow(s)`);
    }

    const minSamples = values['min-samples'] ? Number(values['min-samples']) : undefined;
    const templates = learnFlowTemplates(store, {
      adapterId: values.adapter,
      minSamples: Number.isFinite(minSamples) ? minSamples : undefined,
      persist: true,
    });
    console.log(`learned ${templates.length} template(s)`);
    for (const t of templates) {
      console.log(
        `  ${t.adapterId}  ${t.primaryKey}  steps=${t.steps.length}  samples=${t.sampleCount}  id=${t.id}`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}


const USAGE = `sluice — local-only capture + explorer for your own SaaS API traffic

Usage: sluice <command> [options]

Commands:
  doctor          Check the local environment (Node, app sign-in, mockttp, DB). No secrets.
  extract-token   Read your local session token + cookie; print a REDACTED summary only.
  serve           Start the loopback web UI + WS server (no proxy).
  start           Like serve, plus the MITM proxy engine for live capture.
  capture         Passively capture your browser's API traffic via Chrome DevTools (no proxy/CA/Keychain).
  proxy           Toggle the macOS system web proxy: sluice proxy <on|off|status>.
  ca-install      Generate + trust Sluice's local CA (for MITM capture of the desktop app).
  ca-uninstall    Remove trust for Sluice's local CA.
  sync            Reconstruct structure for ALL (or one) workspace via the Web API.
  build-db        Materialize per-app tables (one per collection, e.g. channels, users) from captures.
  apidoc          Render an endpoint catalog (Markdown) from captured traffic.
  replay          Run one replay action by id, --flow <template>, or --all to drain cursors.
  flows           List / show / pin interaction flows and learned templates.
  learn-flows     Cluster captures into flows and refresh multi-step templates.
  export          Dump a container's items: json | ndjson | markdown | sqlite.
  record          Dump captures as NDJSON for the mock runner (credential-free replay).
  mock            Replay a recorded NDJSON fixture through the real ingest path.
  auth            Map how a service authenticates you, from captured traffic. No secrets.
  adapters        List installed apps: hosts, credential source, replay actions, MCP tools.
  status          Is a runner serving? Report pid/port/uptime and store size.
  stop            Ask a running runner to shut down (--force to SIGKILL).
  prune           Delete old captures: --days N and/or --max-rows N [--vacuum].
  wipe            THE PANIC BUTTON: delete the capture DB; --all also removes the CA + Chrome profile.

Common options:
  -h, --help      Show help (also works per-command)
  --db PATH       SQLite path (default ~/.sluice/sluice.db)
  --port N        HTTP+WS port (default 7788)
  --config PATH   Config file (default: nearest sluice.config.json, then ~/.sluice/config.json)

macOS is the primary target; token extraction is macOS-only (use --token/--cookie elsewhere).

Sluice is unfunded: https://github.com/sponsors/YasserShkeir`;

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case 'doctor':
      return cmdDoctor(rest);
    case 'extract-token':
      return cmdExtractToken(rest);
    case 'serve':
      return cmdServe(rest);
    case 'start':
      return cmdStart(rest);
    case 'capture':
      return cmdCapture(rest);
    case 'proxy':
      return cmdProxy(rest);
    case 'ca-install':
      return cmdCaInstall(rest);
    case 'ca-uninstall':
      return cmdCaUninstall(rest);
    case 'sync':
      return cmdSync(rest);
    case 'build-db':
      return cmdBuildDb(rest);
    case 'apidoc':
      return cmdApiDoc(rest);
    case 'replay':
      return cmdReplay(rest);
    case 'flows':
      return cmdFlows(rest);
    case 'learn-flows':
      return cmdLearnFlows(rest);
    case 'record':
      return cmdRecord(rest);
    case 'mock':
      return cmdMock(rest);
    case 'export':
      return cmdExport(rest);
    case 'prune':
      return cmdPrune(rest);
    case 'wipe':
      return cmdWipe(rest);
    case 'adapters':
      return cmdAdapters(rest);
    case 'app':
      return cmdApp(rest);
    case 'auth':
      return cmdAuth(rest);
    case 'status':
      return cmdStatus(rest);
    case 'stop':
      return cmdStop(rest);
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((e) => {
    console.error(errMsg(e));
    process.exitCode = 1;
  });
