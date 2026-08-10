// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * macOS system-proxy helper.
 *
 * Toggles the OS-level HTTP/HTTPS web proxy so a desktop app (which,
 * unlike Chrome, offers no `--proxy-server` flag once launched normally) routes
 * its HTTPS through Sluice's local MITM proxy. Everything here shells out to the
 * stock macOS `networksetup`/`route` binaries via `node:child_process` — no deps.
 *
 * Security / discipline:
 *   - READ paths (`detectNetworkService`, `getProxyState`) never touch a secret
 *     and never need sudo.
 *   - WRITE paths (`setProxy`, `clearProxy`) need admin. We NEVER auto-spawn
 *     sudo; on a permission failure we throw an Error whose message contains the
 *     exact `sudo networksetup …` commands for the user to run themselves.
 *   - macOS (darwin) only — every export throws a clear error elsewhere.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Stock macOS binaries (absolute paths, matching the rest of the runner). */
const NETWORKSETUP = '/usr/sbin/networksetup';
const ROUTE = '/sbin/route';

/** Fallback service name when the active-service probe comes up empty. */
const DEFAULT_SERVICE = 'Wi-Fi';

/** The current state of a network service's *secure* (HTTPS) web proxy. */
export interface ProxyState {
  enabled: boolean;
  host?: string;
  port?: number;
}

function assertDarwin(): void {
  if (process.platform !== 'darwin') {
    throw new Error('Sluice system-proxy control is macOS (darwin) only.');
  }
}

async function run(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, args);
  return stdout;
}

/**
 * The network service (e.g. 'Wi-Fi') carrying the default route.
 *
 * `route -n get default` → the `interface:` line (e.g. en0), then match that
 * device against `networksetup -listnetworkserviceorder`'s
 * `(Hardware Port: …, Device: enN)` blocks to recover the human service name on
 * the line above. Falls back to 'Wi-Fi' if anything about detection fails.
 */
export async function detectNetworkService(): Promise<string> {
  assertDarwin();
  try {
    const iface = await defaultInterface();
    if (iface) {
      const service = await serviceForInterface(iface);
      if (service) return service;
    }
  } catch {
    /* detection is best-effort — fall through to the default */
  }
  return DEFAULT_SERVICE;
}

async function defaultInterface(): Promise<string | undefined> {
  const out = await run(ROUTE, ['-n', 'get', 'default']);
  const m = out.match(/^\s*interface:\s*(\S+)/m);
  return m?.[1];
}

async function serviceForInterface(iface: string): Promise<string | undefined> {
  const out = await run(NETWORKSETUP, ['-listnetworkserviceorder']);
  let currentName: string | undefined;
  for (const line of out.split('\n')) {
    // `(1) Wi-Fi` or `(*) Some Disabled Service` — the service name line.
    const nameMatch = line.match(/^\((?:\*|\d+)\)\s*(.+?)\s*$/);
    if (nameMatch?.[1]) {
      currentName = nameMatch[1];
      continue;
    }
    // `(Hardware Port: Wi-Fi, Device: en0)` — the paired device line.
    const devMatch = line.match(/Device:\s*([^)]*)\)/);
    if (devMatch && devMatch[1]?.trim() === iface && currentName) {
      return currentName;
    }
  }
  return undefined;
}

/**
 * Read (no sudo) the secure web-proxy state for a service via
 * `networksetup -getsecurewebproxy <service>`.
 */
export async function getProxyState(service: string): Promise<ProxyState> {
  assertDarwin();
  const out = await run(NETWORKSETUP, ['-getsecurewebproxy', service]);
  // Use horizontal-only whitespace ([ \t]) — a bare `\s*` would swallow the
  // newline and capture the *next* line's value when a field is blank.
  const enabled = /^Enabled:[ \t]*Yes\b/im.test(out);
  const serverMatch = out.match(/^Server:[ \t]*(.*)$/im);
  const portMatch = out.match(/^Port:[ \t]*(\d+)/im);
  const host = serverMatch?.[1]?.trim();
  const portNum = portMatch?.[1] ? Number.parseInt(portMatch[1], 10) : Number.NaN;
  const state: ProxyState = { enabled };
  if (host) state.host = host;
  if (Number.isFinite(portNum) && portNum > 0) state.port = portNum;
  return state;
}

function validateHostPort(host: string, port: number): void {
  if (!host.trim()) throw new Error('setProxy: host must be a non-empty string.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`setProxy: port must be an integer 1–65535 (got ${String(port)}).`);
  }
}

/**
 * Point the service's HTTP *and* HTTPS proxy at `host:port`. `networksetup`
 * auto-enables both when you set a server, so no separate on-toggle is needed.
 *
 * Needs admin. We do NOT spawn sudo ourselves: on a permission failure the
 * thrown Error carries the exact `sudo networksetup …` commands to run by hand.
 */
export async function setProxy(service: string, host: string, port: number): Promise<void> {
  assertDarwin();
  validateHostPort(host, port);
  const value = [service, host, String(port)];
  try {
    await run(NETWORKSETUP, ['-setwebproxy', ...value]);
    await run(NETWORKSETUP, ['-setsecurewebproxy', ...value]);
  } catch (e) {
    throw proxyMutationError(e, service, [
      `sudo networksetup -setwebproxy "${service}" ${host} ${port}`,
      `sudo networksetup -setsecurewebproxy "${service}" ${host} ${port}`,
    ]);
  }
}

/**
 * Turn the service's HTTP + HTTPS proxy off (leaves the stored host/port, just
 * disables them). Same admin requirement + sudo-fallback message as `setProxy`.
 */
export async function clearProxy(service: string): Promise<void> {
  assertDarwin();
  try {
    await run(NETWORKSETUP, ['-setwebproxystate', service, 'off']);
    await run(NETWORKSETUP, ['-setsecurewebproxystate', service, 'off']);
  } catch (e) {
    throw proxyMutationError(e, service, [
      `sudo networksetup -setwebproxystate "${service}" off`,
      `sudo networksetup -setsecurewebproxystate "${service}" off`,
    ]);
  }
}

// ── error shaping ────────────────────────────────────────────────────────────

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const o = e as { stderr?: unknown; message?: unknown };
    if (typeof o.stderr === 'string' && o.stderr.trim()) return o.stderr.trim();
    if (typeof o.message === 'string' && o.message) return o.message;
  }
  return String(e);
}

function isPermissionError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const o = e as { code?: unknown; stderr?: unknown; message?: unknown };
  if (o.code === 'EACCES' || o.code === 'EPERM') return true;
  const text = `${typeof o.stderr === 'string' ? o.stderr : ''} ${
    typeof o.message === 'string' ? o.message : ''
  }`.toLowerCase();
  return /not allowed|not permitted|permission denied|operation not permitted|must be run as root|requires? admin|eacces|eperm/.test(
    text,
  );
}

function proxyMutationError(e: unknown, service: string, sudoCmds: string[]): Error {
  const hint = `Run these manually with administrator rights:\n  ${sudoCmds.join('\n  ')}`;
  if (isPermissionError(e)) {
    return new Error(
      `Changing the system proxy for "${service}" requires administrator privileges. ${hint}`,
    );
  }
  return new Error(`networksetup failed for "${service}": ${errText(e)}\n${hint}`);
}
