// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Faithful-replay tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The property under test: a value the client computes fresh each request must
 * not be replayed verbatim. Sending a stale nonce is a stronger anomaly signal
 * than sending none, and can trip idempotency checks in ways that look like
 * Sluice bugs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { capAcceptEncoding, faithfulReplayRequest, learnRequestTemplate, makeFaithful } from './faithful.js';

function capture(over: Partial<Capture>): Capture {
  return {
    id: 'cap',
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/conversations.list',
    host: 'slack.com',
    path: '/api/conversations.list',
    status: 200,
    durationMs: 10,
    reqHeaders: { 'user-agent': 'RealClient/1.0', 'x-slack-version': '42' },
    reqBody: null,
    resHeaders: {},
    resBody: null,
    ...over,
  };
}

/** Seed N captures whose `_x_id` differs each time but whose `_x_mode` is constant. */
function seedVarying(store: SqliteStore, n = 4): void {
  for (let i = 0; i < n; i++) {
    store.insertCapture(
      capture({
        id: `c${i}`,
        ts: 1_700_000_000_000 + i,
        reqBody: `token=«redacted»&_x_mode=online&_x_id=${1000 + i}-abc&types=public_channel`,
      }),
    );
  }
}

test('a param that varies between captures is not copied verbatim', () => {
  const store = new SqliteStore(':memory:');
  seedVarying(store);

  const tmpl = learnRequestTemplate(store, 'POST', '/api/conversations.list');
  assert.ok(tmpl);
  assert.ok(tmpl.volatileParams.includes('_x_id'), '_x_id varies and must be flagged volatile');
  assert.equal(tmpl.bodyParams._x_mode, 'online', 'a stable param must still be learned');
  // Unknown shape → dropped rather than invented.
  assert.equal(tmpl.bodyParams._x_id, undefined);
  store.close();
});

test('the redacted token is never learned — it is re-injected live', () => {
  const store = new SqliteStore(':memory:');
  seedVarying(store);
  const tmpl = learnRequestTemplate(store, 'POST', '/api/conversations.list');
  assert.equal(tmpl?.bodyParams.token, undefined);
  store.close();
});

test('a uuid-shaped volatile param is regenerated, not replayed', () => {
  const store = new SqliteStore(':memory:');
  const ids = [
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    'b1e4f9a2-1111-4bbb-8ccc-0305e82c3301',
  ];
  ids.forEach((id, i) => {
    store.insertCapture(capture({ id: `c${i}`, ts: 1_700_000_000_000 + i, reqBody: `_x_req=${id}` }));
  });

  const tmpl = learnRequestTemplate(store, 'POST', '/api/conversations.list');
  assert.ok(tmpl?.volatileParams.includes('_x_req'));
  const fresh = tmpl?.bodyParams._x_req;
  assert.ok(fresh, 'a uuid shape should be regenerated rather than dropped');
  assert.ok(!ids.includes(fresh), 'the regenerated value must not be one of the captured ones');
  assert.match(fresh, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  store.close();
});

test('a header that differs between captures is not learned', () => {
  const store = new SqliteStore(':memory:');
  for (let i = 0; i < 3; i++) {
    store.insertCapture(
      capture({
        id: `c${i}`,
        ts: 1_700_000_000_000 + i,
        reqHeaders: { 'user-agent': 'RealClient/1.0', 'x-client-nonce': `nonce-${i}` },
      }),
    );
  }
  const tmpl = learnRequestTemplate(store, 'POST', '/api/conversations.list');
  assert.equal(tmpl?.headers['user-agent'], 'RealClient/1.0', 'a stable header is kept');
  assert.equal(tmpl?.headers['x-client-nonce'], undefined, 'a varying header is dropped');
  store.close();
});

test('per-request headers are dropped by name even when stable', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'c0',
      reqHeaders: {
        'user-agent': 'RealClient/1.0',
        'if-none-match': 'W/"abc"',
        traceparent: '00-aaa-bbb-01',
        'x-amzn-trace-id': 'Root=1-abc',
      },
    }),
  );
  const tmpl = learnRequestTemplate(store, 'POST', '/api/conversations.list');
  assert.equal(tmpl?.headers['user-agent'], 'RealClient/1.0');
  for (const h of ['if-none-match', 'traceparent', 'x-amzn-trace-id']) {
    assert.equal(tmpl?.headers[h], undefined, `${h} must not be replayed`);
  }
  store.close();
});

test('a single capture still yields a usable template (no variance signal)', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'only', reqBody: '_x_mode=online&types=public_channel' }));
  const tmpl = learnRequestTemplate(store, 'POST', '/api/conversations.list');
  assert.equal(tmpl?.bodyParams._x_mode, 'online');
  assert.deepEqual(tmpl?.volatileParams, [], 'one sample cannot prove anything varies');
  store.close();
});

test('makeFaithful lets the base request win over the template', () => {
  const out = makeFaithful(
    {
      method: 'POST',
      url: 'https://slack.com/api/conversations.list',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=live-token&limit=200',
    },
    { headers: { 'user-agent': 'RealClient/1.0' }, bodyParams: { _x_mode: 'online', limit: '50' }, volatileParams: [] },
  );
  assert.equal(out.headers['user-agent'], 'RealClient/1.0', 'client fingerprint is applied');
  const params = new URLSearchParams(out.body);
  assert.equal(params.get('token'), 'live-token', 'the live credential wins');
  assert.equal(params.get('limit'), '200', 'the caller-supplied param wins over the template');
  assert.equal(params.get('_x_mode'), 'online', 'client-only params are carried over');
});

test('faithfulReplayRequest passes the base through when nothing was captured', () => {
  const store = new SqliteStore(':memory:');
  const base = { method: 'GET', url: 'https://example.com/x', headers: {} };
  assert.deepEqual(faithfulReplayRequest(store, base), base);
  store.close();
});

// ── The fingerprint the replay must not ADD or REPLACE ───────────────────────────

test('a real learned User-Agent beats an adapter\'s hardcoded guess', () => {
  // The bug this closes: Trello and Gmail pin a static `User-Agent` in
  // buildReplayRequest, and the old `{...tmpl, ...base}` let it win — so a
  // replay carried `Chrome/150` (frozen in source) while the user's real
  // browser, sitting right there in the captured template, said `Chrome/141`.
  // We were replacing a genuine fingerprint we held with an approximation.
  const out = makeFaithful(
    {
      method: 'POST',
      url: 'https://mail.google.com/sync/u/0/i/bv',
      headers: {
        'User-Agent': 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36', // adapter's static guess
        'content-type': 'application/json',
        Cookie: 'SID=live-reinjected',
      },
      body: '[[]]',
    },
    {
      headers: {
        'user-agent': 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36', // the user's REAL browser
        origin: 'https://mail.google.com',
      },
      bodyParams: {},
      volatileParams: [],
    },
  );
  assert.equal(
    out.headers['user-agent'],
    'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36',
    'the real captured UA wins over the adapter guess',
  );
  // …and it wins WITHOUT leaving a second, case-different copy behind.
  assert.equal(out.headers['User-Agent'], undefined, 'no duplicate header in the other casing');
  // The base still owns the headers it must: content-type (matches its body) and
  // the re-injected credential.
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(out.headers.cookie, 'SID=live-reinjected', 'the live auth survives, lowercased');
});

test('the base keeps request-specific headers it computed for the target', () => {
  // origin/referer are the adapter's to set per call — a learned value could be
  // for a different account slot, which would be LESS faithful, not more.
  const out = makeFaithful(
    {
      method: 'POST',
      url: 'https://mail.google.com/sync/u/0/i/bv',
      headers: { Referer: 'https://mail.google.com/mail/u/0/', 'content-type': 'application/json' },
      body: '[]',
    },
    {
      headers: { referer: 'https://mail.google.com/mail/u/3/', 'user-agent': 'Real/1' },
      bodyParams: {},
      volatileParams: [],
    },
  );
  assert.equal(out.headers.referer, 'https://mail.google.com/mail/u/0/', 'the target-specific referer stays');
  assert.equal(out.headers['user-agent'], 'Real/1', 'but identity still comes from the real client');
});

test('accept-encoding is carried but capped to what undici can decode', () => {
  // Skipping it let undici send `gzip, deflate` — a value no browser sends.
  // Carrying the real one is more faithful; carrying `zstd` would risk a
  // response body we cannot read, so it is dropped.
  const tmpl = {
    headers: { 'accept-encoding': 'gzip, deflate, br, zstd', 'user-agent': 'Real/1' },
    bodyParams: {},
    volatileParams: [],
  };
  const out = makeFaithful(
    { method: 'GET', url: 'https://slack.com/api/x', headers: {} },
    tmpl,
  );
  assert.equal(out.headers['accept-encoding'], 'gzip, deflate, br', 'zstd dropped, the rest kept in order');
});

test('capAcceptEncoding keeps only decodable codecs, order preserved, else undefined', () => {
  assert.equal(capAcceptEncoding('gzip, deflate, br, zstd'), 'gzip, deflate, br');
  assert.equal(capAcceptEncoding('br;q=1.0, gzip;q=0.8'), 'br, gzip', 'q-values stripped');
  assert.equal(capAcceptEncoding('zstd'), undefined, 'nothing decodable → omit, let undici default');
  assert.equal(capAcceptEncoding('identity'), undefined);
});

test('accept-encoding is now learned from real captures, not skipped', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'ae',
      reqHeaders: { 'user-agent': 'Real/1', 'accept-encoding': 'gzip, deflate, br, zstd' },
    }),
  );
  const tmpl = learnRequestTemplate(store, 'POST', '/api/conversations.list');
  assert.equal(tmpl?.headers['accept-encoding'], 'gzip, deflate, br, zstd', 'the real value is learned');
  store.close();
});

test('a captured header undici would reject is dropped, not fatal', () => {
  // undici throws out of the whole fetch on a header byte > 255, so one odd
  // captured value must not take the entire replay with it.
  const out = makeFaithful(
    { method: 'GET', url: 'https://slack.com/api/x', headers: { 'content-type': 'application/json' } },
    { headers: { 'user-agent': 'Real/1', 'x-weird': 'valu…e' }, bodyParams: {}, volatileParams: [] },
  );
  assert.equal(out.headers['user-agent'], 'Real/1', 'the clean header is kept');
  assert.equal(out.headers['x-weird'], undefined, 'the non-latin1 one is dropped');
});
