// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * dropMaterialized. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { dropMaterialized, materialize } from './materialize.js';

function cap(over: Partial<Capture>): Capture {
  return {
    id: 'c', ts: 1_700_000_000_000, source: 'mitm', adapterId: 'slack', method: 'POST',
    url: 'https://slack.com/api/conversations.list', host: 'slack.com',
    path: '/api/conversations.list', status: 200, durationMs: 1,
    reqHeaders: {}, reqBody: null, resHeaders: {},
    resBody: JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'general' }] }), ...over,
  };
}

const tableNames = (s: SqliteStore): string[] =>
  (s.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );

test('dropMaterialized removes an app’s generated tables and only those', () => {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'a' }));
  materialize(s);
  const before = tableNames(s);
  assert.ok(before.some((n) => n.startsWith('slack_')), 'materialize made slack_* tables');

  const dropped = dropMaterialized(s, ['slack']);
  assert.ok(dropped.length > 0);
  assert.ok(dropped.every((n) => n.startsWith('slack_')));
  const after = tableNames(s);
  assert.ok(!after.some((n) => n.startsWith('slack_')), 'all slack_* tables gone');
  // Core tables untouched.
  for (const core of ['captures', 'workspaces', 'items', 'containers']) {
    assert.ok(after.includes(core), `${core} survived`);
  }
  s.close();
});

test('dropMaterialized never touches a core table or another app', () => {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'a', adapterId: 'slack' }));
  materialize(s);
  // A stand-in for another app's materialized table, created directly so the test
  // does not depend on a second adapter's parse. dropMaterialized(['slack']) must
  // leave it — it matches the trello_ prefix, not slack_.
  s.db.exec('CREATE TABLE trello_card (id TEXT)');
  dropMaterialized(s, ['slack']);
  const after = tableNames(s);
  assert.ok(after.includes('trello_card'), 'another app\'s table untouched');
  assert.ok(after.includes('captures'), 'captures untouched');
  assert.ok(!after.some((n) => n.startsWith('slack_')), 'slack tables gone');
  s.close();
});

test('drop + rebuild reconciles derived tables after a capture delete', () => {
  // The integrity rule: materialize never deletes, so after removing captures the
  // derived tables are stale until drop + full rebuild.
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'a' }));
  materialize(s);
  const channelsBefore = (s.db.prepare('SELECT COUNT(*) n FROM slack_channel').get() as { n: number }).n;
  assert.ok(channelsBefore > 0);

  s.deleteCaptures({ adapterId: 'slack' });
  dropMaterialized(s, ['slack']);
  materialize(s);
  // No captures left → the rebuilt table is empty (or absent), never stale rows.
  const exists = (s.db.prepare(`SELECT name FROM sqlite_master WHERE name='slack_channel'`).get()) as
    | { name: string }
    | undefined;
  const n = exists ? (s.db.prepare('SELECT COUNT(*) n FROM slack_channel').get() as { n: number }).n : 0;
  assert.equal(n, 0, 'rebuilt derived table describes no captures that no longer exist');
  s.close();
});
