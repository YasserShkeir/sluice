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
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { copyFileSafe, sweepStaleTempDirs } from './safe-copy.js';

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
 * What to tell the user before a Keychain read. "Always Allow" adds
 * `/usr/bin/security` to the item's ACL, after which ANY same-user process can
 * read the Safe Storage key without a prompt and decrypt every cookie. Printed
 * by the CLI/runner (core never writes to the terminal).
 */
export const KEYCHAIN_ALLOW_ADVICE =
  'macOS will ask for Keychain access: click "Allow", not "Always Allow" — "Always Allow" lets any program read this key without asking.';

/**
 * How long a Keychain read may wait on the consent prompt. It bounds how long
 * the (synchronous) call can stall the event loop; it does not remove the stall.
 */
const KEYCHAIN_TIMEOUT_MS = 120_000;

/** `security` exits 44 (errSecItemNotFound) when no item matches the query. */
const SECURITY_ITEM_NOT_FOUND = 44;

/** The `execFileSync` shape {@link keychainPassphrase} needs — a test seam. */
export type KeychainExec = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; stdio: ['ignore', 'pipe', 'pipe'] },
) => string;

/**
 * Read a macOS Keychain generic-password item (Chrome / Slack Safe Storage).
 * Triggers the OS consent prompt — never suppress or cache across processes.
 * Tell the user {@link KEYCHAIN_ALLOW_ADVICE} first.
 *
 * Tries `service` + `account` first, then service alone (account labels vary
 * across Chromium builds) — but ONLY when the first lookup found no item. A
 * Deny, a timeout or any other failure is final, so a user who clicks Deny is
 * not asked a second time.
 *
 * `exec` is a test seam; production always uses `execFileSync`.
 */
export function keychainPassphrase(
  service: string,
  account?: string,
  exec: KeychainExec = execFileSync,
): Buffer {
  if (process.platform !== 'darwin') {
    throw new Error(
      'keychainPassphrase supports macOS (darwin) only — use paste-in credentials on other platforms.',
    );
  }
  const base = ['find-generic-password', '-w', '-s', service];
  const options: Parameters<KeychainExec>[2] = {
    encoding: 'utf8',
    timeout: KEYCHAIN_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const run = (args: string[]): string => exec('/usr/bin/security', args, options);
  let raw: string;
  try {
    raw = account ? run([...base, '-a', account]) : run(base);
  } catch (first) {
    if (!account || (first as { status?: number | null }).status !== SECURITY_ITEM_NOT_FOUND) throw first;
    // Account label varies across builds; retry keyed on the service only.
    raw = run(base);
  }
  return Buffer.from(raw.trim(), 'utf8');
}

/**
 * Copy a SQLite file (+ `-wal`/`-shm` if present) into a 0700 temp dir, open
 * readonly, run `fn`, and shred the copy in `finally`. Copy-then-read dodges
 * exclusive locks while Chrome / Slack hold the live DB open.
 */
export function withCopiedSqliteDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  sweepStaleTempDirs(); // a killed earlier run's copy, which `finally` never removed
  const work = mkdtempSync(join(tmpdir(), 'sluice-cookies-')); // the prefix sweepStaleTempDirs knows
  try {
    chmodSync(work, 0o700);
    const dst = join(work, 'db');
    // Not cpSync: it can abort the process inside an app container (see safe-copy.ts).
    copyFileSafe(dbPath, dst);
    for (const suffix of ['-wal', '-shm']) {
      const extra = dbPath + suffix;
      if (existsSync(extra)) copyFileSafe(extra, dst + suffix);
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
