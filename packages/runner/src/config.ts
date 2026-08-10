// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Default paths, ports, and `~/.sluice` handling for the runner.
 *
 * Everything here is pure path math — nothing reads a secret, and nothing is
 * app-specific. Per-service desktop locations live in their app packages.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** App version reported to the webapp in the WS `hello` frame. */
export const APP_VERSION = '0.1.0';

/** Default loopback bind address — never anything else. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Default HTTP + WS port for the runner (single origin, single listener). */
export const DEFAULT_HTTP_PORT = 7788;

/** Default MITM proxy port for `sluice start`. */
export const DEFAULT_PROXY_PORT = 8080;

/** Default Chrome remote-debugging port for `sluice capture` (Engine C). */
export const DEFAULT_CDP_PORT = 9222;

/** `~/.sluice` — the one place Sluice writes (DB, never secrets). */
export function sluiceHome(): string {
  return join(homedir(), '.sluice');
}

/** Create `~/.sluice` if missing; returns the path. */
export function ensureSluiceHome(): string {
  const dir = sluiceHome();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Default SQLite path: `~/.sluice/sluice.db`. */
export function defaultDbPath(): string {
  return join(sluiceHome(), 'sluice.db');
}

/**
 * Absolute path to the built dashboard.
 *
 * Two layouts have to work. In a published package the build copies the assets to
 * `dist/webapp` next to the bundle, because the workspace-relative path below
 * points outside the tarball and would 404 every asset. In the workspace we run
 * from `src/`, so fall back to `apps/webapp/dist`.
 */
export function webappDistDir(): string {
  const shipped = fileURLToPath(new URL('./webapp/', import.meta.url));
  if (existsSync(shipped)) return shipped;
  return fileURLToPath(new URL('../../../apps/webapp/dist/', import.meta.url));
}

// ── Config file ──────────────────────────────────────────────────────────────

/**
 * The typed shape of `sluice.config.json`.
 *
 * Only JSON is loaded. A `.ts` config would need a transpiler dependency (jiti
 * or similar) at runtime, and the settings here are all plain scalars — the
 * types are the useful part, not the ability to compute a value.
 */
export interface SluiceConfig {
  /** SQLite path (default `~/.sluice/sluice.db`). */
  db?: string;
  /** HTTP + WS port for the runner. */
  port?: number;
  /** MITM proxy port for `sluice start`. */
  proxyPort?: number;
  /** Chrome remote-debugging port for `sluice capture`. */
  cdpPort?: number;
  /** Restrict the installed apps to this allow-list of adapter ids. */
  adapters?: string[];
  /** Drop captures older than this many days on startup. */
  retentionDays?: number;
  /** Keep at most this many captures. */
  maxCaptures?: number;
  /**
   * Reserved: intended cap for a single stored request/response body, in bytes.
   * Engines currently hard-cap at 5_000_000 chars in interceptor; this config
   * key is accepted for forward compatibility and is not yet threaded through.
   */
  maxBodyBytes?: number;
  /**
   * Extra hostnames to decrypt when TLS scoping is on (see `interceptAllHosts`).
   * Wildcards follow URLPattern (`*.notion.so`). Combined with installed
   * adapters' hosts. A non-empty list implies scoped intercept unless
   * `interceptAllHosts` is explicitly true.
   */
  interceptHosts?: string[];
  /**
   * Decrypt every host rather than the adapter/extra list.
   * **Default when omitted: true** — unknown services are captured without an
   * adapter. Set `false` (or pass `--host` / `interceptHosts` without forcing
   * all-hosts) to limit TLS termination and leave other traffic opaque.
   */
  interceptAllHosts?: boolean;
}

/**
 * Resolve MITM TLS scope: CLI → config → default (all hosts).
 *
 * - Default / explicit all-hosts → decrypt everything.
 * - Any `--host` / `interceptHosts` entry → scoped to adapters + those hosts
 *   (unless all-hosts is forced on).
 * - `interceptAllHosts: false` → scoped even with an empty host list.
 */
export function resolveInterceptScope(input: {
  config: SluiceConfig;
  /** Repeatable `--host` values from the CLI. */
  cliHosts?: string[];
  /** `--all-hosts` when the user passed the flag; omit when absent. */
  cliAllHosts?: boolean;
}): { interceptHosts: string[]; interceptAllHosts: boolean } {
  const interceptHosts = [...(input.config.interceptHosts ?? []), ...(input.cliHosts ?? [])];
  if (input.cliAllHosts === true || input.config.interceptAllHosts === true) {
    return { interceptHosts, interceptAllHosts: true };
  }
  if (input.config.interceptAllHosts === false) {
    return { interceptHosts, interceptAllHosts: false };
  }
  if (interceptHosts.length > 0) {
    return { interceptHosts, interceptAllHosts: false };
  }
  return { interceptHosts, interceptAllHosts: true };
}

/** Identity helper so a config author gets type-checking and completion. */
export function defineConfig(config: SluiceConfig): SluiceConfig {
  return config;
}

const CONFIG_BASENAMES = ['sluice.config.json', '.sluicerc.json'];

/**
 * Resolve a config file: an explicit `--config` path wins, then the nearest
 * `sluice.config.json` walking up from the CWD (so a repo-local config works
 * from any subdirectory), then `~/.sluice/config.json`.
 *
 * Returns an empty object when there is none — a config file is entirely
 * optional, and every setting also has a CLI flag.
 */
export function loadConfig(explicitPath?: string): { config: SluiceConfig; path?: string } {
  const candidates: string[] = [];
  if (explicitPath) candidates.push(resolve(explicitPath));
  else {
    let dir = process.cwd();
    for (;;) {
      for (const base of CONFIG_BASENAMES) candidates.push(join(dir, base));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    candidates.push(join(sluiceHome(), 'config.json'));
  }

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('config must be a JSON object');
      }
      return { config: parsed as SluiceConfig, path };
    } catch (e) {
      // A malformed config is a hard error: silently falling back to defaults
      // would run with settings the user believes they overrode.
      throw new Error(`Invalid config at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (explicitPath) throw new Error(`Config file not found: ${explicitPath}`);
  return { config: {} };
}
