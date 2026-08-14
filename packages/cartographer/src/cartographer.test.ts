// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fixture-based tests for the cartographer. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The store is a real in-memory SqliteStore seeded with a couple of Slack
 * captures — the same shapes `@sluice/adapter-slack` parses.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { buildApiMap, deriveTables, inferSchema, materialize, normalizePath, renderMarkdown } from './index.js';

function capture(over: Partial<Capture>): Capture {
  return {
    id: 'cap',
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/api.test',
    host: 'slack.com',
    path: '/api/api.test',
    status: 200,
    durationMs: 10,
    reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    reqBody: null,
    resHeaders: { 'content-type': 'application/json' },
    resBody: null,
    ...over,
  };
}

function seed(store: SqliteStore): void {
  store.insertCapture(
    capture({
      id: 'c1',
      path: '/api/conversations.list',
      url: 'https://slack.com/api/conversations.list',
      reqBody: 'token=xoxc-REDACTED&types=public_channel',
      resBody: JSON.stringify({
        ok: true,
        channels: [
          { id: 'C1', name: 'general', is_channel: true, is_private: false, num_members: 42, topic: { value: 'hi' } },
          { id: 'C2', name: 'random', is_channel: true, is_private: false, num_members: 5 },
        ],
      }),
    }),
  );
  store.insertCapture(
    capture({
      id: 'c2',
      path: '/api/users.list',
      url: 'https://slack.com/api/users.list',
      reqBody: 'token=xoxc-REDACTED&limit=100',
      resBody: JSON.stringify({
        ok: true,
        members: [
          { id: 'U1', name: 'ada', profile: { display_name: 'Ada' } },
          { id: 'U2', name: 'bob', profile: { display_name: 'Bob' } },
        ],
      }),
    }),
  );
}

test('buildApiMap groups captures by method + normalized path', () => {
  const store = new SqliteStore(':memory:');
  seed(store);
  const map = buildApiMap(store);
  const keys = map.endpoints.map((e) => e.key);
  assert.ok(keys.includes('POST /api/conversations.list'));
  assert.ok(keys.includes('POST /api/users.list'));

  const convo = map.endpoints.find((e) => e.path === '/api/conversations.list');
  assert.ok(convo);
  assert.equal(convo?.sampleCount, 1);
  assert.deepEqual(convo?.statuses, [200]);
  // request param *names* are collected (values never are)
  assert.ok(convo?.requestParams.includes('token'));
  assert.ok(convo?.requestParams.includes('types'));
  assert.ok(convo?.responseHeaders.includes('content-type'));

  // merged response schema: channels is an array of objects with a string id
  const channels = convo?.responseSchema.properties?.channels;
  assert.ok(channels);
  assert.ok(channels?.types.includes('array'));
  assert.deepEqual(channels?.items?.properties?.id?.types, ['string']);
  // num_members present in both channel samples → not nullable
  assert.equal(channels?.items?.properties?.num_members?.nullable, false);
  // topic present in only one of the two channel samples → nullable
  assert.equal(channels?.items?.properties?.topic?.nullable, true);
  store.close();
});

test('normalizePath collapses id-like segments and merges samples', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({ id: 'a', method: 'GET', path: '/v1/users/123/profile', url: 'https://api.x.com/v1/users/123/profile', adapterId: null, resBody: JSON.stringify({ name: 'a' }) }),
  );
  store.insertCapture(
    capture({ id: 'b', method: 'GET', path: '/v1/users/456/profile', url: 'https://api.x.com/v1/users/456/profile', adapterId: null, resBody: JSON.stringify({ name: 'b' }) }),
  );
  assert.equal(normalizePath('/v1/users/123/profile'), '/v1/users/{id}/profile');

  const map = buildApiMap(store);
  const ep = map.endpoints.find((e) => e.method === 'GET');
  assert.equal(ep?.path, '/v1/users/{id}/profile');
  assert.equal(ep?.sampleCount, 2);
  store.close();
});

test('inferSchema maps JS types to SQLite types with nullability + presence', () => {
  const t = inferSchema([
    { id: 'C1', num_members: 42, is_private: false, topic: { value: 'x' } },
    { id: 'C2', num_members: 5 }, // is_private + topic absent
  ]);
  assert.equal(t.total, 2);
  assert.equal(t.columns.id?.sqliteType, 'TEXT');
  assert.equal(t.columns.num_members?.sqliteType, 'INTEGER');
  assert.equal(t.columns.is_private?.sqliteType, 'INTEGER'); // boolean → INTEGER
  assert.equal(t.columns.topic?.sqliteType, 'TEXT'); // nested object → JSON text
  assert.equal(t.columns.id?.nullable, false);
  assert.equal(t.columns.is_private?.nullable, true); // absent in 2nd record
  assert.equal(t.columns.num_members?.present, 2);
});

test('deriveTables proposes slack_channel + slack_user with an id primary key', () => {
  const store = new SqliteStore(':memory:');
  seed(store);
  const specs = deriveTables(store);
  assert.deepEqual(specs.map((s) => s.name), ['slack_channel', 'slack_user']); // sorted
  const ch = specs.find((s) => s.name === 'slack_channel');
  assert.equal(ch?.primaryKey, 'id');
  assert.ok(ch && 'name' in ch.columns);
  assert.ok(ch && 'num_members' in ch.columns);
  assert.deepEqual(ch?.sourceKeys, ['channels']);
  const us = specs.find((s) => s.name === 'slack_user');
  assert.equal(us?.primaryKey, 'id');
  assert.deepEqual(us?.sourceKeys, ['members']);
  store.close();
});

test('materialize creates slack_channel/slack_user with the right columns + rows, idempotently', () => {
  const store = new SqliteStore(':memory:');
  seed(store);
  const r1 = materialize(store);
  const names = r1.tables.map((t) => t.name);
  assert.ok(names.includes('slack_channel'));
  assert.ok(names.includes('slack_user'));
  assert.equal(r1.tables.find((t) => t.name === 'slack_channel')?.rows, 2);
  assert.equal(r1.tables.find((t) => t.name === 'slack_user')?.rows, 2);

  const cols = (store.db.prepare('PRAGMA table_info("slack_channel")').all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  for (const col of ['id', 'name', 'is_channel', 'is_private', 'num_members', 'topic']) {
    assert.ok(cols.includes(col), `slack_channel missing column ${col}`);
  }

  const general = store.db.prepare('SELECT * FROM slack_channel WHERE id = ?').get('C1') as Record<
    string,
    unknown
  >;
  assert.equal(general.name, 'general');
  assert.equal(general.num_members, 42);
  assert.equal(general.is_private, 0); // boolean stored as 0/1
  assert.equal(JSON.parse(general.topic as string).value, 'hi'); // nested object stored as JSON

  // Idempotent: a second run must not duplicate rows.
  const r2 = materialize(store);
  assert.equal(r2.tables.find((t) => t.name === 'slack_channel')?.rows, 2);
  assert.equal(r2.tables.find((t) => t.name === 'slack_user')?.rows, 2);
  store.close();
});

test('materialize dedupes id-less collections via a content-hash key (slack_message)', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'h1',
      path: '/api/conversations.history',
      url: 'https://slack.com/api/conversations.history',
      reqBody: 'token=xoxc-REDACTED&channel=C1',
      resBody: JSON.stringify({
        ok: true,
        messages: [
          { type: 'message', ts: '1700000000.001', user: 'U1', text: 'hi' },
          { type: 'message', ts: '1700000001.002', user: 'U2', text: 'yo' },
        ],
      }),
    }),
  );
  const specs = deriveTables(store);
  assert.equal(specs.find((s) => s.name === 'slack_message')?.primaryKey, null);

  const r1 = materialize(store);
  assert.equal(r1.tables.find((t) => t.name === 'slack_message')?.rows, 2);
  const r2 = materialize(store);
  assert.equal(r2.tables.find((t) => t.name === 'slack_message')?.rows, 2); // no duplicates
  store.close();
});

test('materialize keeps an existing id PK when a later batch has no id (no __pk crash)', () => {
  // Live materialize is incremental. A first batch can create slack_item with
  // PRIMARY KEY(id); a later sinceTs batch of id-less objects used to INSERT
  // `__pk` and abort the whole transaction ("table slack_item has no column
  // named __pk"). The key strategy must stick to the existing table.
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'item-with-id',
      ts: 1_700_000_000_000,
      path: '/api/items.withId',
      url: 'https://slack.com/api/items.withId',
      resBody: JSON.stringify({
        ok: true,
        items: [{ id: 'I1', name: 'has-id' }],
      }),
    }),
  );
  materialize(store);
  const cols1 = (
    store.db.prepare('PRAGMA table_info("slack_item")').all() as Array<{ name: string; pk: number }>
  );
  assert.ok(cols1.some((c) => c.name === 'id' && c.pk > 0));
  assert.ok(!cols1.some((c) => c.name === '__pk'));

  store.insertCapture(
    capture({
      id: 'item-no-id',
      ts: 1_700_000_010_000,
      path: '/api/items.noId',
      url: 'https://slack.com/api/items.noId',
      resBody: JSON.stringify({
        ok: true,
        items: [
          { name: 'orphan-a', kind: 'x' },
          { name: 'orphan-b', kind: 'y' },
        ],
      }),
    }),
  );
  // Incremental pass — only the id-less capture. Must not throw.
  const r = materialize(store, { sinceTs: 1_700_000_005_000 });
  assert.ok(r.tables.some((t) => t.name === 'slack_item'));
  const cols2 = (
    store.db.prepare('PRAGMA table_info("slack_item")').all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(!cols2.includes('__pk'), 'must not bolt __pk onto an id-keyed table');
  // Original id row still present; id-less rows were skipped.
  const n = (store.db.prepare('SELECT COUNT(*) AS n FROM slack_item').get() as { n: number }).n;
  assert.equal(n, 1);
  const row = store.db.prepare('SELECT name FROM slack_item WHERE id = ?').get('I1') as {
    name: string;
  };
  assert.equal(row.name, 'has-id');
  store.close();
});

test('renderMarkdown emits a section per endpoint and leaks no secret values', () => {
  const store = new SqliteStore(':memory:');
  seed(store);
  const md = renderMarkdown(buildApiMap(store));
  assert.ok(md.includes('## POST /api/conversations.list'));
  assert.ok(md.includes('## POST /api/users.list'));
  assert.ok(md.includes('Request params:'));
  assert.ok(md.includes('channels'));
  assert.ok(!md.includes('xoxc')); // redacted token value never appears
  store.close();
});
