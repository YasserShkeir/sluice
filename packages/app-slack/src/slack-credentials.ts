// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Engine B (macOS) — cold-start credential extraction. Reads the `xoxc-` token
 * from Slack desktop's LevelDB (`localConfig_v2`) and decrypts the `d` (`xoxd-…`)
 * cookie from Slack's Chromium Cookies SQLite DB using the macOS OSCrypt scheme.
 *
 * Security discipline (docs/interceptor-plan.md §2.3 / §5):
 *   - Copy-then-read the LevelDB dir and the Cookies triplet into 0700 temp dirs
 *     (they may be locked while Slack runs), and `rm -rf` them in `finally`.
 *   - The Keychain prompt on `security find-generic-password` is the consent
 *     boundary — never suppressed.
 *   - The keychain passphrase Buffer is zeroed (`fill(0)`) after use.
 *   - Secrets live only in the returned in-memory Session; nothing is logged.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ClassicLevel } from 'classic-level';
import { newId } from '@sluice/core';
import type { Session } from '@sluice/core';
import { slackAppSupportDirs } from './paths.js';

const ADAPTER_ID = 'slack';
/** OSCrypt macOS (`v10`): AES-128-CBC, IV = 16 spaces, PBKDF2-SHA1 salt 'saltysalt'. */
const IV = Buffer.alloc(16, 0x20);
const SALT = Buffer.from('saltysalt');

export interface SlackWorkspaceInfo {
  id: string;
  name: string;
  domain?: string;
  url?: string;
}

/**
 * Engine B, per-workspace: one {@link Session} for EVERY signed-in team that
 * carries an `xoxc-` token (not just the first).
 *
 * All workspaces on a machine share the SAME user session cookie, so the `d`
 * (`xoxd-…`) / `d-s` cookie is decrypted exactly ONCE — a single Keychain prompt
 * (§2.3) — and reused across every returned session. Each session's per-workspace
 * `xoxc-` token comes from its own `localConfig_v2` team entry.
 *
 * macOS-only (throws on other platforms). Returns `[]` when no team has a token.
 * Secrets live only in the returned in-memory Sessions; nothing is logged.
 */
export async function extractAllSlackSessions(
  opts: { appSupportDir?: string } = {},
): Promise<Session[]> {
  if (process.platform !== 'darwin') {
    throw new Error(
      'extractAllSlackSessions supports macOS (darwin) only — use paste-in credentials on other platforms.',
    );
  }

  const dirs = slackAppSupportDirs(opts.appSupportDir);
  const leveldbDir = firstExisting(dirs.map((d) => join(d, 'Local Storage', 'leveldb')));
  if (!leveldbDir) {
    throw new Error(
      'Slack Local Storage leveldb not found — is the Slack desktop app installed and signed in?',
    );
  }
  const cookiesPath = firstExisting(dirs.map((d) => join(d, 'Cookies')));
  if (!cookiesPath) throw new Error('Slack Cookies DB not found.');

  const cfg = await readLocalConfig(leveldbDir);
  const teams = Object.values(cfg.teams ?? {}).filter(
    (t): t is LocalTeam & { id: string; token: string } =>
      typeof t.id === 'string' &&
      typeof t.token === 'string' &&
      t.token.startsWith('xoxc-'),
  );
  if (teams.length === 0) return [];

  // One decrypt for all workspaces — the `d`/`d-s` cookie is shared user-session
  // state, so a single Keychain prompt covers every session we build below.
  const jar = readSlackCookies(cookiesPath);
  const cookieD = jar['d'];
  if (!cookieD) throw new Error('Slack `d` cookie not found or failed to decrypt.');
  const cookieDs = jar['d-s'];

  const discoveredAt = Date.now();
  return teams.map((team): Session => {
    // `injection.cookies` maps a cookie NAME to the KEY in `values` holding its
    // secret; mirror the shape slackSessionFromCreds produces.
    const values: Record<string, string> = { token: team.token, cookieD };
    const cookies: Record<string, string> = { d: 'cookieD' };
    if (cookieDs) {
      values.cookieDs = cookieDs;
      cookies['d-s'] = 'cookieDs';
    }
    return {
      id: newId('sess'),
      adapterId: ADAPTER_ID,
      workspaceId: team.id,
      label: team.name ?? team.url ?? team.id,
      credentials: {
        kind: 'slack-session',
        values,
        injection: { tokenFormField: 'token', cookies },
      },
      discoveredAt,
      source: 'local-store',
    };
  });
}

// ── LevelDB localConfig (copy-then-read to dodge the exclusive LOCK) ────────────

/** The fields we read per-team out of Slack desktop's `localConfig_v2` blob. */
interface LocalTeam {
  id?: string;
  token?: string;
  name?: string;
  domain?: string;
  url?: string;
}

/**
 * Copy the leveldb dir into a 0700 temp dir (it may be locked while Slack runs),
 * find the key containing `localConfig_v2`, decode the Chromium type-tag byte, and
 * JSON.parse it. Returns the parsed config (`{}` when the key is absent). The temp
 * copy is shredded in `finally`.
 */
async function readLocalConfig(
  leveldbDir: string,
): Promise<{ teams?: Record<string, LocalTeam> }> {
  const work = mkdtempSync(join(tmpdir(), 'sluice-ldb-'));
  try {
    cpSync(leveldbDir, work, { recursive: true });
    const db = new ClassicLevel<Buffer, Buffer>(work, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
      createIfMissing: false,
    });
    try {
      const needle = Buffer.from('localConfig_v2');
      for await (const [k, v] of db.iterator()) {
        if (!k.includes(needle)) continue;
        try {
          return JSON.parse(decodeLevelValue(v)) as { teams?: Record<string, LocalTeam> };
        } catch {
        }
      }
      return {};
    } finally {
      await db.close();
    }
  } finally {
    rmSync(work, { recursive: true, force: true }); // §2.3 shred temp copy
  }
}

/**
 * PASSIVE, secret-free enumeration of every signed-in Slack workspace. Reads ONLY
 * the LevelDB `localConfig_v2` blob — no Keychain prompt, no network — and NEVER
 * returns tokens or cookies. Yields [] gracefully when Slack isn't installed or
 * signed in on this store.
 */
export async function listSlackWorkspaces(
  opts: { appSupportDir?: string } = {},
): Promise<SlackWorkspaceInfo[]> {
  const dirs = slackAppSupportDirs(opts.appSupportDir);
  const leveldbDir = firstExisting(dirs.map((d) => join(d, 'Local Storage', 'leveldb')));
  if (!leveldbDir) return [];

  let cfg: { teams?: Record<string, LocalTeam> };
  try {
    cfg = await readLocalConfig(leveldbDir);
  } catch {
    return [];
  }

  const out: SlackWorkspaceInfo[] = [];
  for (const t of Object.values(cfg.teams ?? {})) {
    if (!t || typeof t.id !== 'string') continue;
    out.push({
      id: t.id,
      name: typeof t.name === 'string' && t.name.length > 0 ? t.name : t.id,
      domain: typeof t.domain === 'string' ? t.domain : undefined,
      url: typeof t.url === 'string' ? t.url : undefined,
    });
  }
  return out;
}

/** Chromium localStorage values carry a 1-byte type tag: 0x00=UTF-16LE, 0x01=UTF-8. */
function decodeLevelValue(v: Buffer): string {
  if (v.length === 0) return '';
  const tag = v[0];
  if (tag === 0x00) return v.subarray(1).toString('utf16le');
  if (tag === 0x01) return v.subarray(1).toString('utf8');
  return v.toString('utf8');
}

// ── Cookie decryption (Chromium OSCrypt, macOS v10) ────────────────────────────

function readSlackCookies(cookiesPath: string): Record<string, string> {
  const pass = keychainPassphrase();
  const work = mkdtempSync(join(tmpdir(), 'sluice-cookies-'));
  try {
    const dst = join(work, 'Cookies');
    cpSync(cookiesPath, dst);
    for (const suffix of ['-wal', '-shm']) {
      const extra = cookiesPath + suffix;
      if (existsSync(extra)) cpSync(extra, dst + suffix);
    }
    const db = new Database(dst, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(`SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%slack.com'`)
        .all() as Array<{ name: string; encrypted_value: Buffer }>;
      const jar: Record<string, string> = {};
      for (const r of rows) {
        try {
          jar[r.name] = decryptCookie(r.encrypted_value, pass);
        } catch {
          // Skip cookies we can't decrypt (non-v10 / unrelated); `d` is what matters.
        }
      }
      return jar;
    } finally {
      db.close();
    }
  } finally {
    pass.fill(0); // §2.3 zero the passphrase
    rmSync(work, { recursive: true, force: true }); // §2.3 shred temp copy
  }
}

/** Triggers the macOS Keychain prompt — the OS consent boundary; never suppressed. */
function keychainPassphrase(): Buffer {
  const base = ['find-generic-password', '-w', '-s', 'Slack Safe Storage'];
  let raw: string;
  try {
    raw = execFileSync('/usr/bin/security', [...base, '-a', 'Slack'], { encoding: 'utf8' });
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
  // Newer Chromium prepends a 32-byte SHA-256 host hash; strip it when the head
  // byte isn't printable ASCII (a real `xoxd-…` value starts printable).
  if (pt.length > 32) {
    const head = pt[0];
    if (head === undefined || head < 0x20 || head > 0x7e) pt = pt.subarray(32);
  }
  return pt.toString('utf8');
}

// ── path helpers ──────────────────────────────────────────────────────────────

function firstExisting(paths: string[]): string | undefined {
  for (const p of paths) if (existsSync(p)) return p;
  return undefined;
}
