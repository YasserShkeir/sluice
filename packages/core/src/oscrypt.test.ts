// SPDX-License-Identifier: Apache-2.0
/**
 * OSCrypt v10 round-trip without touching the Keychain.
 * Encrypt with the same constants Chromium uses, then decrypt through the
 * shared helper — proves host-hash modes and encodings without a live browser.
 */
import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import test from 'node:test';
import { buildChromeCookieHeader, locateChromeProfile } from './chrome-cookies.js';
import { decryptOscryptV10 } from './oscrypt.js';

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
