// SPDX-License-Identifier: Apache-2.0
/**
 * OSCrypt v10 round-trip without touching the Keychain.
 * Encrypt with the same constants Chromium uses, then decrypt through the
 * shared helper — proves host-hash modes and encodings without a live browser.
 */
import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  buildChromeCookieHeader,
  isNoSessionError,
  locateChromeProfile,
  NoChromeSessionError,
  readChromeCookieHeader,
} from './chrome-cookies.js';
import { decryptOscryptV10, type KeychainExec, keychainPassphrase } from './oscrypt.js';

const IV = Buffer.alloc(16, 0x20);
const SALT = Buffer.from('saltysalt');

function encryptV10(plaintext: Buffer, pass: Buffer): Buffer {
  const key = pbkdf2Sync(pass, SALT, 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, IV);
  cipher.setAutoPadding(true);
  return Buffer.concat([Buffer.from('v10', 'ascii'), cipher.update(plaintext), cipher.final()]);
}

test('decryptOscryptV10 round-trips latin1 cookie values', () => {
  const pass = Buffer.from('test-passphrase', 'utf8');
  const value = 'token=abc123;path=/';
  // Chrome always-hash: 32 random bytes + payload
  const hostHash = randomBytes(32);
  const enc = encryptV10(Buffer.concat([hostHash, Buffer.from(value, 'latin1')]), pass);
  const out = decryptOscryptV10(enc, pass, { encoding: 'latin1', hostHash: 'always' });
  assert.equal(out, value);
});

test('decryptOscryptV10 if-binary-prefix keeps printable Slack-style tokens', () => {
  const pass = Buffer.from('slack-pass', 'utf8');
  const value = 'xoxd-this-is-a-fake-cookie-value';
  // No host hash — plaintext starts printable; strip mode must not eat the value.
  const enc = encryptV10(Buffer.from(value, 'utf8'), pass);
  const out = decryptOscryptV10(enc, pass, {
    encoding: 'utf8',
    hostHash: 'if-binary-prefix',
  });
  assert.equal(out, value);
});

test('decryptOscryptV10 if-binary-prefix strips a binary host hash', () => {
  const pass = Buffer.from('slack-pass', 'utf8');
  const value = 'xoxd-after-hash';
  const hostHash = Buffer.alloc(32, 0x01); // non-printable head
  const enc = encryptV10(Buffer.concat([hostHash, Buffer.from(value, 'utf8')]), pass);
  const out = decryptOscryptV10(enc, pass, {
    encoding: 'utf8',
    hostHash: 'if-binary-prefix',
  });
  assert.equal(out, value);
});

test('decryptOscryptV10 refuses non-v10 blobs', () => {
  const pass = Buffer.from('x');
  assert.throws(
    () => decryptOscryptV10(Buffer.from('v11deadbeef'), pass),
    /unexpected cookie version/,
  );
});

test('buildChromeCookieHeader prefers apex host and drops control chars', () => {
  const header = buildChromeCookieHeader(
    [
      { name: 'a', host: 'app.trello.com', value: 'sub' },
      { name: 'a', host: '.trello.com', value: 'apex' },
      { name: 'bad', host: 'trello.com', value: 'x\u0000y' },
      { name: 'ok', host: 'trello.com', value: 'clean' },
    ],
    'trello.com',
  );
  assert.equal(header, 'a=apex; ok=clean');
});

test('locateChromeProfile returns undefined when no Chrome data dir exists', () => {
  const hit = locateChromeProfile('example.com', {
    chromeUserDataDir: '/tmp/sluice-no-such-chrome-profile-dir',
  });
  assert.equal(hit, undefined);
});

/** A fake Chrome user-data dir: `{ profile: [name, host_key][] }`. Values are never decrypted. */
function fakeChromeDir(profiles: Record<string, Array<[string, string]>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'sluice-chrome-'));
  for (const [profile, rows] of Object.entries(profiles)) {
    mkdirSync(join(dir, profile), { recursive: true });
    const db = new Database(join(dir, profile, 'Cookies'));
    db.exec('CREATE TABLE cookies (name TEXT, host_key TEXT, encrypted_value BLOB)');
    const insert = db.prepare('INSERT INTO cookies (name, host_key, encrypted_value) VALUES (?, ?, ?)');
    for (const [name, host] of rows) insert.run(name, host, Buffer.from([0]));
    db.close();
  }
  return dir;
}

test('locateChromeProfile requireCookie skips profiles without the session cookie', () => {
  const dir = fakeChromeDir({
    Default: [
      ['notion_browser_id', '.notion.com'],
      ['__cf_bm', '.notion.com'],
    ],
    'Profile 1': [['token_v2', 'evilnotion.com']],
    'Profile 2': [['token_v2', '.app.notion.com']],
  });
  try {
    // Profile 1's host must not match: `evilnotion.com` is not `*.notion.com`.
    assert.equal(
      locateChromeProfile('notion.com', { chromeUserDataDir: dir, requireCookie: 'token_v2' })?.profile,
      'Profile 2',
    );
    assert.equal(locateChromeProfile('notion.com', { chromeUserDataDir: dir })?.profile, 'Default');
    assert.equal(locateChromeProfile('notion.com', { chromeUserDataDir: dir, requireCookie: 'nope' }), undefined);
    // Bound parameters: a quote in the suffix is data, not SQL.
    assert.equal(locateChromeProfile("o'brien.com", { chromeUserDataDir: dir }), undefined);
    assert.equal(
      locateChromeProfile('notion.com', { chromeUserDataDir: dir, requireCookie: "x' OR '1'='1" }),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readChromeCookieHeader throws a NoChromeSessionError when no profile has the domain', { skip: process.platform !== 'darwin' }, () => {
  const dir = fakeChromeDir({ Default: [['a', '.other.test']] });
  try {
    assert.throws(
      () => readChromeCookieHeader({ domainSuffix: 'example.test', chromeUserDataDir: dir }),
      (e: unknown) => e instanceof NoChromeSessionError && isNoSessionError(e),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isNoSessionError separates "signed out" from "could not read it"', () => {
  for (const e of [
    new NoChromeSessionError('anything'),
    Object.assign(new Error('from another copy of core'), { code: 'SLUICE_NO_CHROME_SESSION' }),
    new Error('No Chrome profile with trello.com cookies found — open https://trello.com in Google Chrome and sign in first.'),
    new Error('No Chrome profile signed in to Notion found (no token_v2 cookie) — sign in first.'),
    new Error("ENOENT: no such file or directory, open '/x/Cookies'"),
    new Error('not signed in'),
  ]) {
    assert.equal(isNoSessionError(e), true, e.message);
  }
  for (const e of [
    new Error('Chrome profile "Default" had no decryptable trello.com cookies — is your Trello session in this profile?'),
    new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'),
    new Error('database is locked'),
    'User interaction is not allowed.',
  ]) {
    assert.equal(isNoSessionError(e), false, String(e));
  }
});

/** A stub `security` that fails with `status` on the first call and records every call. */
function stubSecurity(status: number | null): { exec: KeychainExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: KeychainExec = (_file, args, options) => {
    calls.push(args);
    assert.equal(options.timeout, 120_000, 'a prompt nobody answers must not block forever');
    if (calls.length === 1) throw Object.assign(new Error('security failed'), { status });
    return 'FAKE-PASSPHRASE\n';
  };
  return { exec, calls };
}

test('keychainPassphrase retries without the account only when the item was not found', { skip: process.platform !== 'darwin' }, () => {
  const notFound = stubSecurity(44);
  assert.equal(keychainPassphrase('Svc', 'Acct', notFound.exec).toString('utf8'), 'FAKE-PASSPHRASE');
  assert.equal(notFound.calls.length, 2);
  assert.ok(notFound.calls[0]?.includes('Acct') && !notFound.calls[1]?.includes('Acct'));

  // A Deny (51), any other failure (128) or a timeout (null status) never prompts twice.
  for (const status of [51, 128, null]) {
    const denied = stubSecurity(status);
    assert.throws(() => keychainPassphrase('Svc', 'Acct', denied.exec), /security failed/);
    assert.equal(denied.calls.length, 1, `status ${status} must not re-prompt`);
  }
});
