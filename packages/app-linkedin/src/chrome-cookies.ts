// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Chrome (macOS) — read + decrypt LinkedIn session cookies from Google Chrome's
 * `Cookies` SQLite DB and assemble a `Cookie:` request header.
 *
 * Same OSCrypt scheme as `@sluice/app-trello` / `@sluice/app-loom` (Chrome Safe
 * Storage, AES-128-CBC `v10`). Host filter is linkedin.com only.
 *
 * Security discipline:
 *   - Copy-then-read the Cookies triplet into a 0700 temp dir; rm -rf in finally.
 *   - Keychain prompt is the OS consent boundary — never suppressed.
 *   - Passphrase Buffer is zeroed after use.
 *   - Cookie VALUES are never logged.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const IV = Buffer.alloc(16, 0x20);
const SALT = Buffer.from('saltysalt');
const CHROME_PROFILES = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'] as const;

const HOST_SQL =
  `(host_key = 'linkedin.com' OR host_key = '.linkedin.com' OR host_key LIKE '%.linkedin.com')`;

export interface LinkedInCookieHeader {
  /** `name1=value1; name2=value2` — SECRET; never persist, stream, or log. */
  cookieHeader: string;
  /** Chrome profile the cookies were read from (e.g. 'Default'). */
  profile: string;
}

/**
 * Locate the first Chrome profile signed in to LinkedIn, decrypt its cookies,
 * and return a ready-to-send `Cookie:` header.
 */
export function readLinkedInCookieHeader(): LinkedInCookieHeader {
  if (process.platform !== 'darwin') {
    throw new Error(
      'readLinkedInCookieHeader supports macOS (darwin) only — Chrome cookie decryption goes through the macOS Keychain.',
    );
  }

  const located = locateLinkedInProfile();
  if (!located) {
    throw new Error(
      'No Chrome profile with linkedin.com cookies found — open https://www.linkedin.com in Google Chrome and sign in first.',
    );
  }

  const cookies = readChromeLinkedInCookies(located.cookiesPath);
  const cookieHeader = buildCookieHeader(cookies);
  if (!cookieHeader) {
    throw new Error(
      `Chrome profile "${located.profile}" had no decryptable linkedin.com cookies — is your LinkedIn session in this profile?`,
    );
  }
  return { cookieHeader, profile: located.profile };
}

/**
 * Passive probe: first Chrome profile whose Cookies DB holds linkedin.com rows.
 * Does not decrypt and never triggers Keychain.
 */
export function locateLinkedInProfile(): { profile: string; cookiesPath: string } | undefined {
  const base = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  for (const profile of CHROME_PROFILES) {
    const cookiesPath = join(base, profile, 'Cookies');
    if (!existsSync(cookiesPath)) continue;
    const has = withCopiedDb(cookiesPath, (db) => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM cookies WHERE ${HOST_SQL}`).get() as
        | { n: number }
        | undefined;
      return (row?.n ?? 0) > 0;
    });
    if (has) return { profile, cookiesPath };
  }
  return undefined;
}

interface RawCookie {
  name: string;
  host: string;
  value: string;
}

function readChromeLinkedInCookies(cookiesPath: string): RawCookie[] {
  const pass = keychainPassphrase();
  try {
    return withCopiedDb(cookiesPath, (db) => {
      const rows = db
        .prepare(`SELECT name, host_key, encrypted_value FROM cookies WHERE ${HOST_SQL}`)
        .all() as Array<{ name: string; host_key: string; encrypted_value: Buffer }>;
      const out: RawCookie[] = [];
      for (const r of rows) {
        try {
          out.push({ name: r.name, host: r.host_key, value: decryptCookie(r.encrypted_value, pass) });
        } catch {
          // Skip undecryptable rows.
        }
      }
      return out;
    });
  } finally {
    pass.fill(0);
  }
}

function withCopiedDb<T>(cookiesPath: string, fn: (db: Database.Database) => T): T {
  const work = mkdtempSync(join(tmpdir(), 'sluice-chrome-li-'));
  try {
    chmodSync(work, 0o700);
    const dst = join(work, 'Cookies');
    cpSync(cookiesPath, dst);
    for (const suffix of ['-wal', '-shm']) {
      const extra = cookiesPath + suffix;
      if (existsSync(extra)) cpSync(extra, dst + suffix);
    }
    const db = new Database(dst, { readonly: true, fileMustExist: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function keychainPassphrase(): Buffer {
  const base = ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'];
  let raw: string;
  try {
    raw = execFileSync('/usr/bin/security', [...base, '-a', 'Chrome'], { encoding: 'utf8' });
  } catch {
    raw = execFileSync('/usr/bin/security', base, { encoding: 'utf8' });
  }
  return Buffer.from(raw.trim(), 'utf8');
}

function decryptCookie(enc: Buffer, pass: Buffer): string {
  if (enc.subarray(0, 3).toString('ascii') !== 'v10') throw new Error('unexpected cookie version');
  const key = pbkdf2Sync(pass, SALT, 1003, 16, 'sha1');
  const decipher = createDecipheriv('aes-128-cbc', key, IV);
  decipher.setAutoPadding(true);
  let pt = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);
  if (pt.length >= 32) pt = pt.subarray(32);
  return pt.toString('latin1');
}

function buildCookieHeader(cookies: RawCookie[]): string {
  const isApex = (host: string): boolean => host === '.linkedin.com' || host === 'linkedin.com';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control chars in cookie values
  const headerSafe = (v: string): boolean => !/[\u0000-\u001f\u007f]/.test(v);
  const chosen = new Map<string, RawCookie>();
  for (const c of cookies) {
    if (!c.value || !headerSafe(c.value)) continue;
    const prev = chosen.get(c.name);
    if (!prev || (isApex(c.host) && !isApex(prev.host))) chosen.set(c.name, c);
  }
  return [...chosen.values()].map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Derive the Voyager `csrf-token` header value from a Cookie header.
 *
 * LinkedIn's browser client sends `csrf-token: ajax:…` matching the
 * `JSESSIONID` cookie (often quoted as `"ajax:…"`). Without it Voyager rejects
 * the request even when Cookie is present.
 */
export function csrfTokenFromCookieHeader(cookieHeader: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name.toLowerCase() !== 'jsessionid') continue;
    let value = part.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}
