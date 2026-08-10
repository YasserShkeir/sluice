// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Webapp analytics tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * analytics.ts is pure — no window, no document — so it runs under node:test
 * without pulling in a browser test runner for the whole app.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capture } from '@sluice/core';
import {
  appEndpoints,
  appOf,
  capturesForApp,
  computeKpis,
  recentErrors,
  statusDistribution,
  topEndpoints,
} from './analytics.js';

function capture(over: Partial<Capture> = {}): Capture {
  return {
    id: 'c1',
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/conversations.list',
    host: 'slack.com',
    path: '/api/conversations.list',
    status: 200,
    durationMs: 10,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: '{"ok":true}',
    ...over,
  };
}

test('appOf labels unattributed traffic rather than dropping it', () => {
  assert.equal(appOf(capture()), 'slack');
  // Capture-all means most traffic has no adapter; it still needs a stable bucket.
  assert.equal(appOf(capture({ adapterId: null, host: 'example.com' })), 'unclassified');
});

test('recentErrors finds HTTP failures and ok:false bodies', () => {
  const rows = recentErrors(
    [
      capture({ id: 'a' }),
      capture({ id: 'b', status: 500, resBody: null }),
      capture({ id: 'c', status: 200, resBody: '{"ok":false,"error":"not_in_channel"}' }),
    ],
    10,
  );
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ['b', 'c'], 'a 200 with ok:false is still a failure');
  assert.equal(rows.find((r) => r.id === 'c')?.reason, 'not_in_channel');
});

test('recentErrors caches per capture id and stays correct', () => {
  // The verdict cache is keyed by capture id; captures are immutable once stored,
  // so a second call must return the same answer rather than a stale or empty one.
  const caps = [capture({ id: 'x', status: 404, resBody: null })];
  assert.equal(recentErrors(caps, 10).length, 1);
  assert.equal(recentErrors(caps, 10).length, 1);
});

test('recentErrors respects its limit', () => {
  const caps = Array.from({ length: 20 }, (_, i) => capture({ id: `e${i}`, status: 500 }));
  assert.equal(recentErrors(caps, 6).length, 6);
});

test('recentErrors tolerates a malformed body', () => {
  assert.doesNotThrow(() => recentErrors([capture({ resBody: '{not json' })], 5));
});

test('statusDistribution buckets by status class, and pending separately', () => {
  const d = statusDistribution([
    capture({ id: '1', status: 200 }),
    capture({ id: '2', status: 201 }),
    capture({ id: '3', status: 404 }),
    capture({ id: '4', status: 503 }),
    // A WebSocket frame and an in-flight request both have a null status; they
    // must not be miscounted as an error class.
    capture({ id: '5', status: null }),
  ]);
  assert.equal(d.c2, 2);
  assert.equal(d.c4, 1);
  assert.equal(d.c5, 1);
  assert.equal(d.pending, 1);
  assert.equal(d.total, 5);
});

test('computeKpis counts requests and surfaces an error rate', () => {
  const k = computeKpis([
    capture({ id: '1', status: 200, durationMs: 10 }),
    capture({ id: '2', status: 500, durationMs: 30 }),
  ]);
  assert.equal(k.total, 2);
  assert.ok(k.errorRate > 0, 'a 500 must show up in the error rate');
});

test('topEndpoints groups by method + path', () => {
  const top = topEndpoints(
    [
      capture({ id: '1' }),
      capture({ id: '2' }),
      capture({ id: '3', path: '/api/users.list', url: 'https://slack.com/api/users.list' }),
    ],
    10,
  );
  const busiest = top[0];
  assert.equal(busiest?.count, 2, 'the repeated endpoint is busiest');
});

test('the analytics helpers tolerate an empty window', () => {
  assert.equal(computeKpis([]).total, 0);
  assert.deepEqual(recentErrors([], 5), []);
  assert.deepEqual(topEndpoints([], 5), []);
});

// ── Per-app detail page ──────────────────────────────────────────────────────

const SLACK = { id: 'slack', hosts: ['slack.com'] };

test('capturesForApp claims traffic on the app hosts that no adapter matched', () => {
  // The proxy decrypts every host the adapter names, but matchRequest only
  // claims a slice of them. The app page must report on what was decrypted for
  // that app, not only on what a parser recognised.
  const caps = [
    capture({ id: 'claimed', adapterId: 'slack' }),
    capture({ id: 'unclaimed', adapterId: null, host: 'edgeapi.slack.com', path: '/cache/x' }),
    capture({ id: 'other', adapterId: 'trello', host: 'trello.com', path: '/1/boards' }),
  ];
  assert.deepEqual(
    capturesForApp(caps, SLACK).map((c) => c.id),
    ['claimed', 'unclaimed'],
  );
});

test('capturesForApp keeps a capture the adapter claimed on an unlisted host', () => {
  // adapterId is the adapter's own verdict; a host list that has drifted must
  // not overrule it.
  const caps = [capture({ id: 'claimed', adapterId: 'slack', host: 'files.slack-edge.example' })];
  assert.deepEqual(
    capturesForApp(caps, SLACK).map((c) => c.id),
    ['claimed'],
  );
});

test('capturesForApp attributes nothing to an app that claims no hosts', () => {
  // A PLANNED app has hosts: [] — an empty claim must match nothing rather
  // than everything.
  assert.deepEqual(capturesForApp([capture({ adapterId: 'slack' })], { id: 'notion', hosts: [] }), []);
});

test('appEndpoints groups by method+path and keeps every status it saw', () => {
  const rows = appEndpoints([
    capture({ id: '1', status: 200, ts: 10 }),
    capture({ id: '2', status: 429, ts: 30 }),
    capture({ id: '3', status: null, ts: 20 }),
    capture({ id: '4', status: 200, ts: 5, method: 'GET' }),
  ]);
  const busiest = rows[0];
  assert.equal(busiest?.count, 3, 'same method+path collapses to one row');
  assert.deepEqual(busiest?.statuses, [200, 429], 'a pending capture contributes no status');
  assert.equal(busiest?.errors, 1);
  assert.equal(busiest?.lastTs, 30, 'last seen is the newest call, not the last iterated');
  assert.equal(rows.length, 2, 'a different method is a different endpoint');
});

test('appEndpoints tolerates an empty window', () => {
  assert.deepEqual(appEndpoints([]), []);
});
