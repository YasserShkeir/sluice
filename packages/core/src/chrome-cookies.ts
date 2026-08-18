// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chrome (macOS) session-cookie reader — shared by Trello, Loom, LinkedIn.
 *
 * Discovers the first Chrome profile that holds cookies for `domainSuffix`,
 * decrypts them via {@link decryptOscryptV10} + Chrome Safe Storage, and
 * assembles a `Cookie:` header. App packages keep only domain-specific labels
 * and any header post-processing (e.g. LinkedIn CSRF).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  decryptOscryptV10,
  keychainPassphrase,
  withCopiedSqliteDb,
} from './oscrypt.js';

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

interface RawCookie {
  name: string;
  host: string;
  value: string;
}

function hostSql(domainSuffix: string): string {
  // domainSuffix is a controlled identifier (app code), not user input — still
  // escape single quotes so a malicious suffix cannot break out of the literal.
  const d = domainSuffix.replace(/'/g, "''");
  return `(host_key = '${d}' OR host_key = '.${d}' OR host_key LIKE '%.${d}')`;
}

function chromeBase(override?: string): string {
  return override ?? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

/**
 * Passive probe: first Chrome profile whose Cookies DB holds rows for the domain.
 * Does not decrypt and never triggers Keychain.
 */
export function locateChromeProfile(
  domainSuffix: string,
  opts: { chromeUserDataDir?: string } = {},
): { profile: string; cookiesPath: string } | undefined {
  const base = chromeBase(opts.chromeUserDataDir);
  const sql = `SELECT COUNT(*) AS n FROM cookies WHERE ${hostSql(domainSuffix)}`;
  for (const profile of CHROME_PROFILES) {
    const cookiesPath = join(base, profile, 'Cookies');
    if (!existsSync(cookiesPath)) continue;
    const has = withCopiedSqliteDb(cookiesPath, (db) => {
      const row = db.prepare(sql).get() as { n: number } | undefined;
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
    throw new Error(
      `No Chrome profile with ${opts.domainSuffix} cookies found — open https://${opts.domainSuffix} in Google Chrome and sign in first.`,
    );
  }

  const cookies = readDomainCookies(located.cookiesPath, opts.domainSuffix);
  const cookieHeader = buildCookieHeader(cookies, opts.domainSuffix);
  if (!cookieHeader) {
    throw new Error(
      `Chrome profile "${located.profile}" had no decryptable ${opts.domainSuffix} cookies — is your ${label} session in this profile?`,
    );
  }
  return { cookieHeader, profile: located.profile };
}

function readDomainCookies(cookiesPath: string, domainSuffix: string): RawCookie[] {
  const pass = keychainPassphrase(CHROME_SAFE_STORAGE, CHROME_ACCOUNT);
  try {
    return withCopiedSqliteDb(cookiesPath, (db) => {
      const rows = db
        .prepare(
          `SELECT name, host_key, encrypted_value FROM cookies WHERE ${hostSql(domainSuffix)}`,
        )
        .all() as Array<{ name: string; host_key: string; encrypted_value: Buffer }>;
      const out: RawCookie[] = [];
      for (const r of rows) {
        try {
          out.push({
            name: r.name,
            host: r.host_key,
            value: decryptOscryptV10(r.encrypted_value, pass, {
              encoding: 'latin1',
              hostHash: 'always',
            }),
          });
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
export function buildChromeCookieHeader(cookies: RawCookie[], domainSuffix: string): string {
  return buildCookieHeader(cookies, domainSuffix);
}

function buildCookieHeader(cookies: RawCookie[], domainSuffix: string): string {
  const isApex = (host: string): boolean =>
    host === `.${domainSuffix}` || host === domainSuffix;
  // Drop any cookie whose value carries control chars — it either didn't decrypt
  // cleanly or can't be a valid HTTP header value.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars IS the point — they are what we reject
  const headerSafe = (v: string): boolean => !/[\u0000-\u001f\u007f]/.test(v);
  const chosen = new Map<string, RawCookie>();
  for (const c of cookies) {
    if (!c.value || !headerSafe(c.value)) continue;
    const prev = chosen.get(c.name);
    if (!prev || (isApex(c.host) && !isApex(prev.host))) chosen.set(c.name, c);
  }
  return [...chosen.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}
