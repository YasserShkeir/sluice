#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `sluice` — the local-only capture daemon + one-shot commands.
 *
 * Commands: see USAGE (dispatched by main()).
 *
 * Secrets rule, enforced everywhere below: the live Session (token + `d` cookie)
 * lives only in this process's memory. Only a RedactedSession is ever written to
 * SQLite, every capture is stored through the redacting funnel (core persistCapture), and
 * error strings pass through `errMsg` (core's redacting message) before printing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { connect, createConnection, isIP } from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  redactedErrorMessage as errMsg,
  containerWorkspace,
  KEYCHAIN_ALLOW_ADVICE,
  matchAdapter,
  paramSourcesSummary,
  persistCapture,
  primaryOperation,
  redactCapture,
  redactSession,
  restrictToOwner,
  SqliteStore,
  sweepStaleTempDirs,
  templateStepSummary,
  workspaceOfParams,
  workspaceOfValues,
} from '@sluice/core';
import type {
  Actor,
  App,
  Capture,
  Container,
  CredentialHint,
  EngineStatus,
  Item,
  Session,
  WorkItem,
  Workspace,
} from '@sluice/core';
import {
  apps,
  describeDiscovery,
  enabledApps,
  externalConfigPath,
  installExternalAdapters,
  readEnabledAdapterIds,
} from '@sluice/apps';
import { isoTime, runMockCaptures } from '@sluice/adapter-sdk';
import {
  CdpEngine,
  defaultChromeProfileDir,
  ensureSluiceCA,
  sluiceCaCertPath,
  launchDebugChrome,
  mapAuthFlow,
  LAN_LISTEN_HOST,
  MitmEngine,
  NEVER_DECRYPT_HOSTS,
  reconstructCredentials,
  ReplayDeniedError,
  runFlowReplay,
  superviseEngine,
} from '@sluice/interceptor';
import type { LaunchedChrome } from '@sluice/interceptor';
import { buildApiMap, clusterCapturesIntoFlows, learnFlowTemplates, materializeIncremental, rebuildMaterialized, renderMarkdown } from '@sluice/cartographer';

import { printSecretLines } from './banner.js';
import * as config from './config.js';
import { writePrivateFile } from './config.js';
import { apiErrorText, drainOutcome } from './drain-outcome.js';
import { readNdjsonFile } from './ndjson-file.js';
import {
  anonymousSession,
  defaultParams,
  findReplayAction,
  flowReplayIo,
  pickSession,
  runReplayAction,
  sessionForItem,
  structureActions,
} from './replay-actions.js';
import { assertNoForeignProxy, clearProxy, detectNetworkService, getProxyState, isOurProxy, setProxy } from './proxy.js';
import { startServer, type StartServerResult } from './server.js';
import { EngineController, type EngineHandle, LAN_PROXY_REFUSAL } from './engine-controller.js';
import { ChildEngine } from './child-engine.js';
import { makeClaudeTerminal, type Effort, type TerminalHooks } from './claude-terminal.js';

interface CredFlags {
  token?: string;
  cookie?: string;
  'app-support'?: string;
  /** The one app pasted `--token`/`--cookie` are for (else Slack); also scopes extraction. */
  adapter?: string;
  /**
   * Which signed-in workspace to act as: exact team id, then exact label
   * (ignoring case), then label substring (see `selectWorkspace`). Without it,
   * `sync` covers every signed-in workspace; `replay` uses the workspace its
   * params name, else the sole session, and refuses when several remain.
   */
  workspace?: string;
}

const STORE_OPTIONS = { db: { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const;
const CRED_OPTIONS = { token: { type: 'string' }, cookie: { type: 'string' }, 'app-support': { type: 'string' } } as const;
const DAEMON_OPTIONS = {
  ...STORE_OPTIONS,
  ...CRED_OPTIONS,
  port: { type: 'string' },
  'proxy-port': { type: 'string' },
  adapter: { type: 'string' },
  config: { type: 'string' },
  host: { type: 'string', multiple: true },
  'all-hosts': { type: 'boolean' },
  'lan-proxy': { type: 'boolean' },
  'lan-allow': { type: 'string', multiple: true },
} as const;

/** Can we open a TCP connection to this port? Used to spot a dangling system proxy. */
async function isPortListening(port: number, host = config.LOOPBACK_HOST): Promise<boolean> {
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

function openStore(dbPath: string): SqliteStore {
  config.ensureSluiceHome();
  return new SqliteStore(dbPath);
}

/** Open the store a command's flags resolve to: `--db` → config `db` → default. */
function openStoreFor(flags: { db?: string; config?: string }): SqliteStore {
  return openStore(resolveDb(flags.db, flags.config));
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
 * Build/refresh the per-app tables from captures that arrived since the last
 * pass. Non-fatal but reported: materialize runs DDL derived from arbitrary
 * response bodies. Incremental via the store's watermark; the first pass on an
 * older store is a full build, and says so.
 */
function materializeQuiet(store: SqliteStore): void {
  try {
    const { tables, fullRebuild, elapsedMs } = materializeIncremental(store);
    if (tables.length) {
      const how = fullRebuild ? `first full build, ${(elapsedMs / 1000).toFixed(1)}s` : 'incremental';
      console.error(`Per-app DB (${how}): ${tables.map((t) => `${t.name}(${t.rows})`).join(', ')}`);
    }
  } catch (e) {
    console.error(`Warning: per-app DB build failed — ${errMsg(e)}`);
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
      console.error(`Warning: ${app.id} reconcile failed — ${errMsg(e)}`);
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
 * Restrict the installed apps to the home-config allow-list.
 *
 * Delegates to `enabledApps` so CLI and MCP share one source of truth
 * (`~/.sluice/config.json` adapters[] via `readEnabledAdapterIds`). Never reads
 * `--config`: a project-local `sluice.config.json` must not widen TLS intercept
 * hosts.
 */
function selectApps(): typeof apps {
  return enabledApps(readEnabledAdapterIds());
}

/**
 * Apply the config's retention bounds, if any. Reports and returns how many
 * captures it removed — the caller owes a derived-table rebuild when that is > 0
 * (rebuildMaterialized), which it runs after the socket binds.
 */
function applyRetention(store: SqliteStore, configPath?: string): number {
  const { retentionDays, maxCaptures } = fileConfig(configPath);
  if (retentionDays === undefined && maxCaptures === undefined) return 0;
  const removed = store.pruneCaptures({
    maxAgeMs: retentionDays === undefined ? undefined : retentionDays * 24 * 60 * 60 * 1000,
    maxRows: maxCaptures,
  });
  if (removed > 0) console.error(`Retention: pruned ${removed} old capture(s).`);
  return removed;
}

/** Default landing URL for passive capture — the first app's web host (`app.*` preferred). */
function defaultCaptureUrl(): string {
  const hosts = apps[0]?.hosts ?? [];
  const host = hosts.find((h) => h.startsWith('app.')) ?? hosts[0];
  return host ? `https://${host}/` : 'about:blank';
}

/** The app `--token`/`--cookie` are for when `--adapter` does not say — the documented paste-in. */
const PASTE_IN_DEFAULT_APP = 'slack';

let pasteIn: { token?: string; cookie?: string } | undefined;

/** All of stdin, for `--token -` / `--cookie -`. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The pasted credential pair: `--token` / `--cookie` (`-` reads the value from
 * stdin), else the `SLUICE_TOKEN` / `SLUICE_COOKIE` environment variables.
 *
 * A literal value on the command line is readable by every local account for as
 * long as the process runs (`ps -axo args` — and `serve`/`start` run for hours)
 * and is saved in shell history, so using one earns a warning. Resolved once per
 * process: stdin can only be read once.
 */
async function resolvePasteIn(flags: CredFlags): Promise<{ token?: string; cookie?: string }> {
  if (pasteIn) return pasteIn;
  if (flags.token === '-' && flags.cookie === '-') {
    throw new Error('Only one of --token / --cookie can read stdin; put the other in SLUICE_TOKEN / SLUICE_COOKIE.');
  }
  const stdin = flags.token === '-' || flags.cookie === '-' ? (await readStdin()).trim() : '';
  const pick = (flag: string | undefined, env: string | undefined): string | undefined =>
    (flag === '-' ? stdin : flag || env) || undefined;
  if ((flags.token && flags.token !== '-') || (flags.cookie && flags.cookie !== '-')) {
    console.error(
      'Warning: a --token/--cookie value on the command line is visible to other local users (ps) and ' +
        'saved in shell history. Prefer SLUICE_TOKEN / SLUICE_COOKIE, or `--token -` to read it from stdin.',
    );
  }
  pasteIn = { token: pick(flags.token, process.env.SLUICE_TOKEN), cookie: pick(flags.cookie, process.env.SLUICE_COOKIE) };
  return pasteIn;
}

let keychainAdvised = false;

/**
 * Say "Allow, not Always Allow" once, before the first extraction that can raise
 * a Keychain prompt. "Always Allow" adds `security` to the item's ACL, after
 * which any same-user process reads the key without asking. Core never writes
 * to the terminal, so the runner says it.
 */
function adviseKeychainOnce(): void {
  if (keychainAdvised || process.platform !== 'darwin') return;
  keychainAdvised = true;
  console.error(KEYCHAIN_ALLOW_ADVICE);
}

/** Apps already told that the pasted pair is not theirs — once per app, not per drained page. */
const pasteMismatchWarned = new Set<string>();

/**
 * Gather sessions: pasted credentials for ONE app, else each installed app's
 * local-store extraction.
 *
 * Pasted credentials belong to `--adapter`, else Slack — never to the scope
 * `adapterId` a command passes — and only that app's `sessionFromInput` ever
 * sees them. SLUICE_TOKEN may be ambient in the shell, so a `replay` or drain
 * of another app's work must not turn a Slack `xoxc-` pair into that app's
 * Bearer. Any other scope ignores the paste and extracts as usual. A paste for
 * an app that cannot take one, or refuses it, is an error: silently falling
 * back to a desktop or Keychain session would act as a different identity.
 *
 * Extraction: a call scoped to one app propagates that app's throw. An unscoped
 * call warns per failing app and carries on, so one app's Keychain or decrypt
 * failure cannot cost every other app its sessions; it throws the first failure
 * only when nothing at all was found. Returns [] when an app simply has no
 * signed-in workspace.
 */
async function extractAllSessions(flags: CredFlags, adapterId?: string): Promise<Session[]> {
  const pasted = await resolvePasteIn(flags);
  const pasteFor = flags.adapter ?? PASTE_IN_DEFAULT_APP;
  if ((pasted.token || pasted.cookie) && (adapterId === undefined || adapterId === pasteFor)) {
    const provider = apps.find((a) => a.id === pasteFor)?.credentials;
    if (!provider) return []; // credential-free: the caller's anonymous session applies
    if (!provider.sessionFromInput) {
      throw new Error(`${pasteFor} does not accept pasted --token/--cookie; sign in to it locally instead.`);
    }
    const input: Record<string, string> = {};
    if (pasted.token) input.token = pasted.token;
    if (pasted.cookie) input.cookie = pasted.cookie;
    // The provider decides what it needs (Toters takes a token alone).
    const s = provider.sessionFromInput(input);
    if (!s) throw new Error(`${pasteFor} did not accept the pasted credentials.`);
    return [s];
  }
  if ((pasted.token || pasted.cookie) && adapterId !== undefined && !pasteMismatchWarned.has(adapterId)) {
    pasteMismatchWarned.add(adapterId);
    if (apps.find((a) => a.id === adapterId)?.credentials?.sessionFromInput) {
      console.error(`Pasted credentials are for ${pasteFor}, not ${adapterId} — pass --adapter ${adapterId} to use them there.`);
    }
  }

  const opts = flags['app-support'] ? { appSupportDir: flags['app-support'] } : undefined;
  const out: Session[] = [];
  const errors: unknown[] = [];
  for (const app of apps) {
    // Scoping matters beyond tidiness: every extractor that runs may raise its
    // own Keychain prompt, so asking three apps for credentials when one was
    // wanted is three consent dialogs.
    if (adapterId && app.id !== adapterId) continue;
    const provider = app.credentials;
    if (!provider) continue;
    adviseKeychainOnce();
    try {
      out.push(...(await provider.extractSessions(opts)));
    } catch (e) {
      if (adapterId) throw e;
      errors.push(e);
      console.error(`Warning: ${app.displayName} credentials unavailable (${errMsg(e)}).`);
    }
  }
  if (out.length === 0 && errors.length > 0) throw errors[0];
  return out;
}

/**
 * The one session a CLI replay acts as: paste-in or extracted, and only one
 * belonging to `adapterId`. Another adapter's builder must never receive it: a
 * Trello session in Slack's builder emits a literal `Cookie: cookieHeader`, and
 * a Slack session in Trello's fires unauthenticated.
 *
 * Chosen by `--workspace`, else the workspace `inferWorkspace` reads off the
 * params, else the sole session; ambiguity is an error naming the candidates.
 */
async function acquireSession(
  flags: CredFlags,
  adapterId?: string,
  inferWorkspace?: () => string | undefined,
): Promise<Session> {
  const sessions = await extractAllSessions(flags, adapterId);
  const scoped = selectWorkspace(sessions, flags.workspace);
  if (scoped.length > 0) {
    const c = pickSession(scoped, { workspaceId: scoped.length > 1 ? inferWorkspace?.() : undefined }, adapterId ?? 'app');
    if (c.ok) return c.session;
    throw new Error(
      `${flags.workspace ? `"${flags.workspace}" matches` : 'Signed in to'} ${scoped.length} workspaces — ` +
        `pass --workspace <name|team-id>. Have: ${scoped.map((s) => `${s.label} (${s.workspaceId ?? '?'})`).join(', ')}`,
    );
  }
  if (flags.workspace && sessions.length > 0) {
    // Naming what IS available turns a dead end into the next command to run.
    throw new Error(
      `No workspace matching "${flags.workspace}". Have: ${sessions.map((s) => s.label).join(', ')}`,
    );
  }
  const app = adapterId ? apps.find((a) => a.id === adapterId) : undefined;
  if (adapterId && app && !app.credentials) return anonymousSession(adapterId);
  throw new Error(
    adapterId
      ? `No signed-in ${adapterId} workspace found — sign in to it, or pass --adapter ${adapterId} with --token/--cookie.`
      : 'No signed-in workspace found — sign in, or pass --token/--cookie.',
  );
}

/**
 * Filter sessions to one workspace: an exact team id first, then an exact label
 * (ignoring case), then a label substring. Exact matches win so `--workspace
 * acme` cannot land on "Acme Staging" just because it was listed first.
 *
 * Shared by `cmdSync`, `acquireSession` and the drain so they share one
 * definition of a match: a selector that resolved a channel under `sync` but not
 * under `replay` would be worse than having no selector at all.
 */
function selectWorkspace(sessions: Session[], workspace?: string): Session[] {
  if (!workspace) return sessions;
  const byId = sessions.filter((s) => s.workspaceId === workspace);
  if (byId.length > 0) return byId;
  const wanted = workspace.toLowerCase();
  const exact = sessions.filter((s) => s.label.toLowerCase() === wanted);
  if (exact.length > 0) return exact;
  return sessions.filter((s) => s.label.toLowerCase().includes(wanted));
}

/** Never throws: returns ALL workspace sessions (one per team), or [] with a warning. */
async function bestEffortSessions(flags: CredFlags, adapterId?: string): Promise<Session[]> {
  let sessions: Session[] = [];
  try {
    sessions = await extractAllSessions(flags, adapterId);
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

/**
 * Best-effort startup work run after bind, so a slow container/Keychain touch
 * (first container touch can take ~20s cold) or the first full materialize
 * never delays the banner. `sessions` is the array `getSessions` reads; it is
 * empty at first, and the dashboard is sent each session as the scan finds it.
 */
async function warmStoreInBackground(opts: {
  store: SqliteStore;
  flags: CredFlags;
  sessions: Session[];
  server: StartServerResult;
  /**
   * Retention just deleted captures, so the derived tables need a drop + full
   * rebuild (rebuildMaterialized) rather than an incremental pass, which would
   * keep the deleted captures' rows — and their message text — forever.
   */
  rebuild?: boolean;
}): Promise<void> {
  const { store, flags, sessions, server } = opts;
  // A killed earlier run can leave a plaintext copy of an app's credential
  // store in $TMPDIR; remove it even if Slack is never read again. Never throws.
  sweepStaleTempDirs();
  try {
    await seedWorkspaces(store, flags['app-support']);
    const found = await bestEffortSessions(flags, flags.adapter);
    sessions.push(...found);
    for (const s of found) store.upsertSession(redactSession(s));
    server.announceSessions(found);
    if (opts.rebuild) {
      try {
        // The full registry, not just the enabled apps: a disabled app's
        // derived rows for pruned captures must go too.
        const t = rebuildMaterialized(store, apps.map((a) => a.id));
        console.error(`Per-app DB rebuilt after retention: ${t.length} table(s).`);
      } catch (e) {
        console.error(`Warning: per-app DB rebuild failed — ${errMsg(e)}`);
      }
    } else {
      materializeQuiet(store);
    }
  } catch (e) {
    // Best-effort by definition: the dashboard, replay and capture all work
    // without a local session. Never take the runner down for this.
    console.error(`Warning: startup scan failed — ${errMsg(e)}`);
  }
}

/** 'scanning': serve/start print before the session scan finishes; the scan reports its own result. */
function printServerBanner(server: StartServerResult, sessionState: 'none' | 'scanning'): void {
  console.log('');
  console.log('sluice web UI listening on 127.0.0.1 (loopback only)');
  // The token rides the URL fragment, which is never sent to the server and never
  // in the served page (server.ts injectConfig). With the terminal on, the separate
  // pty secret rides as `&p=`, a capability the session token cannot substitute
  // for. The session token is full dashboard control, so these lines are masked
  // off-TTY (banner.ts).
  const frag = server.ptyToken ? `#k=${server.token}&p=${server.ptyToken}` : `#k=${server.token}`;
  printSecretLines(
    [
      `  Open:   ${server.url}${frag}`,
      `  Token:  ${server.token}  (shown here only — not embedded in any served page)`,
      `  Dev UI: http://localhost:5273/${frag}  (with \`pnpm webapp:dev\`)`,
    ],
    [server.token, server.ptyToken],
  );
  if (sessionState === 'none') {
    console.log('  Note:   no session yet — run `sluice extract-token` or pass --token/--cookie.');
  } else if (sessionState === 'scanning') {
    console.log('  Note:   scanning for signed-in workspaces in the background…');
  }
  console.log('');
  console.log('Press Ctrl-C to stop.');
}

/**
 * Resolves after SIGINT/SIGTERM/SIGHUP has run `onStop`. Keeps the daemon alive.
 *
 * A crash runs `onStop` too, then exits non-zero. `onStop` is what restores the
 * system proxy; a runner that died without it left all of the Mac's HTTPS
 * pointed at a port nothing listens on — which any local process could then
 * bind to receive it.
 */
function runUntilSignal(onStop: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        console.error('\nShutting down…');
        try {
          await onStop();
        } catch (e) {
          console.error(errMsg(e));
        }
        resolve();
      })();
      return stopping;
    };
    const crash = (e: unknown): void => {
      console.error(`sluice: fatal — ${errMsg(e)}`);
      void stop().finally(() => process.exit(1));
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    process.on('SIGHUP', () => void stop()); // the terminal that owned it closed
    process.once('uncaughtException', crash);
    process.once('unhandledRejection', crash);
  });
}

/**
 * The installed apps `--adapter` scopes a command to: every one without the
 * flag, else just that one. Undefined (having said why) when it names no
 * installed app.
 */
function scopeApps(adapterId: string | undefined): typeof apps | undefined {
  if (adapterId === undefined) return apps;
  const scoped = apps.filter((a) => a.id === adapterId);
  if (scoped.length === 0) {
    console.error(`Unknown adapter "${adapterId}". Installed: ${apps.map((a) => a.id).join(', ')}`);
    return undefined;
  }
  return scoped;
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
/** Non-internal IPv4 addresses — printed so a phone on this Wi-Fi can reach Engine A. */
function lanIPv4s(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((a) => a ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

const LAN_PROXY_NOTICE =
  'LAN MITM is on: Engine A binds 0.0.0.0 with NO authentication; only this Mac and the --lan-allow address(es) are accepted, so an allowed device can send traffic out from your IP and write captures into your store (and one that trusts the Sluice CA has its TLS decrypted). An IP is not an identity — use it only on a network you trust, and stop capture as soon as the phone is done. Dashboard/WS stay 127.0.0.1. Do not run sluice proxy on. Install the CA from the printed /sluice-ca.mobileconfig URL, then uninstall it when done.';

/** The `--lan-proxy` block of the serve/start banner: the warning, the allowlist, and where a phone points. */
function printLanProxy(proxyPort: number, lanClients: readonly string[]): void {
  console.log(`  ⚠ ${LAN_PROXY_NOTICE}`);
  console.log(`  Proxy:   ${LAN_LISTEN_HOST}:${proxyPort}`);
  console.log(`  Allowed: this Mac, ${lanClients.join(', ')}`);
  const ips = lanIPv4s();
  for (const ip of ips) {
    console.log(`  Phone:   HTTP(S) proxy ${ip}:${proxyPort}`);
    console.log(`  CA:      http://${ip}:${proxyPort}/sluice-ca.mobileconfig  (or /sluice-ca.cer)`);
  }
  if (ips.length === 0) {
    console.log(`  CA:      http://127.0.0.1:${proxyPort}/sluice-ca.mobileconfig (no non-internal IPv4 found)`);
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      ...STORE_OPTIONS,
      net: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'sluice doctor [--db PATH] [--net] — check the local environment (no secrets printed).\n' +
        '  --db PATH  capture database to inspect (default: config / ~/.sluice).\n' +
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
  // An advisory check prints `!!` (worth knowing, not fatal) and is reflected in
  // the summary, so a red line never sits above a plain "doctor: OK".
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

  // Per-app sign-in probe — passive (local config only; no Keychain, no network),
  // non-fatal. Apps with a credential provider but no `listWorkspaces` are
  // reported as unverifiable, not skipped.
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

  // Probe the package that owns mockttp (@sluice/interceptor), not a bare specifier @sluice/runner does not declare.
  let mockttpOk = false;
  let mockttpDetail = '';
  try {
    const mod = await import('@sluice/interceptor');
    mockttpOk = typeof mod.MitmEngine === 'function';
    if (!mockttpOk) mockttpDetail = '@sluice/interceptor loaded but exposes no MitmEngine';
  } catch (e) {
    mockttpDetail = `proxy engine unavailable: ${errMsg(e)}`;
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
            : `enabled → ${st.host}:${st.port} but NOTHING is listening. Run \`sluice proxy off --proxy-port ${st.port}\` or start Sluice.`,
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
  const caPath = sluiceCaCertPath();

  if (!existsSync(caPath)) {
    warn(
      false,
      'Local CA',
      'not generated yet — run `sluice ca-install`. (`sluice start` creates the certificate but does NOT trust it, and an untrusted CA fails every HTTPS request through the proxy.)',
    );
  } else if (darwin) {
    // Exit 0 means the chain verifies for SSL — what the proxy needs, and not implied by the file existing.
    const trusted = spawnSync('/usr/bin/security', ['verify-cert', '-c', caPath, '-p', 'ssl'], { stdio: 'ignore' }).status === 0;
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
    const state = liveRunState();
    const ours = state?.port === port || state?.proxyPort === port;
    warn(
      ours,
      `Port ${port} (${label})`,
      ours ? 'in use by a running Sluice' : 'in use by another process — pass --port / --proxy-port',
    );
    if (label === 'MITM proxy') {
      const lanIp = lanIPv4s()[0];
      const onLan = lanIp ? await isPortListening(port, lanIp) : false;
      if (onLan && !state?.lanProxy) {
        warn(
          false,
          'MITM listen address',
          `port ${port} answers on LAN ${lanIp} without --lan-proxy — accidental LAN MITM; bind Engine A on 127.0.0.1 unless you meant a phone proxy`,
        );
      } else if (state?.lanProxy) {
        warn(true, 'MITM listen address', 'LAN bind (--lan-proxy); dashboard stays loopback');
      }
    }
  }

  // ── Network probes (opt-in) ─────────────────────────────────────────────────
  if (values.net) {
    const proxyPort = cfgForPorts.proxyPort ?? config.DEFAULT_PROXY_PORT;
    if (!(await isPortListening(proxyPort))) {
      warn(false, 'Proxy round-trip', `nothing listening on ${proxyPort} — start \`sluice start\` first`);
    } else {
      const rt = await probeThroughProxy(proxyPort, 'https://example.com/');
      warn(rt.ok, 'Proxy round-trip', rt.ok ? `example.com → HTTP ${rt.status}` : rt.detail);
      // The LAN-only CA route answers 200 (a passthrough loop would 500 here) —
      // not whether the LAN can reach it.
      if (liveRunState()?.lanProxy) {
        try {
          const ca = await fetch(`http://127.0.0.1:${proxyPort}/sluice-ca.pem`);
          warn(ca.ok, 'LAN CA download', ca.ok ? 'GET /sluice-ca.pem from loopback succeeded' : `HTTP ${ca.status}`);
        } catch (e) {
          warn(false, 'LAN CA download', errMsg(e));
        }
      }

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

  const dbPath = resolveDb(values.db);
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

/** GET a URL through the local proxy via a raw CONNECT tunnel, reporting rather than throwing. */
async function probeThroughProxy(
  proxyPort: number,
  url: string,
): Promise<{ ok: boolean; status?: number; detail: string }> {
  const { request } = await import('node:https');
  const target = new URL(url);

  return new Promise((resolve) => {
    const socket = connect({ port: proxyPort, host: config.LOOPBACK_HOST }, () => {
      socket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`);
    });
    socket.setTimeout(10_000, () => {
      socket.destroy();
      resolve({ ok: false, detail: 'timed out' });
    });
    socket.once('error', (e) => resolve({ ok: false, detail: e.message }));
    socket.once('data', (chunk: Buffer) => {
      if (!/^HTTP\/1\.[01] 200/.test(chunk.toString('utf8'))) {
        socket.destroy();
        resolve({ ok: false, detail: `proxy refused CONNECT: ${chunk.toString('utf8').split('\r\n')[0]}` });
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
            resolve({ ok: true, status: res.statusCode, detail: '' });
          });
        },
      );
      req.once('error', (e) => {
        socket.destroy();
        resolve({ ok: false, detail: e.message });
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
      ...CRED_OPTIONS,
      ...STORE_OPTIONS,
    },
  });
  if (values.help) {
    console.log(
      'sluice extract-token [--adapter ID] [--token X --cookie Y] [--app-support DIR] [--db PATH]\n' +
        '  Read your local sessions and print a REDACTED summary. The token/cookie are\n' +
        '  never printed or stored (only a RedactedSession is). Reading them briefly\n' +
        '  copies the app\'s store into a private 0700 dir under $TMPDIR, deleted after.\n' +
        '  --adapter scopes extraction to one app, so only that app prompts the Keychain,\n' +
        '  and names the app pasted credentials are for (default slack). Paste via\n' +
        '  SLUICE_TOKEN / SLUICE_COOKIE or `--token -` (stdin) to keep them out of ps.',
    );
    return 0;
  }

  if (!scopeApps(values.adapter)) return 1;

  // Every session in scope, not one: this acts as nobody, it only reports, so
  // several signed-in workspaces are an answer rather than an ambiguity.
  let sessions: Session[];
  try {
    sessions = await extractAllSessions(values, values.adapter);
    if (sessions.length === 0) {
      throw new Error(
        values.adapter
          ? `No signed-in ${values.adapter} workspace found — sign in to it, or pass --adapter ${values.adapter} with --token/--cookie.`
          : 'No signed-in workspace found — sign in, or pass --token/--cookie.',
      );
    }
  } catch (e) {
    console.error(`extract-token failed: ${errMsg(e)}`);
    if (process.platform !== 'darwin') {
      console.error(
        'Extraction reads the macOS Keychain + the app\'s local store and only works on macOS. Use paste-in: ' +
          'SLUICE_TOKEN / SLUICE_COOKIE (or --token - to read stdin) with --adapter ID.',
      );
    } else {
      console.error(
        'Make sure the desktop app is installed and you are signed in, or use --token/--cookie paste-in.',
      );
    }
    return 1;
  }

  const store = openStoreFor(values);
  const redacted = sessions.map((s) => redactSession(s));
  for (const r of redacted) store.upsertSession(r);
  store.close();

  console.log(
    `Extracted ${redacted.length === 1 ? 'a live session' : `${redacted.length} live sessions`} (held in memory only; NOT written to disk):`,
  );
  for (const r of redacted) {
    console.log(`  id:              ${r.id}`);
    console.log(`  adapter:         ${r.adapterId}`);
    console.log(`  label:           ${r.label}`);
    console.log(`  workspaceId:     ${r.workspaceId ?? '(unknown)'}`);
    console.log(`  source:          ${r.source}`);
    console.log(`  credentialKinds: ${r.credentialKinds.join(', ')}`);
    console.log('');
  }
  console.log('The token and cookie were not printed and not persisted.');
  console.log('Run `sluice serve` or `sluice start` to reconstruct + browse this session.');
  return 0;
}

/**
 * A SystemProxyOps over the macOS proxy helpers, for the EngineController.
 *
 * The network service is detected once and cached. `ours` compares the enabled
 * proxy against OUR loopback port. `off()` only clears when the proxy currently
 * points at us — never a proxy the user configured for something else — so the
 * controller can safely call it on every stop/shutdown.
 */
function makeProxyOps(ourPort: number): import('./engine-controller.js').SystemProxyOps {
  let service: string | undefined;
  const svc = async (): Promise<string> => (service ??= await detectNetworkService());
  return {
    async on(port) {
      const s = await svc();
      assertNoForeignProxy(await getProxyState(s), port);
      await setProxy(s, config.LOOPBACK_HOST, port);
    },
    async off() {
      // Only disable when the live proxy is ours. A bare clearProxy here would
      // clobber an unrelated corporate proxy if state().ours were wrong.
      const st = await getProxyState(await svc());
      if (isOurProxy(st, ourPort)) await clearProxy(await svc());
    },
    async state() {
      try {
        const st = await getProxyState(await svc());
        const ours = isOurProxy(st, ourPort);
        return { supported: true, enabled: st.enabled, host: st.host, port: st.port, ours };
      } catch (e) {
        return { supported: false, enabled: false, ours: false, detail: errMsg(e) };
      }
    },
  };
}

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

/**
 * Build an EngineController plus `wire`, which finishes the wiring once the server
 * exists. The forward-ref is unavoidable: the engine needs the server's
 * `ingest`/`broadcastEngineStatus`, and the server needs the controller as `control`.
 */
function makeController(opts: {
  proxyPort: number;
  adapters: App[];
  interceptHosts: string[];
  interceptAllHosts: boolean;
  /** Run the engine in an isolated child process (§S1). */
  isolated?: boolean;
  /** Engine A listen address. Default loopback; `--lan-proxy` passes 0.0.0.0. */
  listenHost?: string;
  /** `--lan-proxy`: the controller then refuses to set the system proxy. */
  lanProxy?: boolean;
  /** `--lan-allow`: the only non-loopback clients the LAN proxy accepts. */
  lanClients?: readonly string[];
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
          SLUICE_CHILD_LISTEN_HOST: opts.listenHost ?? '127.0.0.1',
          SLUICE_CHILD_LAN_CLIENTS: (opts.lanClients ?? []).join(','),
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
      listenHost: opts.listenHost,
      lanClients: opts.lanClients,
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
    lanProxy: opts.lanProxy,
  });

  const wire = (server: StartServerResult): void => {
    ingest = server.ingest;
    publishStatus = server.broadcastEngineStatus;
    publishEnv = () => void server.broadcastEnvironment();
  };
  return { controller, wire };
}

/** The flags `serve` and `start` share — what {@link prepareDaemon} reads. */
interface DaemonFlags {
  adapter?: string;
  port?: string;
  'proxy-port'?: string;
  db?: string;
  config?: string;
  host?: string[];
  'all-hosts'?: boolean;
  'lan-proxy'?: boolean;
  'lan-allow'?: string[];
}

/**
 * `--lan-allow` values, validated: each must be an IP address, and they only
 * mean something with `--lan-proxy` — which, without any, is refused: an
 * unauthenticated proxy open to every device on the network is not a default.
 * Returns the list, or an error message.
 */
function lanClientsFrom(values: Pick<DaemonFlags, 'lan-proxy' | 'lan-allow'>): string[] | string {
  const allow = (values['lan-allow'] ?? []).map((a) => a.trim()).filter(Boolean);
  const bad = allow.find((a) => isIP(a.replace(/^::ffff:/i, '')) === 0);
  if (bad !== undefined) return `--lan-allow takes an IP address, not "${bad}".`;
  if (!values['lan-proxy']) {
    return allow.length > 0 ? '--lan-allow only applies with --lan-proxy.' : [];
  }
  if (allow.length === 0) {
    return (
      '--lan-proxy needs --lan-allow <phone IP> (repeatable): the proxy has no authentication, so ' +
      'without a client allowlist any device on this network could relay traffic through this Mac.'
    );
  }
  return allow;
}

/**
 * The setup `serve` and `start` share: flag checks, config, ports, the store and
 * its retention, external adapters, the TLS intercept scope, and the engine
 * controller (not yet wired to a server). Undefined, having said why, on a bad
 * flag — checked first, so a typo never opens or prunes the store.
 */
async function prepareDaemon(values: DaemonFlags, isolated: boolean) {
  if (!scopeApps(values.adapter)) return undefined;
  const lanClients = lanClientsFrom(values);
  if (typeof lanClients === 'string') {
    console.error(lanClients);
    return undefined;
  }
  const cfg = fileConfig(values.config);
  const port = parsePort(values.port, cfg.port ?? config.DEFAULT_HTTP_PORT);
  const proxyPort = parsePort(values['proxy-port'], cfg.proxyPort ?? config.DEFAULT_PROXY_PORT);
  const store = openStoreFor(values);
  const pruned = applyRetention(store, values.config);
  // External adapters can widen the scoped TLS list; print discovery either way.
  // Before selectApps(), which picks from the registry they join.
  for (const line of describeDiscovery(await installExternalAdapters())) console.error(line);
  const adapters = selectApps();
  const scope = config.resolveInterceptScope({
    config: cfg,
    cliHosts: values.host,
    cliAllHosts: values['all-hosts'],
  });
  const lanProxy = Boolean(values['lan-proxy']);
  const { controller, wire } = makeController({
    proxyPort,
    adapters,
    interceptHosts: scope.interceptHosts,
    interceptAllHosts: scope.interceptAllHosts,
    isolated,
    listenHost: lanProxy ? LAN_LISTEN_HOST : config.LOOPBACK_HOST,
    lanProxy,
    lanClients,
  });
  // Filled in after the socket is listening (and, for `start`, after the banner
  // with the LAN CA URL has printed) — see warmStoreInBackground. The server
  // reads this array lazily through `getSessions`, so a session found a few
  // seconds from now is a session the dashboard sees.
  const sessions: Session[] = [];
  return { port, proxyPort, store, pruned, adapters, scope, lanProxy, lanClients, controller, wire, sessions };
}

async function cmdServe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      ...DAEMON_OPTIONS,
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
    },
  });
  if (values.help) {
    console.log(
      'sluice serve [--port N] [--proxy-port N] [--db PATH] [--host H]... [--all-hosts] [--isolated] [--token X --cookie Y] [--adapter ID]\n' +
        '  Serves the dashboard. The engine starts IDLE — start/stop capture and the\n' +
        '  system proxy from the dashboard (or use `sluice start` to bring both up now).\n' +
        '\n' +
        '  --token X --cookie Y     Paste-in credentials for ONE app (--adapter, default slack) instead\n' +
        '                           of reading local sessions. `-` reads a value from stdin;\n' +
        '                           SLUICE_TOKEN / SLUICE_COOKIE keep them out of ps and shell history.\n' +
        '  --adapter ID             The app pasted credentials are for; also limits the session scan to it.\n' +
        '  --host H                 Limit TLS decrypt to adapter hosts plus H (repeatable).\n' +
        '                           Without any --host / interceptHosts, every host is decrypted.\n' +
        '  --all-hosts              Force decrypt everything (default when no hosts are set).\n' +
        '  --lan-proxy              Bind Engine A on 0.0.0.0 so a phone on this Wi-Fi can use the proxy. Dashboard/WS stay 127.0.0.1. Do not combine with sluice proxy on.\n' +
        '  --lan-allow IP           A client the LAN proxy accepts besides this Mac (repeatable; required\n' +
        '                           with --lan-proxy). Every other device on the network is refused.\n' +
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
        '                           Off by default. Captured content (emails, messages, any\n' +
        '                           intercepted page) is written by OTHER people and the session\n' +
        '                           reads it — with no prompts, text planted there can try to\n' +
        '                           make it run commands. Trusting your own account is not enough.\n' +
        '  --terminal-bin PATH      Path to the claude binary (default: found on PATH).',
    );
    return 0;
  }

  const d = await prepareDaemon(values, Boolean(values.isolated));
  if (!d) return 1;
  const { port, proxyPort, store, pruned, adapters, lanProxy, lanClients, controller, wire, sessions } = d;

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
  if (lanProxy) {
    console.log('');
    printLanProxy(proxyPort, lanClients);
    // `serve` does not start Engine A, so nothing is listening on the proxy port
    // yet and the URLs above answer nothing until capture starts. Saying so
    // beats letting someone conclude the CA download is broken.
    console.log('  ⓘ These come up when capture starts (dashboard → Control, or `sluice start --lan-proxy`).');
  }
  printServerBanner(server, 'scanning');
  if (server.ingestToken) {
    console.log('');
    console.log('  Extension ingest ENABLED — POST /api/ingest');
    printSecretLines([`    Ingest token: ${server.ingestToken}`], [server.ingestToken]);
    console.log('    Paste it (and this URL) into the Sluice browser extension\'s options.');
  }
  if (terminal) {
    console.log('');
    console.log('  ⚠ Terminal ENABLED — the dashboard can launch an interactive Claude Code');
    console.log(`    session: ${terminal.describe()}`);
    console.log('    It runs as you, and the session persists across reloads (re-attaches).');
    if (values['terminal-skip-permissions']) {
      console.log('  ⛔ SKIP-PERMISSIONS is ON — the session runs --dangerously-skip-permissions');
      console.log('     and will NOT prompt before editing files or running commands. It reads your');
      console.log('     captures, which other people wrote (email senders, Slack users, any site you');
      console.log('     intercepted): text planted there can try to make it run commands.');
    }
  }
  console.log('  Capture: idle — start it from the dashboard (Control), or run `sluice start`.');
  writeRunState({ pid: process.pid, port, db: store.db.name, mode: 'serve', startedAt: Date.now(), proxyPort, lanProxy });

  // Deliberately not awaited: the socket is already listening and the banner is
  // already printed, which is the whole point of running this here.
  void warmStoreInBackground({ store, flags: values, sessions, server, rebuild: pruned > 0 });

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
    options: DAEMON_OPTIONS,
  });
  if (values.help) {
    console.log('sluice start [--port N] [--proxy-port N] [--db PATH] [--token X --cookie Y] [--adapter ID]');
    console.log('             [--token/--cookie]    paste-in for ONE app (--adapter, default slack); `-` = stdin,');
    console.log('                                  or SLUICE_TOKEN / SLUICE_COOKIE to keep them out of ps');
    console.log('             [--host HOSTNAME]…   limit TLS decrypt to adapter hosts + these (repeatable)');
    console.log('             [--all-hosts]        decrypt everything (default when no --host is set)');
    console.log('             [--lan-proxy]       bind the MITM proxy on 0.0.0.0 (phone on this LAN); dashboard stays loopback');
    console.log('             [--lan-allow IP]…   the phone(s) the LAN proxy accepts (required with --lan-proxy; repeatable)');
    return 0;
  }

  const d = await prepareDaemon(values, false);
  if (!d) return 1;
  const { port, proxyPort, store, pruned, adapters, scope, lanProxy, lanClients, controller, wire, sessions } = d;

  const server = await startServer({
    store,
    adapters,
    port,
    getSessions: () => sessions,
    engine: controller,
    control: controller,
  });
  wire(server);

  // start = serve + engine immediately. Controller owns supervise + lifecycle.
  try {
    await controller.startEngine();
    console.log('');
    console.log('MITM proxy engine started (Engine A).');
    if (scope.interceptAllHosts) {
      // All-hosts mode still tunnels these unread (AI assistant and agent
      // tokens); only an explicit --host opts one of them into decryption.
      console.log(`  Never decrypted: ${NEVER_DECRYPT_HOSTS.join(', ')} (and subdomains).`);
    }
    if (lanProxy) {
      printLanProxy(proxyPort, lanClients);
    } else {
      console.log(`  Proxy:   127.0.0.1:${proxyPort}`);
      const appName = apps[0]?.displayName ?? 'the app';
      console.log(`  Route the ${appName} desktop app through it (fully quit ${appName} first):`);
      console.log(
        `    open -a ${appName} --args --proxy-server=127.0.0.1:${proxyPort} --proxy-bypass-list="<-loopback>"`,
      );
    }
  } catch (e) {
    console.error(`Failed to start the MITM engine: ${errMsg(e)}`);
    console.error('Run `sluice doctor` to check the environment. The web UI + replay still work without it.');
  }

  printServerBanner(server, 'scanning');
  writeRunState({
    pid: process.pid,
    port,
    db: store.db.name,
    mode: 'start (mitm)',
    startedAt: Date.now(),
    proxyPort,
    lanProxy,
  });

  // Not awaited: the proxy is listening and the CA URL is on screen. Reading
  // Slack's container and the Keychain must not have gated either.
  void warmStoreInBackground({ store, flags: values, sessions, server, rebuild: pruned > 0 });

  await runUntilSignal(async () => {
    clearRunState();
    await controller.shutdown();
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
    if (!isOurProxy(st, proxyPort)) return;
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
      ...STORE_OPTIONS,
      headless: { type: 'boolean' },
      'chrome-profile': { type: 'string' },
      'no-launch': { type: 'boolean' },
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

  const cfg = fileConfig();
  const port = parsePort(values.port, cfg.port ?? config.DEFAULT_HTTP_PORT);
  const cdpPort = parsePort(values['cdp-port'], cfg.cdpPort ?? config.DEFAULT_CDP_PORT);
  const startUrl = values.url ?? defaultCaptureUrl();
  const profileDir = values['chrome-profile'] ?? defaultChromeProfileDir();
  const store = openStoreFor(values);

  // Passive capture needs NO credentials — nothing here touches the Keychain.
  const server = await startServer({ store, adapters: apps, port, getSessions: () => [] });

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
    adapters: apps,
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

  printServerBanner(server, 'none');
  writeRunState({ pid: process.pid, port, db: store.db.name, mode: 'capture (cdp)', startedAt: Date.now() });
  console.log('Log into the app in the launched Chrome window, then click around — captures stream live into the UI.');

  await runUntilSignal(async () => {
    await engine.stop().catch(() => {}); // already stopped
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

/**
 * How long a claim may sit `running` before a new drainer treats it as stranded.
 * Longer than one batch takes (25 claims × the 20 s replay timeout, plus
 * pacing), so a drainer starting up never steals the live claims of another.
 */
const CLAIM_LEASE_MS = 15 * 60_000;

interface DrainFlags extends CredFlags {
  db?: string;
  container?: string;
  'dry-run'?: boolean;
}

/**
 * Describe a claimed item. Omits `reason` and `depth`: the `cursors` table has
 * no column for either, so they read back undefined.
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
 */
async function drainCursors(flags: DrainFlags, adapters: typeof apps): Promise<number> {
  // Resolved like every other command (`--db` → config `db` → default), so
  // `--all` drains the same store `replay <action>` writes to.
  const store = openStoreFor(flags);
  const wantContainer = flags.container;
  // Filtered exactly as the real drain filters — by `--adapter` (which is what
  // `claimCursors` takes) and by `--container`, and by nothing else. A dry run
  // that quietly hid work the real run would attempt is worse than no dry run.
  const inScope = (w: WorkItem): boolean =>
    (!flags.adapter || w.adapterId === flags.adapter) && (!wantContainer || w.containerId === wantContainer);

  if (flags['dry-run']) {
    reportWorklist(store);
    const pending = store.listCursors({ state: 'pending', limit: 10_000 }).filter(inScope);
    // The real drain first returns claims past their lease to pending, then
    // drains those too — so they are work this run would do, and the preview
    // says so. A claim inside its lease belongs to a live drainer and is not.
    const leaseCutoff = Date.now() - CLAIM_LEASE_MS;
    const stranded = store
      .listCursors({ state: 'running', limit: 10_000 })
      .filter((w) => inScope(w) && w.updatedTs < leaseCutoff);
    store.close();
    if (pending.length + stranded.length === 0) {
      if (wantContainer || flags.adapter) console.log('Nothing pending matches that filter.');
      return 0;
    }
    console.log(`\nWould replay ${pending.length + stranded.length} item(s) — nothing was claimed:`);
    for (const w of pending) console.log(`  ${describeWorkItem(w)}`);
    if (stranded.length > 0) {
      console.log(`Including ${stranded.length} stranded claim(s) the run would release first:`);
      for (const w of stranded) console.log(`  ${describeWorkItem(w)}`);
    }
    return 0;
  }

  // A drainer killed mid-flight leaves its claims `running`, and nothing else
  // ever returns them; without this the worklist looks permanently busy. Only
  // claims past their lease: a younger one is a live drainer's.
  const released = store.releaseStaleCursors(CLAIM_LEASE_MS);
  if (released > 0) console.error(`Released ${released} stranded claim(s) from an earlier run.`);
  reportWorklist(store);

  // Sessions are extracted once per adapter — and so are FAILURES. Re-extracting
  // per work item would raise one Keychain consent prompt per page. The whole
  // list is kept, not its first entry: each item goes out as the session of the
  // workspace it belongs to, never whichever the extractor listed first.
  const pools = new Map<string, Session[]>();
  const poolFor = async (app: App): Promise<Session[]> => {
    const cached = pools.get(app.id);
    if (cached) return cached;
    let pool: Session[] = [];
    try {
      pool = await extractAllSessions(flags, app.id);
      if (pool.length === 0 && !app.credentials) pool = [anonymousSession(app.id)];
      if (selectWorkspace(pool, flags.workspace).length === 0) {
        console.error(
          `No ${app.id} session${flags.workspace ? ` matching "${flags.workspace}"` : ''} — leaving its work queued.`,
        );
      }
    } catch (e) {
      console.error(`No ${app.id} session (${errMsg(e)}) — leaving its work queued.`);
    }
    pools.set(app.id, pool);
    return pool;
  };
  let ambiguous = 0;

  let replayed = 0;
  let failed = 0;
  let skipped = 0;
  let queued = 0;
  let denied: ReplayDeniedError | undefined;
  let rateLimited = false;

  // This run's unsettled claims. Only these are returned to the worklist at the
  // end — a global release would hand a concurrent drainer's live claims to the
  // next claimer and replay those pages twice.
  const held = new Set<string>();
  const settle = (id: string, error?: string): void => {
    store.completeCursor(id, error);
    held.delete(id);
  };

  // Ctrl-C is how a drain is stopped: return this run's claims at once, so the
  // lease only ever strands them after a hard kill.
  const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onSignal = (sig: NodeJS.Signals): void => {
    try {
      const n = store.releaseCursors([...held]);
      store.close();
      if (n > 0) console.error(`\nInterrupted — returned ${n} claim(s) to the worklist.`);
    } finally {
      process.exit(sig === 'SIGTERM' ? 143 : sig === 'SIGHUP' ? 129 : 130);
    }
  };
  for (const s of SIGNALS) process.once(s, onSignal);

  let stranded = 0;
  try {
    drain: while (true) {
      const batch = store.claimCursors(CLAIM_BATCH, flags.adapter);
      if (batch.length === 0) break;
      for (const item of batch) held.add(item.id);

      for (const item of batch) {
        // Skipped items stay `running` (held) and are returned to the worklist
        // below — marking work "done" that was never attempted would lose the page.
        if (wantContainer && item.containerId !== wantContainer) {
          skipped += 1;
          continue;
        }
        const adapter = adapters.find((a) => a.id === item.adapterId);
        if (!adapter) {
          settle(item.id, `no installed adapter "${item.adapterId}"`);
          failed += 1;
          console.error(`  skip: ${describeWorkItem(item)} — no such adapter`);
          continue;
        }
        const action = adapter.listReplayActions().find((a) => a.id === item.actionId);
        if (!action) {
          settle(item.id, `unknown action "${item.actionId}"`);
          failed += 1;
          console.error(`  skip: ${describeWorkItem(item)} — no such replay action`);
          continue;
        }

        const params = { ...defaultParams(action), ...item.params };
        // The cursor and the container live on the WorkItem, not in `params`;
        // find where THIS action wants them rather than assuming the names.
        const cursorParam = action.params.find((p) => p.kind === 'cursor');
        if (item.cursor && cursorParam) params[cursorParam.name] = item.cursor;
        const containerParam = action.params.find((p) => p.kind === 'containerId');
        if (item.containerId && containerParam && params[containerParam.name] === undefined) {
          params[containerParam.name] = item.containerId;
        }

        // Deliberately after both lookups: a seed nothing can resolve is settled
        // without ever asking the OS for a credential.
        const pool = await poolFor(adapter);
        const scoped = selectWorkspace(pool, flags.workspace);
        if (scoped.length === 0) {
          skipped += 1;
          continue;
        }
        // Whose page is this? Its container's workspace, or the one its params
        // name — and it goes out as that workspace or not at all (sessionForItem).
        const workspaceId =
          workspaceOfParams(store, action, params) ??
          (item.containerId ? containerWorkspace(store, item.containerId) : undefined);
        const choice = sessionForItem(pool, scoped, workspaceId, adapter.displayName);
        if (!choice.ok) {
          ambiguous += 1;
          skipped += 1;
          continue;
        }
        const session = choice.session;

        try {
          // Through the shared funnel: redacted, attributed, classified, parsed.
          // The follow-on pages are seeded there too — without them the drain
          // replays one page and stops.
          //
          // No depth bound: `CursorSeed.depth` has no column, so a hop counter would
          // read back undefined. `enqueueCursors` dedupe (a page is enqueued at most
          // once ever) and `replayBudget` are what bound the drain.
          const { capture, counts, seeded, parseError } = persistCapture(
            store,
            await runReplayAction(store, adapter, action, params, session),
            adapter,
          );
          queued += seeded;

          const outcome = drainOutcome(capture);
          if (outcome.kind === 'retry-later') {
            // Left claimed: released back to pending just below, for the next run.
            rateLimited = true;
            console.error(`  ${item.actionId}${item.containerId ? ` ${item.containerId}` : ''}  HTTP 429 — left queued for the next run`);
            break drain;
          }
          const apiErr =
            (outcome.kind === 'failed' ? outcome.error : null) ??
            (parseError !== undefined ? `parse failed: ${errMsg(parseError)}` : null);
          settle(item.id, apiErr ?? undefined);
          if (apiErr) failed += 1;
          else replayed += 1;
          console.error(
            `  ${item.actionId}${item.containerId ? ` ${item.containerId}` : ''}` +
              `  HTTP ${capture.status ?? '?'}${apiErr ? ` (${apiErr})` : ''}` +
              `  +${counts.items} item(s), +${seeded} queued`,
          );
        } catch (e) {
          if (e instanceof ReplayDeniedError) {
            denied = e;
            // The budget refills; a rails denial never does. So a spent budget
            // leaves the item claimed (released just below, back to pending) while
            // a refused request is settled — re-queuing it would loop forever
            // against a check that will always say no.
            if (e.code !== 'rate_budget_exhausted') {
              settle(item.id, `[${e.code}] ${errMsg(e)}`);
              failed += 1;
            }
            break drain;
          }
          settle(item.id, errMsg(e));
          failed += 1;
          console.error(`  ${item.actionId}: ${errMsg(e)}`);
        }
      }
    }
  } finally {
    // Removed before the store closes, and run on a throw too: a claim this run
    // took must not wait out the lease because an adapter hook threw.
    for (const s of SIGNALS) process.off(s, onSignal);
    stranded = store.releaseCursors([...held]);
    store.close();
  }

  console.log(
    `Drained: ${replayed} replayed, ${failed} failed, ${skipped} skipped; ${queued} new page(s) queued.`,
  );
  if (stranded > 0) console.log(`Returned ${stranded} unfinished item(s) to the worklist.`);
  if (ambiguous > 0) {
    console.error(
      `${ambiguous} item(s) left queued: they belong to another workspace than --workspace, or several ` +
        'workspaces are signed in and nothing says which — pass --workspace <name|team-id>.',
    );
  }
  if (rateLimited) {
    console.error('Stopped: the service rate-limited this drain (HTTP 429); re-run `sluice replay --all` to continue.');
    return 0;
  }
  if (denied) {
    console.error(`Stopped: [${denied.code}] ${errMsg(denied)}`);
    if (denied.code === 'rate_budget_exhausted') {
      console.error(
        "This process's replay budget is spent (it is per process, not per account) — " +
          're-run `sluice replay --all` to continue.',
      );
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
      ...STORE_OPTIONS,
      workspace: { type: 'string' },
      ...CRED_OPTIONS,
      list: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'sluice replay <actionId> [--param k=v ...] [--adapter ID] [--workspace NAME] [--token X --cookie Y] [--db PATH]\n' +
        'sluice replay --flow <templateId|primaryKey> [--param k=v ...] [--adapter ID] [--db PATH]\n' +
        'sluice replay --list [--adapter ID]   list available replay actions\n' +
        'sluice replay --all [--container ID] [--adapter ID] [--workspace NAME] [--dry-run]\n' +
        '  --workspace <name|team-id> picks which signed-in workspace to act as;\n' +
        '  without it, the workspace the params name, else the only one signed in.\n' +
        '  Same selector as `sluice sync --workspace`.\n' +
        '  --token/--cookie are for --adapter (default slack), also with --flow and --all.\n' +
        '  Drain the cursor worklist: replay every queued page, ingest it, and queue\n' +
        '  whatever it names next. --dry-run prints what it would replay and claims\n' +
        '  nothing (only with --all: a single or --flow replay has no preview). Stops\n' +
        '  cleanly when the replay budget is spent or the service rate-limits.\n' +
        '  --flow runs a learned multi-step template (see `sluice learn-flows`).',
    );
    return 0;
  }

  const adapters = scopeApps(values.adapter);
  if (!adapters) return 1;
  // Refused, not ignored: a single or --flow replay has no preview, so accepting
  // the flag would send a real request. Checked before any session.
  if (values['dry-run'] && !values.all) {
    console.error('--dry-run applies only to --all; single and --flow replays have no preview.');
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

  // Before any session: a malformed --param fails without a Keychain prompt.
  let params: Record<string, string>;
  try {
    params = parseParams(values.param);
  } catch (e) {
    console.error(errMsg(e));
    return 1;
  }

  if (values.flow) {
    if (values.action || positionals[0]) {
      console.error('Pass --flow alone (with --param / --adapter / --db), not with an action id or --all.');
      return 1;
    }
    const store = openStoreFor(values);
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
      const template = tmpl;
      const app = apps.find((a) => a.id === template.adapterId);
      if (!app) {
        console.error(`No installed app for adapter "${template.adapterId}".`);
        return 1;
      }
      let session: Session;
      try {
        session = await acquireSession(values, app.id, () => workspaceOfValues(store, Object.values(params)));
      } catch (e) {
        console.error(`No session: ${errMsg(e)}`);
        return 1;
      }
      const result = await runFlowReplay({
        template,
        params,
        session,
        io: flowReplayIo(template, app, (c) => {
          persistCapture(store, c, app);
        }),
      });
      if (result.flow) {
        try {
          store.upsertFlow(result.flow);
        } catch {
          /* best-effort */
        }
      }
      // Error and step detail text arrive redacted (runFlowReplay's stepFailed).
      console.log(`flow ${template.primaryKey}: ${result.ok ? 'ok' : 'FAILED'}${result.error ? ` — ${result.error}` : ''}`);
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

  const found = findReplayAction(adapters, actionId);
  if (!found) {
    console.error(`Unknown action "${actionId}". Use \`--list\`.`);
    return 1;
  }

  const { adapter, action } = found;

  // Opened only once it is needed — to tell workspaces apart, or to store the
  // result — so a command that fails at the session never touches the store.
  let store: SqliteStore | undefined;
  const db = (): SqliteStore => {
    store ??= openStoreFor(values);
    return store;
  };
  try {
    let session: Session;
    try {
      // The action's OWN adapter, not whichever app happens to be first; and
      // with several workspaces, the one the params name (a channel's team).
      session = await acquireSession(values, adapter.id, () => workspaceOfParams(db(), action, params));
    } catch (e) {
      console.error(`No session: ${errMsg(e)}`);
      return 1;
    }

    const { capture, counts, parseError } = persistCapture(
      db(),
      await runReplayAction(db(), adapter, action, params, session), // secret-redacted Capture
      adapter,
    );
    const apiErr = apiErrorText(capture);
    if (apiErr) console.error(`replay ${actionId}: ${adapter.displayName} said "${apiErr}"`);

    console.log(
      `replay ${actionId}: HTTP ${capture.status ?? '?'} ${capture.method} ${capture.host}${capture.path}`,
    );
    console.log(
      `entities: workspaces=${counts.workspaces} actors=${counts.actors} containers=${counts.containers} items=${counts.items}`,
    );
    if (parseError !== undefined) {
      console.error(`replay ${actionId}: parse failed — ${errMsg(parseError)} (the capture is stored, unparsed)`);
      return 1;
    }
    return 0;
  } finally {
    store?.close();
  }
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
    // isoTime cannot throw: a garbage `ts` must not make the export unreadable.
    out.push(`### ${isoTime(item.ts) ?? '(unknown time)'} — ${who}`, '', item.text.trim() || '*(no text)*', '');
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
  else writePrivateFile(path, renderExport(format, bundle)); // item bodies: owner-only, like the store
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
      ...STORE_OPTIONS,
      list: { type: 'boolean' },
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

  const store = openStoreFor(values);

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
    mkdirSync(values.out, { recursive: true, mode: 0o700 });
    if (containers.length === 0) {
      console.error('No containers to export — capture or sync some structure first.');
      store.close();
      return 0;
    }
    let items = 0;
    let first: string | undefined;
    for (const c of containers) {
      const bundle = readBundle(store, c.id, c);
      const path = join(values.out, exportFileName(c.id, format, c));
      writeExport(path, format, bundle);
      first ??= path;
      items += bundle.items.length;
      console.error(`  ${path}  (${bundle.items.length} item(s))`);
    }
    store.close();
    console.error(`Wrote ${containers.length} container(s), ${items} item(s) to ${values.out}`);
    if (first) warnIfTrackedByGit(first);
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
  // On stderr, so stdout and the exit code stay what a script expects.
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
  warnIfTrackedByGit(path);
  return 0;
}

/**
 * Warn when captured data was just written inside a Git worktree at a path Git
 * does not ignore: from there it can be committed, and the project graph
 * indexes it. Says nothing outside a repository, for an ignored path, or when
 * Git cannot tell. Never blocks the write and never prints the file.
 */
function warnIfTrackedByGit(out: string): void {
  const abs = resolve(out);
  let toplevel: string;
  try {
    toplevel = execFileSync('git', ['-C', dirname(abs), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return; // not a repository, or no git
  }
  if (!toplevel) return;
  const r = spawnSync('git', ['-C', toplevel, 'check-ignore', '-q', '--', abs], { stdio: 'ignore' });
  if (r.status === 1) {
    console.error(
      `warning: ${out} is inside the Git worktree ${toplevel} and is not ignored; captured data there can be ` +
        'committed or indexed. Write it outside the repository or add it to .gitignore.',
    );
  }
}

/**
 * Write captured traffic out as an NDJSON fixture the mock runner can replay, so
 * the store, WS protocol and dashboard can be exercised without credentials.
 *
 * Redaction runs AGAIN here even though captures are redacted on the way into
 * the store: a fixture is the one artifact that leaves the machine. Assets and
 * binaries are skipped by default, mechanically via `classify()`.
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
      ...STORE_OPTIONS,
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

  const store = openStoreFor(values);
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
  // Written a line at a time: V8 caps a single string at ~512 MB.
  //
  // Owner-only, like the store it came from: the open's mode applies only on
  // create, so an existing file is tightened before the first body lands in it.
  const fd = values.out ? openSync(values.out, 'w', 0o600) : undefined;
  if (values.out) restrictToOwner(values.out);
  const emit = (line: string): void => {
    if (fd === undefined) process.stdout.write(`${line}\n`);
    else writeSync(fd, `${line}\n`);
  };

  let written = 0;
  try {
    // Oldest first: the mock runner replays in timestamp order anyway, but a
    // fixture that reads chronologically is far easier to reason about by hand.
    for (const capture of [...captures].reverse()) {
      const app = apps.find((a) => a.id === capture.adapterId);
      const kind = app?.classify?.(capture)?.class;
      if (!values['include-assets'] && (kind === 'asset' || kind === 'binary')) {
        skipped[kind] += 1;
        continue;
      }
      // Re-redacted on the way out — every field, the URL-like ones included:
      // rows stored before the ingest funnel redacted them still hold raw
      // query strings, and a fixture is the artifact that leaves the machine.
      emit(JSON.stringify(redactCapture(capture)));
      written += 1;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (values.out) {
    console.error(`Wrote ${written} captures to ${values.out}`);
    warnIfTrackedByGit(values.out);
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
      ...STORE_OPTIONS,
      loop: { type: 'boolean' },
      serve: { type: 'boolean' },
      config: { type: 'string' },
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

  const { captures, skipped } = readNdjsonFile(file);
  if (skipped.length > 0) {
    // Named, not counted: a fixture is hand-scrubbed, and "3 lines were bad" is
    // not enough to go and fix them.
    console.error(`Skipped ${skipped.length} malformed line(s): ${skipped.slice(0, 10).join(', ')}`);
  }
  if (captures.length === 0) {
    console.error('Nothing to replay.');
    return 1;
  }

  const store = openStoreFor(values);
  const adapters = selectApps();
  const port = parsePort(values.port, fileConfig(values.config).port ?? config.DEFAULT_HTTP_PORT);
  const server = await startServer({ store, adapters, port, getSessions: () => [] });

  console.error(`Replaying ${captures.length} capture(s) at ${speed}x from ${file}`);
  if (values.serve) printServerBanner(server, 'none');

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
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const sub = positionals[0];
  if (values.help || !sub) {
    console.log(
      'sluice proxy <on|off|status> [--service NAME] [--proxy-port N] [--force]\n' +
        '  Toggle the macOS system web proxy so the desktop app routes through Sluice.\n' +
        '  `on`/`off` may need admin — if so, the exact `sudo networksetup …` command is printed.\n' +
        '  `on` refuses to replace a proxy someone else set; `off` only clears Sluice\'s own\n' +
        '  (loopback, --proxy-port) unless --force.',
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
      if (liveRunState()?.lanProxy) {
        console.error(LAN_PROXY_REFUSAL);
        return 1;
      }
      assertNoForeignProxy(await getProxyState(service), proxyPort);
      await setProxy(service, config.LOOPBACK_HOST, proxyPort);
      console.log(`System proxy ON → ${config.LOOPBACK_HOST}:${proxyPort} (service: ${service}).`);
      console.log('Now run `sluice start` to capture. Run `sluice proxy off` when you are done.');
      return 0;
    }
    if (sub === 'off') {
      // Only Sluice's own proxy, unless told otherwise: a bare clear would
      // disable a corporate proxy the user never asked Sluice to touch.
      const st = await getProxyState(service);
      if (!st.enabled) {
        console.log(`System proxy is already OFF (service: ${service}).`);
        return 0;
      }
      if (!isOurProxy(st, proxyPort) && !values.force) {
        console.error(
          `The system proxy points at ${st.host ?? '?'}:${st.port ?? '?'}, not Sluice's ${config.LOOPBACK_HOST}:${proxyPort}. ` +
            'Pass --proxy-port N if Sluice used another port, or --force to turn it off anyway.',
        );
        return 1;
      }
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

async function cmdCaInstall(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log("sluice ca-install\n  Generate (if needed) and trust Sluice's local CA in your login keychain.");
    return 0;
  }
  const { caPath } = await ensureSluiceCA();
  const keychain = join(homedir(), 'Library', 'Keychains', 'login.keychain-db');
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
  // Do not call ensureSluiceCA() — uninstall must not mint a brand-new CA just
  // to remove trust for one that may already be gone from disk.
  const caPath = sluiceCaCertPath();
  if (!existsSync(caPath)) {
    console.error(`No CA certificate at ${caPath}. Nothing to untrust (or already wiped).`);
    return 1;
  }
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
      ...STORE_OPTIONS,
      ...CRED_OPTIONS,
      adapter: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'sluice sync [--workspace NAME] [--adapter ID] [--token X --cookie Y] [--db PATH]\n' +
        '  Reconstruct structure (conversations.list + users.list) for EVERY signed-in\n' +
        '  workspace, or just one via --workspace <name|team-id>.\n' +
        '  --adapter limits it to one app, and names the app pasted --token/--cookie are\n' +
        '  for (default slack). `-` reads a value from stdin; SLUICE_TOKEN / SLUICE_COOKIE\n' +
        '  keep them out of ps and shell history.',
    );
    return 0;
  }
  if (!scopeApps(values.adapter)) return 1;

  let sessions: Session[];
  try {
    sessions = await extractAllSessions(values, values.adapter);
  } catch (e) {
    console.error(`No sessions: ${errMsg(e)}`);
    return 1;
  }
  if (sessions.length === 0) {
    console.error('No signed-in workspaces found.');
    return 1;
  }

  const picked = selectWorkspace(sessions, values.workspace);
  if (picked.length === 0) {
    console.error(`No workspace matching "${values.workspace}". Have: ${sessions.map((s) => s.label).join(', ')}`);
    return 1;
  }

  const store = openStoreFor(values);
  for (const s of picked) {
    store.upsertSession(redactSession(s));
    const app = apps.find((a) => a.id === s.adapterId);
    if (!app) continue;
    let containers = 0;
    let actors = 0;
    let items = 0;
    // Replay each app's no-argument "structure" actions (conversations.list,
    // users.list, …) — the ones with no required params.
    for (const action of structureActions(app)) {
      try {
        const r = persistCapture(store, await runReplayAction(store, app, action, defaultParams(action), s), app);
        const apiErr = apiErrorText(r.capture);
        if (apiErr) console.error(`  ${s.label} ${action.id}: ${apiErr}`);
        if (r.parseError !== undefined) console.error(`  ${s.label} ${action.id}: parse failed — ${errMsg(r.parseError)}`);
        containers += r.counts.containers;
        actors += r.counts.actors;
        items += r.counts.items;
      } catch (e) {
        console.error(`  ${s.label} ${action.id}: ${errMsg(e)}`);
      }
    }
    // Neutral nouns, items included.
    console.log(
      `${s.label}: +${containers} containers, +${actors} actors, +${items} items`,
    );
  }
  reconcileAll(store);
  materializeQuiet(store);
  store.close();
  return 0;
}

/** One page of the unattributed walk. Small enough that decoding bodies stays cheap. */
const REPARSE_PAGE = 500;

/**
 * Attribute and parse captures that landed before their app was installed.
 *
 * Attribution happens once, at capture time, so traffic recorded before an app
 * existed is stored with `adapter_id NULL` yet `parsed_at` set. Hence this is
 * keyed on `adapter_id IS NULL`, NOT on `parsed_at`.
 *
 * Walks OLDEST-FIRST because entity upserts are last-writer-wins, matching live
 * ingest order. Paged on a `(ts, id)` keyset: rows share a millisecond, and rows
 * this walk does not claim (--dry-run, --reapply, or traffic no selected app
 * matches) stay in the result set, so a `ts` bound alone repeats the same page.
 */
async function cmdReparse(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      adapter: { type: 'string' },
      ...STORE_OPTIONS,
      'dry-run': { type: 'boolean' },
      reapply: { type: 'boolean' },
      limit: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'sluice reparse [--adapter ID] [--dry-run] [--reapply] [--limit N] [--db PATH]\n' +
        '  Re-attribute captures no adapter claimed (adapter_id IS NULL) against the apps\n' +
        '  installed NOW, parse the ones that match into entities, and seed the worklist\n' +
        '  from them — the revisit that installing an app after capturing never got.\n' +
        '  Applies them oldest-first, so the newest observation of a row wins.\n' +
        '  --dry-run counts what each app would claim and writes nothing.\n' +
        '  --adapter restricts the claim to one app; other apps\' traffic stays unclaimed.\n' +
        '  --reapply (needs --adapter) re-derives entities from captures that app ALREADY\n' +
        '  owns, instead of unattributed ones. For healing a store whose rows were written\n' +
        '  out of order; it reads the same captures again and writes no new ones.',
    );
    return 0;
  }
  const adapters = scopeApps(values.adapter);
  if (!adapters) return 1;
  const dry = Boolean(values['dry-run']);
  const reapply = Boolean(values.reapply);
  if (reapply && !values.adapter) {
    // Without a scope this would re-derive every app in the store from every
    // capture it holds — a long, surprising operation to get from one flag.
    console.error('--reapply needs --adapter: name the app whose captures should be re-read.');
    return 1;
  }
  const max = values.limit ? Number(values.limit) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(max) && values.limit) {
    console.error(`--limit must be a number, got "${values.limit}".`);
    return 1;
  }

  const store = openStoreFor(values);
  const claimed = new Map<string, number>();
  const totals = { workspaces: 0, actors: 0, containers: 0, items: 0 };
  let scanned = 0;
  let unmatched = 0;
  let parseErrors = 0;
  let seeds = 0;
  let after: { ts: number; id: string } | undefined;

  while (scanned < max) {
    const page = store.listCaptures({
      ...(reapply ? { adapterId: values.adapter } : { unattributed: true }),
      limit: REPARSE_PAGE,
      order: 'asc',
      ...(after ? { after } : {}),
    });
    const last = page[page.length - 1];
    if (last === undefined) break;

    for (const c of page) {
      if (scanned >= max) break;
      scanned += 1;
      const adapter = matchAdapter(adapters, c);
      if (!adapter) {
        unmatched += 1;
        continue;
      }
      claimed.set(adapter.id, (claimed.get(adapter.id) ?? 0) + 1);
      if (dry) continue;

      // The same funnel as live ingest, re-classifying and re-stamping: the
      // upsert rewrites adapter_id, classification and parsed_at in place (and
      // re-redacts the row), and parsed_at is set only if this parse succeeds.
      c.parsedAt = Date.now();
      const r = persistCapture(store, c, adapter, { reclassify: true });
      if (r.parseError !== undefined) {
        parseErrors += 1;
        console.error(`  ${adapter.id} parse failed on ${c.id}: ${errMsg(r.parseError)}`);
      }
      totals.workspaces += r.counts.workspaces;
      totals.actors += r.counts.actors;
      totals.containers += r.counts.containers;
      totals.items += r.counts.items;
      seeds += r.seeded;
    }

    after = { ts: last.ts, id: last.id };
  }

  if (!dry) {
    reconcileAll(store);
    materializeQuiet(store);
  }
  store.close();

  const verb = dry ? (reapply ? 'would re-read' : 'would claim') : reapply ? 're-read' : 'claimed';
  const what = reapply ? `${values.adapter} capture(s)` : 'unattributed capture(s)';
  console.log(`${dry ? 'DRY RUN — ' : ''}scanned ${scanned} ${what}; ${unmatched} match no installed app.`);
  if (claimed.size === 0) {
    console.log(`No app ${verb} anything.`);
    return 0;
  }
  for (const [id, n] of [...claimed.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${id.padEnd(12)} ${verb} ${n}`);
  if (!dry) {
    console.log(
      `entities: workspaces=${totals.workspaces} actors=${totals.actors} containers=${totals.containers} items=${totals.items}; ` +
        `worklist +${seeds}${parseErrors ? `; ${parseErrors} parse error(s)` : ''}`,
    );
  }
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
  const store = openStoreFor(values);
  // Reconcile before deriving tables (idempotent, offline).
  reconcileAll(store);
  // The explicit full rebuild: drop first, so rows from captures since pruned do
  // not survive (materialize only upserts); it owns the watermark.
  const tables = rebuildMaterialized(store, apps.map((a) => a.id));
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
      ...STORE_OPTIONS,
      out: { type: 'string' },
      host: { type: 'string' },
      app: { type: 'string' },
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
  const store = openStoreFor(values);
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

/**
 * `sluice prune` — bound the capture store. Sluice captures ALL traffic with
 * bodies up to 5 MB, so the DB otherwise grows without bound.
 */
async function cmdPrune(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      ...STORE_OPTIONS,
      days: { type: 'string' },
      'max-rows': { type: 'string' },
      vacuum: { type: 'boolean' },
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

  const store = openStoreFor(values);
  const before = store.countCaptures();
  const removed = store.pruneCaptures({
    maxAgeMs: days === undefined ? undefined : days * 24 * 60 * 60 * 1000,
    maxRows,
  });
  if (removed > 0) {
    // The derived tables still hold rows (message text included) for what was
    // just deleted — materialize never deletes — so drop and rebuild them. The
    // full registry, so a disabled app's derived rows go too.
    const t = rebuildMaterialized(store, apps.map((a) => a.id));
    console.log(`Rebuilt ${t.length} derived table(s).`);
  }
  // After the rebuild, so VACUUM also reclaims the dropped tables' pages.
  if (values.vacuum && removed > 0) store.vacuum();
  const after = store.countCaptures();
  store.close();
  console.log(`Pruned ${removed} capture(s): ${before} → ${after}.`);
  return 0;
}

/** `sluice wipe` — the panic button, the mechanism behind "reversible trust" (SECURITY.md). */
async function cmdWipe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      ...STORE_OPTIONS,
      all: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
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

  const dbPath = resolveDb(values.db);
  const targets: string[] = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  // The CA lives beside sluiceCaCertPath() (on macOS under
  // ~/Library/Application Support/Sluice, not ~/.sluice).
  const caPath = sluiceCaCertPath();
  const caDir = dirname(caPath);
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
      if (existsSync(caPath)) {
        execFileSync('/usr/bin/security', ['remove-trusted-cert', '-d', caPath], { stdio: 'ignore' });
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

/**
 * Turn an installed app on or off by editing `~/.sluice/config.json`. The
 * allow-list decides **which hosts the proxy decrypts**, so it is one command
 * that prints what changed. It writes the home config, not the nearest repo
 * config, so the change applies everywhere.
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
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writePrivateFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const enabled = apps.filter((a) => next.includes(a.id));
  console.log(`${action === 'enable' ? 'Enabled' : 'Disabled'} ${id}. Now active: ${next.join(', ')}`);
  console.log(`Proxy will decrypt: ${enabled.flatMap((a) => a.hosts).join(', ')}`);
  console.log(`Written to ${configPath}`);
  return 0;
}

/** `sluice adapters` — what this build can capture, and how each authenticates. */
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
  const selected = selectApps();
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
  /** True when Engine A was started with `--lan-proxy` (0.0.0.0). */
  lanProxy?: boolean;
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
    writePrivateFile(statePath(), JSON.stringify(st, null, 2));
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

/** The run state of a runner that is still alive — never a file a SIGKILL or power loss left behind. */
function liveRunState(): RunState | undefined {
  const st = readRunState();
  return st && pidAlive(st.pid) ? st : undefined;
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
  // A clean shutdown clears its own state and restores the system proxy;
  // --force cannot, so do both here when we know the proxy port.
  if (values.force) {
    if (typeof st.proxyPort === 'number' && st.proxyPort > 0) await restoreSystemProxyIfOurs(st.proxyPort);
    clearRunState();
  }
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
      ...STORE_OPTIONS,
      app: { type: 'string' },
      json: { type: 'boolean' },
      hints: { type: 'boolean' },
      config: { type: 'string' },
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

  const store = openStoreFor(values);
  const captures = store.listCaptures({ limit: 1_000_000, adapterId: values.app });
  const flow = mapAuthFlow(captures, values.app ?? null);

  let hints: CredentialHint[] = [];
  if (values.hints) {
    const adapters = selectApps(); // once, not per capture: it re-reads ~/.sluice/config.json
    const seen = new Map<string, CredentialHint>();
    for (const h of captures.flatMap((c) => reconstructCredentials(c, adapters))) {
      const key = `${h.location}\u0000${h.name}`;
      if (!seen.has(key)) seen.set(key, h); // the first occurrence wins
    }
    hints = [...seen.values()].sort((a, b) => b.confidence - a.confidence);
  }
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
        ...STORE_OPTIONS,
      },
    });
    if (values.help) return cmdFlows(['help']);
    const store = openStoreFor(values);
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
        const primaryOp = primaryOperation(f) ?? '?';
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
    const store = openStoreFor(values);
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
    const store = openStoreFor(values);
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
            ...templateStepSummary(s),
            params: paramSourcesSummary(s.params),
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
    const store = openStoreFor(values);
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
        ...STORE_OPTIONS,
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
    const store = openStoreFor(values);
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
      ...STORE_OPTIONS,
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

  const store = openStoreFor(values);
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
      // So a template never carries a non-GET step its app does not declare as a
      // read — the build rail would refuse it at replay anyway.
      adapters: apps,
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
  reparse         Attribute + parse captures recorded before their app was installed (adapter_id NULL).
  apidoc          Render an endpoint catalog (Markdown) from captured traffic.
  replay          Run one replay action by id, --flow <template>, or --all to drain cursors.
  flows           List / show / pin interaction flows and learned templates.
  learn-flows     Cluster captures into flows and refresh multi-step templates.
  export          Dump a container's items: json | ndjson | markdown | sqlite.
  record          Dump captures as NDJSON for the mock runner (credential-free replay).
  mock            Replay a recorded NDJSON fixture through the real ingest path.
  auth            Map how a service authenticates you, from captured traffic. No secrets.
  app             List, enable or disable installed apps (which hosts the proxy decrypts).
  adapters        List installed apps: hosts, credential source, replay actions, MCP tools.
  status          Is a runner serving? Report pid/port/uptime and store size.
  stop            Ask a running runner to shut down (--force to SIGKILL).
  prune           Delete old captures: --days N and/or --max-rows N [--vacuum].
  wipe            THE PANIC BUTTON: delete the capture DB; --all also removes the CA + Chrome profile.

Common options:
  -h, --help      Show help (also works per-command)
  --db PATH       SQLite path (default ~/.sluice/sluice.db)
  --port N        HTTP+WS port (default 7788; serve, start, capture, mock)
  --config PATH   Config file (serve, start, mock, status, auth, adapters; default: nearest sluice.config.json, then ~/.sluice/config.json)

macOS is the primary target; token extraction is macOS-only (use --token/--cookie elsewhere).

Sluice is unfunded: https://github.com/sponsors/YasserShkeir`;

const COMMANDS = new Map<string, (args: string[]) => Promise<number>>([
  ['doctor', cmdDoctor],
  ['extract-token', cmdExtractToken],
  ['serve', cmdServe],
  ['start', cmdStart],
  ['capture', cmdCapture],
  ['proxy', cmdProxy],
  ['ca-install', cmdCaInstall],
  ['ca-uninstall', cmdCaUninstall],
  ['sync', cmdSync],
  ['build-db', cmdBuildDb],
  ['reparse', cmdReparse],
  ['apidoc', cmdApiDoc],
  ['replay', cmdReplay],
  ['flows', cmdFlows],
  ['learn-flows', cmdLearnFlows],
  ['record', cmdRecord],
  ['mock', cmdMock],
  ['export', cmdExport],
  ['prune', cmdPrune],
  ['wipe', cmdWipe],
  ['adapters', cmdAdapters],
  ['app', cmdApp],
  ['auth', cmdAuth],
  ['status', cmdStatus],
  ['stop', cmdStop],
]);

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  const run = COMMANDS.get(cmd);
  if (run) return run(rest);
  console.error(`Unknown command "${cmd}".\n`);
  console.log(USAGE);
  return 1;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((e) => {
    console.error(errMsg(e));
    process.exitCode = 1;
  });
