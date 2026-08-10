// SPDX-License-Identifier: Apache-2.0
/**
 * Redactor tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * This is the single sink guarding every write, and it had no coverage at all.
 * A regression here is a credential-leak class bug with no other detection, so
 * the cases below assert BOTH directions: secrets must be masked, and non-secret
 * values an app has vouched for must survive (otherwise captures stop being
 * replayable and people work around the redactor, which is worse).
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  MASK,
  redactHeaders,
  redactText,
  redactUrl,
  registerAppRedaction,
  resetAppRedaction,
} from './redact.js';

afterEach(() => resetAppRedaction());

/** Stand-in for what @sluice/app-slack registers; core can't import an app package. */
function registerSlackLike(): void {
  registerAppRedaction([
    {
      redaction: {
        patterns: [/xox[abcdeprs]-[A-Za-z0-9-]{8,}/g, /xoxd-[A-Za-z0-9%._-]{8,}/g],
        headers: ['x-slack-auth'],
      },
    },
  ]);
}

test('generic policy masks credential-named fields', () => {
  for (const s of [
    'access_token=abcdefgh',
    '{"client_secret":"abcdefgh"}',
    'api_key: abcdefgh',
    '{"password":"hunter22"}',
  ]) {
    assert.ok(redactText(s).includes(MASK), `should have masked: ${s}`);
  }
});

test('generic policy masks Bearer values wherever they appear', () => {
  assert.ok(redactText('authorization: Bearer abcdefghijklmnop').includes(MASK));
});

test('always-secret headers are masked by name', () => {
  const out = redactHeaders({
    authorization: 'Bearer abcdefghijkl',
    cookie: 'd=xoxd-abcdefghijkl',
    'content-type': 'application/json',
  });
  assert.equal(out.authorization, MASK);
  assert.equal(out.cookie, MASK);
  assert.equal(out['content-type'], 'application/json', 'benign headers must survive');
});

test('app-registered token shapes are masked under ANY field name', () => {
  // These all reached SQLite and the WebSocket before apps could contribute
  // patterns: the generic rule only knows credential-*named* fields.
  const leaks = [
    '{"api_token":"xoxc-abc123456789"}',
    '{"d":"xoxd-abcdefghijk"}',
    '{"idToken":"xoxc-shouldbemasked12345"}',
    'some prose mentioning xoxb-1234567890-abcdef inline',
  ];
  for (const s of leaks) {
    assert.ok(!redactText(s).includes(MASK), `precondition: generic policy misses ${s}`);
  }
  registerSlackLike();
  for (const s of leaks) {
    assert.ok(redactText(s).includes(MASK), `should be masked once registered: ${s}`);
  }
});

test('app-registered header names are masked', () => {
  registerSlackLike();
  assert.equal(redactHeaders({ 'X-Slack-Auth': 'anything' })['X-Slack-Auth'], MASK);
});

test('redactUrl masks query secrets by default', () => {
  const out = redactUrl('https://slack.com/api/conversations.list?token=xoxc-secret-here&limit=100');
  assert.ok(out.includes(MASK));
  assert.ok(out.includes('limit=100'), 'benign params must survive');
});

test('a param an app declares public survives on its hosts', () => {
  const url = 'https://api.fast.com/netflix/speedtest/v2?https=true&token=PUBLICTOKENVALUE&urlCount=5';
  assert.ok(redactUrl(url).includes(MASK), 'precondition: masked without a declaration');

  registerAppRedaction([
    { redaction: { publicParams: [{ hosts: ['fast.com'], params: ['token'] }] } },
  ]);
  assert.equal(redactUrl(url), url, 'declared-public param must round-trip exactly');
});

test('a public declaration does not weaken other params or other hosts', () => {
  registerAppRedaction([
    { redaction: { publicParams: [{ hosts: ['fast.com'], params: ['token'] }] } },
  ]);

  // Same host, different param → still masked.
  const mixed = redactUrl('https://api.fast.com/x?token=publicvalue&api_key=SUPERSECRET');
  assert.ok(mixed.includes('token=publicvalue'));
  assert.ok(!mixed.includes('SUPERSECRET'), 'a non-declared param must still be masked');

  // Different host, same param name → still masked.
  assert.ok(redactUrl('https://slack.com/api/x?token=xoxc-secret').includes(MASK));
});

test('redactUrl falls back to text rules for a non-URL string', () => {
  assert.ok(redactUrl('not a url at all token=abcdefgh').includes(MASK));
});

test('redactText tolerates null and undefined', () => {
  assert.equal(redactText(null), '');
  assert.equal(redactText(undefined), '');
});
