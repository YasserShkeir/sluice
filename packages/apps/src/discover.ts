// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loading an adapter that did not ship with Sluice.
 *
 * ## Why this is not `sluice-adapter-*` auto-discovery
 *
 * The obvious design — scan `node_modules` for packages matching a name pattern
 * and load them — is indefensible here, and for a stronger reason than the usual
 * supply-chain argument. The dangerous surface is DECLARATIVE, and it is honoured
 * before a single line of the adapter's code runs:
 *
 *   - `hosts[]` seeds the proxy's TLS-intercept list. An adapter that declares
 *     `["mail.google.com"]` does not have to do anything clever; it has just put
 *     Sluice in the middle of your mail, and the CA is already trusted.
 *   - `redaction.publicParams` names query params that must SURVIVE redaction.
 *     An adapter that declares someone else's token param public un-redacts it
 *     for every capture in the store, because redaction runs globally before a
 *     capture is attributed to any adapter.
 *
 * And the process an adapter is loaded into holds live session cookies in memory.
 * A name-pattern scan makes "install a package" and "hand it your mail" the same
 * action, silently, on a machine where a transitive dependency can add a package.
 *
 * So discovery is EXPLICIT: an adapter is loaded because a config file names it,
 * and no other reason.
 *
 * ## Why only from the home config
 *
 * `loadConfig` walks UP from the working directory before falling back to
 * `~/.sluice/config.json`, which is right for `proxyPort` and wrong for this: a
 * repo you cloned could ship a `sluice.config.json`, and running `sluice start`
 * inside it would load whatever that file named. That is auto-discovery again,
 * wearing a config file. External adapters are read from the HOME config only —
 * a path that requires the person running Sluice to have edited a file under
 * their own home directory.
 *
 * ## What is checked before an adapter is trusted with anything
 *
 * The conformance harness, at load. It is a CORRECTNESS check and not a security
 * boundary, and must not be sold as one — it proves an adapter does not throw on
 * hostile input and does not claim lookalike hosts. It cannot prove the adapter
 * is not malicious. What actually protects you is that you named it yourself,
 * and that the hosts it adds are printed rather than assumed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { App } from '@sluice/core';

/** Where an external adapter may be named. Deliberately one path. */
export function externalConfigPath(home = homedir()): string {
  return join(home, '.sluice', 'config.json');
}

export interface DiscoveredAdapter {
  /** The specifier as written in the config — what a person would recognise. */
  specifier: string;
  app: App;
  /** Hostnames this adapter adds to the TLS-intercept list. Disclosed, not assumed. */
  hosts: string[];
}

export interface RejectedAdapter {
  specifier: string;
  /** One line, trimmed for a terminal. See `problems` for the full list. */
  reason: string;
  /** Every conformance finding, when that is why it was rejected. */
  problems?: string[];
}

/** How many conformance findings the one-line summary shows. */
const MAX_SHOWN_PROBLEMS = 2;

export interface DiscoveryResult {
  loaded: DiscoveredAdapter[];
  rejected: RejectedAdapter[];
  /** The config that named them, when one existed. */
  configPath?: string;
}

/**
 * A minimal structural check on something an external module handed back.
 *
 * Deliberately not a conformance run — that is the caller's next step and it is
 * expensive. This is the "is it even an adapter?" gate, and it exists because
 * the failure it prevents is ugly: an object missing `matchRequest` reaches the
 * ingest funnel and throws on the first capture, taking down capture rather than
 * load.
 */
export function looksLikeApp(v: unknown): v is App {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Partial<App>;
  return (
    typeof a.id === 'string' &&
    a.id.length > 0 &&
    typeof a.displayName === 'string' &&
    Array.isArray(a.hosts) &&
    a.hosts.every((h) => typeof h === 'string') &&
    typeof a.matchRequest === 'function' &&
    typeof a.parse === 'function' &&
    typeof a.listReplayActions === 'function' &&
    typeof a.buildReplayRequest === 'function'
  );
}

/** The `externalAdapters` list from the HOME config, or [] when there is none. */
export function readExternalSpecifiers(configPath = externalConfigPath()): {
  specifiers: string[];
  configPath?: string;
} {
  if (!existsSync(configPath)) return { specifiers: [] };
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return { specifiers: [], configPath };
    const raw = (parsed as { externalAdapters?: unknown }).externalAdapters;
    if (!Array.isArray(raw)) return { specifiers: [], configPath };
    return {
      specifiers: raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0),
      configPath,
    };
  } catch {
    // A malformed config must not stop Sluice starting with its built-in apps.
    return { specifiers: [], configPath };
  }
}

/**
 * The `adapters` allow-list from the home config, or undefined for "all".
 *
 * Read from the same file `externalAdapters` comes from, and read by BOTH the
 * CLI and the MCP server — which is the point. The list existed and only the CLI
 * honoured it, so `sluice start` would capture Slack alone while `sluice-mcp`
 * went on advertising every app's tools. One switch that half the product obeys
 * is worse than no switch: it reads as if it worked.
 *
 * Undefined and empty both mean "all installed apps". An allow-list that
 * silently meant "none" would be a footgun in a file people hand-edit.
 */
export function readEnabledAdapterIds(configPath = externalConfigPath()): string[] | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { adapters?: unknown };
    if (!Array.isArray(parsed.adapters)) return undefined;
    const ids = parsed.adapters.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

export interface DiscoverOptions {
  /** Overridden in tests; defaults to the home config. */
  configPath?: string;
  /** Ids already taken by the built-ins. An external adapter may not shadow one. */
  taken?: Set<string>;
  /** Overridden in tests so nothing is actually imported from disk. */
  load?: (specifier: string) => Promise<unknown>;
  /**
   * Run after the structural check. Returning a non-empty list rejects the
   * adapter, with the problems as the reason. The caller supplies it so this
   * module does not depend on the test-bound harness in `@sluice/adapter-sdk`.
   */
  check?: (app: App) => string[];
}

/**
 * Load every adapter the home config names, rejecting the ones that do not hold
 * up. Never throws: a bad entry is a rejection, not a failure to start.
 */
export async function discoverAdapters(opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const { specifiers, configPath } = readExternalSpecifiers(opts.configPath);
  const result: DiscoveryResult = { loaded: [], rejected: [] };
  if (configPath !== undefined) result.configPath = configPath;
  if (specifiers.length === 0) return result;

  const taken = new Set(opts.taken ?? []);
  const load = opts.load ?? ((s: string) => import(resolveSpecifier(s)));

  for (const specifier of specifiers) {
    let mod: unknown;
    try {
      mod = await load(specifier);
    } catch (e) {
      result.rejected.push({ specifier, reason: `could not be imported: ${msg(e)}` });
      continue;
    }

    const app = pickApp(mod);
    if (app === undefined) {
      result.rejected.push({
        specifier,
        reason: 'exported no Sluice app (expected a default export, or a named `app`, that has id/hosts/matchRequest/parse)',
      });
      continue;
    }
    // Id collisions decide who gets attributed which traffic, and the built-ins
    // must win: an external adapter taking `slack` would silently become the
    // parser for every Slack capture, and the store keys entities by adapter id.
    if (taken.has(app.id)) {
      result.rejected.push({ specifier, reason: `id "${app.id}" is already registered` });
      continue;
    }

    const problems = opts.check?.(app) ?? [];
    if (problems.length > 0) {
      // Every problem is kept — `--json` prints them all — but the SUMMARY is
      // trimmed. One broken `parse` produces a dozen findings (a hostile-body
      // matrix hits it once per body), and a paragraph of near-identical lines
      // buries the first one, which is the one that says what is wrong.
      const shown = problems.slice(0, MAX_SHOWN_PROBLEMS);
      const more = problems.length - shown.length;
      result.rejected.push({
        specifier,
        reason: `failed conformance: ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`,
        problems,
      });
      continue;
    }

    taken.add(app.id);
    result.loaded.push({ specifier, app, hosts: [...app.hosts] });
  }
  return result;
}

/**
 * A bare path is resolved as a FILE, everything else as a package.
 *
 * `import('./my-adapter.js')` inside a bundle resolves against the bundle's own
 * location, not the user's project — so a relative specifier in a config file
 * would mean something different depending on where Sluice was installed from.
 * Absolute and `~`-prefixed paths become file URLs; anything else is left for
 * Node's resolver, which is what a package name should get.
 */
export function resolveSpecifier(specifier: string, home = homedir()): string {
  const s = specifier.startsWith('~/') ? join(home, specifier.slice(2)) : specifier;
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) return pathToFileURL(s).href;
  return s;
}

/** The app on a module: `default`, or a named `app`. Nothing else is guessed at. */
function pickApp(mod: unknown): App | undefined {
  if (typeof mod !== 'object' || mod === null) return undefined;
  const m = mod as { default?: unknown; app?: unknown };
  for (const candidate of [m.default, m.app]) {
    if (looksLikeApp(candidate)) return candidate;
  }
  return undefined;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * One line per external adapter, for the CLI to print at startup.
 *
 * The HOSTS are the point of this, not the count. An external adapter widens
 * what the proxy decrypts, and that is the most privacy-relevant thing loading
 * one does — so it is stated every time, rather than left for someone to find by
 * reading a config file they edited months ago.
 */
export function describeDiscovery(result: DiscoveryResult): string[] {
  const lines: string[] = [];
  for (const d of result.loaded) {
    lines.push(
      `external adapter ${d.app.id} (${d.specifier}) — decrypting ${
        d.hosts.length > 0 ? d.hosts.join(', ') : 'no hosts'
      }`,
    );
  }
  for (const r of result.rejected) lines.push(`external adapter ${r.specifier} REJECTED: ${r.reason}`);
  return lines;
}
