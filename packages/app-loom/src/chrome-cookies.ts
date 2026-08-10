// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Chrome (macOS) — read + decrypt the loom.com session cookies from Google
 * Chrome's `Cookies` SQLite DB and assemble a `Cookie:` request header.
 *
 * Loom's web API (`https://www.loom.com/graphql`) is authorized by the browser
 * SESSION COOKIE, exactly like Trello — there is no token query param. This is a
 * near-verbatim adaptation of `@sluice/app-trello`'s chrome-cookies.ts, changed
 * only in the host it filters for (`loom.com`).
 *
 * ponytail: this is now the THIRD copy of the macOS Chromium OSCrypt scheme
 * (slack-credentials.ts, app-trello/chrome-cookies.ts, here). The duplication is
 * already tracked as a bug in the trello copy's header; the right fix is to
 * promote a `readChromeCookieHeader(domainSuffix)` helper into a shared module
 * (adapter-sdk or core) and delete all three. Deferred to keep this app
 * self-contained and avoid an app→app dependency.
 *
 * Security discipline (mirrors the Trello/Slack copies):
 *   - Copy-then-read the `Cookies` triplet into a 0700 temp dir (it may be locked
 *     while Chrome runs) and `rm -rf` it in `finally`.
 *   - The Keychain prompt on `security find-generic-password` is the OS consent
 *     boundary — never suppressed, and taken only after we've found a profile
 *     that actually holds loom.com cookies.
 *   - The passphrase Buffer is zeroed (`fill(0)`) after use.
 *   - A cookie VALUE is NEVER logged.
 *
 * OSCrypt macOS (`v10`): AES-128-CBC, IV = 16 spaces, key = PBKDF2-SHA1 of the
 * Keychain passphrase (salt 'saltysalt', 1003 iters, 16 bytes). The decrypted
 * plaintext may carry a leading 32-byte SHA-256 host hash (newer Chromium) that
 * is stripped when present.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/** OSCrypt macOS (`v10`): AES-128-CBC, IV = 16 spaces, PBKDF2-SHA1 salt 'saltysalt'. */
const IV = Buffer.alloc(16, 0x20);
const SALT = Buffer.from('saltysalt');

/** Chrome's default profile directory names, in preference order. */
const CHROME_PROFILES = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'] as const;

export interface LoomCookieHeader {
  /** `name1=value1; name2=value2` — SECRET; never persist, stream, or log. */
  cookieHeader: string;
  /** the Chrome profile the cookies were read from (e.g. 'Default'). */
  profile: string;
}

/**
 * Locate the first Chrome profile signed in to Loom, decrypt its loom.com
 * cookies, and return them as a ready-to-send `Cookie:` header. Throws with a
 * clear message when not on macOS or when no Loom session is found.
 */
export function readLoomCookieHeader(): LoomCookieHeader {
  if (process.platform !== 'darwin') {
    throw new Error(
      'readLoomCookieHeader supports macOS (darwin) only — Chrome cookie decryption goes through the macOS Keychain.',
    );
  }

  const located = locateLoomProfile();
  if (!located) {
    throw new Error(
      'No Chrome profile with loom.com cookies found — open https://www.loom.com in Google Chrome and sign in first.',
    );
  }

  const cookies = readChromeLoomCookies(located.cookiesPath);
  const cookieHeader = buildCookieHeader(cookies);
  if (!cookieHeader) {
    throw new Error(
      `Chrome profile "${located.profile}" had no decryptable loom.com cookies — is your Loom session in this profile?`,
    );
  }
  return { cookieHeader, profile: located.profile };
}

// ── Profile discovery (no Keychain prompt) ──────────────────────────────────────

/**
 * Return the FIRST Chrome profile whose `Cookies` DB both exists and holds
 * loom.com rows. This is a passive count — it does NOT decrypt and never
 * triggers the Keychain prompt, so we only prompt once a real target is found.
 */
export function locateLoomProfile(): { profile: string; cookiesPath: string } | undefined {
  const base = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  for (const profile of CHROME_PROFILES) {
    const cookiesPath = join(base, profile, 'Cookies');
    if (!existsSync(cookiesPath)) continue;
    const hasLoom = withCopiedDb(cookiesPath, (db) => {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM cookies WHERE (host_key = 'loom.com' OR host_key = '.loom.com' OR host_key LIKE '%.loom.com')`)
        .get() as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    });
    if (hasLoom) return { profile, cookiesPath };
  }
  return undefined;
}

// ── Cookie read + decrypt ────────────────────────────────────────────────────────

interface RawCookie {
  name: string;
  host: string;
  value: string;
}

/**
 * Decrypt every loom.com cookie in the given profile's `Cookies` DB. The
 * Keychain passphrase is fetched ONCE (a single OS consent prompt) and zeroed in
 * `finally`; undecryptable rows are skipped rather than failing the batch.
 */
function readChromeLoomCookies(cookiesPath: string): RawCookie[] {
  const pass = keychainPassphrase();
  try {
    return withCopiedDb(cookiesPath, (db) => {
      const rows = db
        .prepare(`SELECT name, host_key, encrypted_value FROM cookies WHERE (host_key = 'loom.com' OR host_key = '.loom.com' OR host_key LIKE '%.loom.com')`)
        .all() as Array<{ name: string; host_key: string; encrypted_value: Buffer }>;
      const out: RawCookie[] = [];
      for (const r of rows) {
        try {
          out.push({ name: r.name, host: r.host_key, value: decryptCookie(r.encrypted_value, pass) });
        } catch {
          // Skip cookies we can't decrypt (non-v10 / unrelated encoding).
        }
      }
      return out;
    });
  } finally {
    pass.fill(0); // zero the passphrase
  }
}

/**
 * Copy the `Cookies` triplet (+ `-wal`/`-shm` if present) into a fresh 0700 temp
 * dir, open it readonly, run `fn`, and shred the copy in `finally`. Copy-then-read
 * dodges Chrome's exclusive SQLite lock while the browser is running.
 */
function withCopiedDb<T>(cookiesPath: string, fn: (db: Database.Database) => T): T {
  const work = mkdtempSync(join(tmpdir(), 'sluice-chrome-'));
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
    rmSync(work, { recursive: true, force: true }); // shred the temp copy
  }
}

/** Triggers the macOS Keychain prompt — the OS consent boundary; never suppressed. */
function keychainPassphrase(): Buffer {
  const base = ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'];
  let raw: string;
  try {
    raw = execFileSync('/usr/bin/security', [...base, '-a', 'Chrome'], { encoding: 'utf8' });
  } catch {
    // The account label varies across builds; retry keyed on the service only.
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
  // Chrome (v104+) ALWAYS prepends a 32-byte SHA-256 of the eTLD+1 to the plaintext.
  if (pt.length >= 32) pt = pt.subarray(32);
  // Cookie values are Latin-1/ASCII; decode byte-preserving so the value stays a
  // valid HTTP header value (utf8 would emit U+FFFD for any stray byte).
  return pt.toString('latin1');
}

/**
 * Assemble `name1=value1; name2=value2` from the decrypted cookies, deduping by
 * name and preferring the apex `.loom.com` (or `loom.com`) host over any
 * subdomain-scoped duplicate.
 */
function buildCookieHeader(cookies: RawCookie[]): string {
  const isApex = (host: string): boolean => host === '.loom.com' || host === 'loom.com';
  // Drop any cookie whose value carries control chars — it either didn't decrypt
  // cleanly or can't be a valid HTTP header value; the auth cookie is clean.
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
