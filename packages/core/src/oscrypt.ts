// SPDX-License-Identifier: Apache-2.0
/**
 * Chromium OSCrypt (macOS v10) + Keychain helpers shared by every cookie reader.
 *
 * Four apps used to each carry a private copy of AES-128-CBC +
 * PBKDF2-SHA1('saltysalt', 1003) and `security find-generic-password`. They
 * drifted (host-hash strip, encoding, error wording). One module owns the
 * crypto so Windows DPAPI / Linux libsecret can land beside it later without a
 * fifth paste.
 *
 * Security discipline:
 *   - Keychain prompt is the OS consent boundary — never suppressed.
 *   - Callers zero the passphrase Buffer after use (`pass.fill(0)`).
 *   - Cookie VALUES are never logged here (and must not be logged by callers).
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

/** OSCrypt macOS (`v10`): AES-128-CBC, IV = 16 spaces, PBKDF2-SHA1 salt 'saltysalt'. */
const IV = Buffer.alloc(16, 0x20);
const SALT = Buffer.from('saltysalt');

export type OscryptEncoding = 'latin1' | 'utf8';

/**
 * How to treat a leading 32-byte host hash Chromium may prepend to plaintext.
 *
 * - `always` — Chrome Safe Storage cookies (v104+): strip when length ≥ 32.
 * - `if-binary-prefix` — Slack desktop: strip only when the head byte is not
 *   printable ASCII (a real `xoxd-…` value starts printable).
 * - `never` — leave plaintext untouched.
 */
export type OscryptHostHashMode = 'always' | 'if-binary-prefix' | 'never';

export interface DecryptOscryptV10Options {
  /** Default `latin1` — cookie values must stay valid HTTP header bytes. */
  encoding?: OscryptEncoding;
  /** Default `always`. */
  hostHash?: OscryptHostHashMode;
}

/**
 * Decrypt a Chromium OSCrypt v10 blob with the given Safe Storage passphrase.
 * Throws when the version prefix is not `v10` or when AES padding fails.
 */
export function decryptOscryptV10(
  enc: Buffer,
  pass: Buffer,
  opts: DecryptOscryptV10Options = {},
): string {
  if (enc.subarray(0, 3).toString('ascii') !== 'v10') {
    throw new Error('unexpected cookie version');
  }
  const encoding = opts.encoding ?? 'latin1';
  const hostHash = opts.hostHash ?? 'always';
  const key = pbkdf2Sync(pass, SALT, 1003, 16, 'sha1');
  const decipher = createDecipheriv('aes-128-cbc', key, IV);
  decipher.setAutoPadding(true);
  let pt = Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);

  if (hostHash === 'always' && pt.length >= 32) {
    pt = pt.subarray(32);
  } else if (hostHash === 'if-binary-prefix' && pt.length > 32) {
    const head = pt[0];
    if (head === undefined || head < 0x20 || head > 0x7e) pt = pt.subarray(32);
  }

  return pt.toString(encoding);
}

/**
 * Read a macOS Keychain generic-password item (Chrome / Slack Safe Storage).
 * Triggers the OS consent prompt — never suppress or cache across processes.
 *
 * Tries `service` + `account` first, then service alone (account labels vary
 * across Chromium builds).
 */
export function keychainPassphrase(service: string, account?: string): Buffer {
  if (process.platform !== 'darwin') {
    throw new Error(
      'keychainPassphrase supports macOS (darwin) only — use paste-in credentials on other platforms.',
    );
  }
  const base = ['find-generic-password', '-w', '-s', service];
  let raw: string;
  try {
    raw = account
      ? execFileSync('/usr/bin/security', [...base, '-a', account], { encoding: 'utf8' })
      : execFileSync('/usr/bin/security', base, { encoding: 'utf8' });
  } catch (first) {
    if (!account) throw first;
    // Account label varies across builds; retry keyed on the service only.
    raw = execFileSync('/usr/bin/security', base, { encoding: 'utf8' });
  }
  return Buffer.from(raw.trim(), 'utf8');
}

/**
 * Copy a SQLite file (+ `-wal`/`-shm` if present) into a 0700 temp dir, open
 * readonly, run `fn`, and shred the copy in `finally`. Copy-then-read dodges
 * exclusive locks while Chrome / Slack hold the live DB open.
 */
export function withCopiedSqliteDb<T>(
  dbPath: string,
  fn: (db: Database.Database) => T,
  tempPrefix = 'sluice-cookies-',
): T {
  const work = mkdtempSync(join(tmpdir(), tempPrefix));
  try {
    chmodSync(work, 0o700);
    const dst = join(work, 'db');
    cpSync(dbPath, dst);
    for (const suffix of ['-wal', '-shm']) {
      const extra = dbPath + suffix;
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
