// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chrome (macOS) session-cookie reader — shared by Trello, Loom, LinkedIn, Notion.
 *
 * Discovers the first Chrome profile that holds cookies for `domainSuffix` (or,
 * with `requireCookie`, a specific session cookie), decrypts them via
 * {@link decryptOscryptV10} + Chrome Safe Storage, and assembles a `Cookie:`
 * header. App packages keep only domain-specific labels and any header
 * post-processing (e.g. LinkedIn CSRF, Notion's active user).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  decryptOscryptV10,
  keychainPassphrase,
  withCopiedSqliteDb,
} from './oscrypt.js';
import { errorMessage } from './util.js';

/** Chrome's default profile directory names, in preference order. */
const CHROME_PROFILES = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'] as const;

const CHROME_SAFE_STORAGE = 'Chrome Safe Storage';
const CHROME_ACCOUNT = 'Chrome';

export interface ChromeCookieHeader {
  /** `name1=value1; name2=value2` — SECRET; never persist, stream, or log. */
  cookieHeader: string;
  /** Chrome profile the cookies were read from (e.g. 'Default'). */
  profile: string;
}

export interface ReadChromeCookieHeaderOptions {
  /**
   * Registrable domain without a leading dot, e.g. `trello.com`.
   * Matches `host`, `.host`, and `*.host` host_key rows.
   */
  domainSuffix: string;
  /** Human label for error messages (`Trello`, `Loom`, …). Defaults to domain. */
  serviceLabel?: string;
  /** Override Chrome user-data root (tests). */
  chromeUserDataDir?: string;
}

/** A decrypted Chrome cookie. `value` is SECRET — never persist, stream, or log. */
export interface ChromeCookie {
  name: string;
  host: string;
  value: string;
}

/**
 * Thrown when no Chrome profile holds a session for the domain — "not signed
 * in", which a credential provider reports as no sessions rather than as an
 * error. Identified by `code` (see {@link isNoSessionError}), so it still works
 * when two copies of `@sluice/core` are loaded (an external adapter, a bundle).
 */
export class NoChromeSessionError extends Error {
  readonly code = 'SLUICE_NO_CHROME_SESSION';
  constructor(message: string) {
    super(message);
    this.name = 'NoChromeSessionError';
  }
}

/**
 * "No session here" (report no sessions) vs "could not read it" (a locked DB, a
 * denied Keychain, a decrypt error — which must not look like being signed out).
 * True for {@link NoChromeSessionError} by code, or a no-profile / not-signed-in /
 * not-found / ENOENT message; false for "no decryptable … cookies".
 */
export function isNoSessionError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === 'SLUICE_NO_CHROME_SESSION') return true;
  return /no chrome profile|not signed in|not found|does not exist|ENOENT/i.test(errorMessage(err));
}

/** `host`, `.host` and `*.host` rows, as BOUND parameters — the suffix is never interpolated into SQL. */
const HOST_MATCH = '(host_key = @d OR host_key = @dotD OR host_key LIKE @likeD)';

function hostParams(domainSuffix: string): { d: string; dotD: string; likeD: string } {
  return { d: domainSuffix, dotD: `.${domainSuffix}`, likeD: `%.${domainSuffix}` };
}

function chromeBase(override?: string): string {
  return override ?? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

/**
 * Passive probe: first Chrome profile whose Cookies DB holds rows for the domain.
 * Does not decrypt and never triggers Keychain.
 *
 * `requireCookie`: only count profiles holding this cookie name (e.g. a session
 * cookie), so a profile that merely visited the site is skipped. Bound, never
 * interpolated.
 */
export function locateChromeProfile(
  domainSuffix: string,
  opts: { chromeUserDataDir?: string; requireCookie?: string } = {},
): { profile: string; cookiesPath: string } | undefined {
  const base = chromeBase(opts.chromeUserDataDir);
  const sql = `SELECT COUNT(*) AS n FROM cookies WHERE ${opts.requireCookie ? 'name = @name AND ' : ''}${HOST_MATCH}`;
  const bind = opts.requireCookie
    ? { ...hostParams(domainSuffix), name: opts.requireCookie }
    : hostParams(domainSuffix);
  for (const profile of CHROME_PROFILES) {
    const cookiesPath = join(base, profile, 'Cookies');
    if (!existsSync(cookiesPath)) continue;
    const has = withCopiedSqliteDb(cookiesPath, (db) => {
      const row = db.prepare(sql).get(bind) as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    });
    if (has) return { profile, cookiesPath };
  }
  return undefined;
}

/**
 * Locate the first Chrome profile signed in for `domainSuffix`, decrypt its
 * cookies, and return a ready-to-send `Cookie:` header.
 *
 * macOS-only (throws elsewhere). Cookie values are never logged.
 */
export function readChromeCookieHeader(opts: ReadChromeCookieHeaderOptions): ChromeCookieHeader {
  if (process.platform !== 'darwin') {
    throw new Error(
      `readChromeCookieHeader supports macOS (darwin) only — Chrome cookie decryption goes through the macOS Keychain.`,
    );
  }

  const label = opts.serviceLabel ?? opts.domainSuffix;
  const located = locateChromeProfile(opts.domainSuffix, {
    chromeUserDataDir: opts.chromeUserDataDir,
  });
  if (!located) {
    throw new NoChromeSessionError(
      `No Chrome profile with ${opts.domainSuffix} cookies found — open https://${opts.domainSuffix} in Google Chrome and sign in first.`,
    );
  }

  const cookies = readChromeCookies(located.cookiesPath, opts.domainSuffix);
  const cookieHeader = buildChromeCookieHeader(cookies, opts.domainSuffix);
  if (!cookieHeader) {
    throw new Error(
      `Chrome profile "${located.profile}" had no decryptable ${opts.domainSuffix} cookies — is your ${label} session in this profile?`,
    );
  }
  return { cookieHeader, profile: located.profile };
}

/**
 * Decrypt every cookie for `domainSuffix` (`host`, `.host`, `*.host`) in one
 * Chrome Cookies DB. Reads Chrome Safe Storage from the Keychain — which
 * triggers the macOS consent prompt — and zeroes the passphrase afterwards.
 * macOS-only. Returns SECRET values: never persist, stream, or log them.
 * Cookies that do not decrypt are skipped, not reported.
 */
export function readChromeCookies(cookiesPath: string, domainSuffix: string): ChromeCookie[] {
  const pass = keychainPassphrase(CHROME_SAFE_STORAGE, CHROME_ACCOUNT);
  try {
    return withCopiedSqliteDb(cookiesPath, (db) => {
      const rows = db
        .prepare(`SELECT name, host_key, encrypted_value FROM cookies WHERE ${HOST_MATCH}`)
        .all(hostParams(domainSuffix)) as Array<{ name: string; host_key: string; encrypted_value: Buffer }>;
      const out: ChromeCookie[] = [];
      for (const r of rows) {
        try {
          out.push({ name: r.name, host: r.host_key, value: decryptOscryptV10(r.encrypted_value, pass) });
        } catch {
          // Skip cookies we can't decrypt (non-v10 / unrelated encoding).
        }
      }
      return out;
    });
  } finally {
    pass.fill(0);
  }
}

/**
 * Assemble `name1=value1; name2=value2`, deduping by name and preferring the
 * apex host over any subdomain-scoped duplicate.
 */
export function buildChromeCookieHeader(cookies: ChromeCookie[], domainSuffix: string): string {
  const isApex = (host: string): boolean =>
    host === `.${domainSuffix}` || host === domainSuffix;
  // Drop any cookie whose value carries control chars — it either didn't decrypt
  // cleanly or can't be a valid HTTP header value.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars IS the point — they are what we reject
  const headerSafe = (v: string): boolean => !/[\u0000-\u001f\u007f]/.test(v);
  const chosen = new Map<string, ChromeCookie>();
  for (const c of cookies) {
    if (!c.value || !headerSafe(c.value)) continue;
    const prev = chosen.get(c.name);
    if (!prev || (isApex(c.host) && !isApex(prev.host))) chosen.set(c.name, c);
  }
  return [...chosen.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}
