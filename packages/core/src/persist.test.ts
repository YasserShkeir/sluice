// SPDX-License-Identifier: Apache-2.0
/**
 * The persistence funnel every capture path shares. In-memory store, fake
 * adapters: what is under test is the order of the steps and what survives a
 * throwing hook, not any real service's parser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchAdapter, persistCapture, redactCapture } from './persist.js';
import { SqliteStore } from './store.js';
import type { Adapter, Capture } from './types.js';

function capture(over: Partial<Capture> = {}): Capture {
  return {
    id: 'cap_1',
    ts: 1_700_000_000_000,
    source: 'replay',
    adapterId: null,
    method: 'GET',
    url: 'https://api.example.test/v1/things/123',
    host: 'api.example.test',
    path: '/v1/things/123',
    status: 200,
    durationMs: 5,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: '{"ok":true}',
    ...over,
  };
}

function fakeAdapter(over: Partial<Adapter> = {}): Adapter {
  return {
    id: 'fake',
    displayName: 'Fake',
    hosts: ['api.example.test'],
    matchRequest: (r) => r.host === 'api.example.test',
    parse: () => ({
      containers: [{ id: 'K1', workspaceId: 'W1', adapterId: 'fake', kind: 'channel', name: 'things' }],
    }),
    listReplayActions: () => [],
    buildReplayRequest: () => {
      throw new Error('not used');
    },
    ...over,
  };
}

test('classify names the operation, and reclassify overrides a stored one', () => {
  const store = new SqliteStore(':memory:');
  const adapter = fakeAdapter({ classify: () => ({ class: 'structure', operation: 'things/:id' }) });
  assert.equal(persistCapture(store, capture(), adapter).capture.classification, 'things/:id');

  // An already-classified row keeps its name unless the caller asks again.
  const kept = persistCapture(store, capture({ id: 'cap_2', classification: 'old/name' }), adapter);
  assert.equal(kept.capture.classification, 'old/name');
  const redone = persistCapture(store, capture({ id: 'cap_2', classification: 'old/name' }), adapter, {
    reclassify: true,
  });
  assert.equal(redone.capture.classification, 'things/:id');
  store.close();
});

test('with no adapter the generic operation name applies, and the row still counts as parsed', () => {
  const store = new SqliteStore(':memory:');
  const r = persistCapture(store, capture(), undefined);
  assert.equal(r.capture.classification, 'things/:id');
  assert.deepEqual(r.parsed, {});
  assert.equal(r.parseError, undefined);
  assert.equal(typeof store.getCapture('cap_1')?.parsedAt, 'number');
  store.close();
});

test('a throwing parser still stores the capture, unparsed, and reports why', () => {
  const store = new SqliteStore(':memory:');
  const adapter = fakeAdapter({
    parse: () => {
      throw new Error('parser blew up');
    },
  });
  const r = persistCapture(store, capture(), adapter);
  assert.match(String(r.parseError), /parser blew up/);
  assert.deepEqual(r.parsed, {});
  const stored = store.getCapture('cap_1');
  assert.ok(stored, 'the capture is not lost to its parser');
  assert.equal(stored?.parsedAt ?? null, null, 'and stays findable as unparsed');
  assert.equal(stored?.adapterId, 'fake');
  store.close();
});

test('cursor seeds are enqueued, and a throwing nextCursors loses nothing', () => {
  const store = new SqliteStore(':memory:');
  const seeding = fakeAdapter({
    nextCursors: () => [{ adapterId: 'fake', actionId: 'fake.list', cursor: 'page2' }],
  });
  const r = persistCapture(store, capture(), seeding);
  assert.equal(r.seeded, 1);
  assert.equal(r.seeded, store.countCursors().pending);
  assert.equal(r.counts.containers, 1, 'the parse was applied');

  const throwing = fakeAdapter({
    nextCursors: () => {
      throw new Error('boom');
    },
  });
  const r2 = persistCapture(store, capture({ id: 'cap_2' }), throwing);
  assert.equal(r2.seeded, 0);
  assert.ok(store.getCapture('cap_2'), 'stored despite the throw');
  store.close();
});

test('an existing adapterId is kept, and the caller’s object is never mutated', () => {
  const store = new SqliteStore(':memory:');
  const raw = capture({ adapterId: 'other', url: 'https://api.example.test/v1/things?access_token=fakefakefake1234' });
  const snapshot = structuredClone(raw);
  const r = persistCapture(store, raw, fakeAdapter());
  assert.equal(r.capture.adapterId, 'other');
  assert.deepEqual(raw, snapshot, 'flow replay keeps using its own object after record');
  store.close();
});

test('every URL-like field, header and body is redacted before it is stored', () => {
  const store = new SqliteStore(':memory:');
  const secret = 'fakefakefake1234';
  persistCapture(
    store,
    capture({
      url: `https://api.example.test/v1/things?access_token=${secret}`,
      path: `/v1/things?access_token=${secret}`,
      tabUrl: `https://app.example.test/cb#access_token=${secret}`,
      reqHeaders: { authorization: `Bearer ${secret}` },
      resBody: `{"access_token":"${secret}"}`,
    }),
    undefined,
  );
  assert.ok(!JSON.stringify(store.getCapture('cap_1')).includes(secret));
  store.close();
});

test('redactCapture is idempotent', () => {
  const once = redactCapture(capture({ url: 'https://api.example.test/v1/x?token=fakefakefake1234' }));
  assert.deepEqual(redactCapture(once), once);
});

test('matchAdapter: registry order decides, and no claimant is undefined', () => {
  assert.equal(matchAdapter([fakeAdapter({ id: 'a' }), fakeAdapter({ id: 'b' })], capture())?.id, 'a');
  assert.equal(matchAdapter([fakeAdapter({ matchRequest: () => false })], capture()), undefined);
  assert.equal(matchAdapter([], capture()), undefined);
});

test('matchAdapter skips a matcher that throws', () => {
  const thrower = fakeAdapter({
    id: 'thrower',
    matchRequest: () => {
      throw new Error('bad matcher');
    },
  });
  const good = fakeAdapter({ id: 'good' });
  assert.equal(matchAdapter([thrower, good], capture())?.id, 'good');
  assert.equal(matchAdapter([thrower], capture()), undefined);
});

test('matchAdapter reports a throwing matcher and passes only the match fields', () => {
  const errors: unknown[] = [];
  const seen: unknown[] = [];
  const thrower = fakeAdapter({
    id: 'thrower',
    matchRequest: () => {
      throw new Error('bad matcher');
    },
  });
  const spy = fakeAdapter({
    id: 'spy',
    matchRequest: (r) => {
      seen.push(r);
      return true;
    },
  });
  assert.equal(matchAdapter([thrower, spy], capture({ resBody: 'secret body' }), (e) => errors.push(e))?.id, 'spy');
  assert.equal(errors.length, 1);
  assert.deepEqual(Object.keys(seen[0] as object).sort(), ['host', 'method', 'path', 'url']);
});
