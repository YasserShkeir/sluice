// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * dropMaterialized. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CORE_TABLE_NAMES, SqliteStore } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { dropMaterialized, listMaterializedTables, materialize } from './materialize.js';

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

/** A store holding one flow and one flow template, so the flow tables have rows to lose. */
function storeWithFlows(): SqliteStore {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'p' }));
  s.upsertFlow({
    adapterId: 'slack',
    primaryCaptureId: 'p',
    startedAt: 1,
    endedAt: 2,
    source: 'observed',
    steps: [{ captureId: 'p', seq: 0, role: 'primary', operation: 'conversations.list', required: true }],
  });
  s.upsertFlowTemplate({
    adapterId: 'slack',
    primaryKey: 'conversations.list',
    sampleCount: 1,
    version: 1,
    learnedAt: 1,
    flowParams: [],
    steps: [
      {
        seq: 0,
        role: 'primary',
        method: 'POST',
        path: '/api/conversations.list',
        required: true,
        support: 1,
        delayMsP50: 0,
      },
    ],
  });
  return s;
}

function assertFlowTablesIntact(s: SqliteStore): void {
  const names = tableNames(s);
  for (const t of ['interaction_flows', 'interaction_flow_steps', 'flow_templates']) {
    assert.ok(names.includes(t), `${t} survived`);
  }
  assert.equal(s.listFlows().length, 1);
  assert.equal(s.listFlows()[0]!.steps.length, 1);
  assert.equal(s.listFlowTemplates().length, 1);
}

test('an adapter id that prefixes a core table cannot drop it', () => {
  // `interaction` + `_` reaches interaction_flows by prefix; `flow` reaches
  // flow_templates. Both ids arrive from the dashboard WS unchecked.
  const s = storeWithFlows();
  assert.deepEqual(dropMaterialized(s, ['interaction', 'flow', 'interaction-flow', 'captures', 'items', 'meta']), []);
  assertFlowTablesIntact(s);
  s.close();
});

test('no core table is reachable by any of its underscore prefixes', () => {
  // Drift guard: a table core adds without CORE_TABLE_NAMES fails here.
  const s = storeWithFlows();
  const all = (
    s.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  for (const name of all) {
    const parts = name.split('_');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('_');
      assert.deepEqual(dropMaterialized(s, [prefix]), [], `prefix ${prefix} dropped a table`);
    }
  }
  assert.deepEqual(tableNames(s).filter((n) => !n.startsWith('sqlite_')).sort(), [...all].sort());
  assertFlowTablesIntact(s);
  s.close();
});

test('materialize never derives into a core or FTS table', () => {
  const s = storeWithFlows();
  s.insertCapture(cap({ id: 'i', adapterId: 'interaction', resBody: JSON.stringify({ flowss: [{ id: 'x', evil: 1 }] }) }));
  s.insertCapture(cap({ id: 'f', adapterId: 'flow', resBody: JSON.stringify({ templatess: [{ id: 'y' }] }) }));
  s.insertCapture(cap({ id: 'g', adapterId: 'flow', resBody: JSON.stringify({ 'templates-': [{ id: 'y2' }] }) }));
  s.insertCapture(cap({ id: 'c', adapterId: 'captures', resBody: JSON.stringify({ fts_config: [{ id: 'z' }] }) }));
  const { tables } = materialize(s);
  const core = new Set<string>(CORE_TABLE_NAMES);
  for (const t of tables) {
    assert.ok(!core.has(t.name) && !t.name.includes('_fts'), `materialized into ${t.name}`);
  }
  const cols = (s.db.prepare('PRAGMA table_info(interaction_flows)').all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
  assert.ok(!cols.includes('evil'), 'no column added to a core table');
  assertFlowTablesIntact(s);
  s.close();
});

test('listMaterializedTables attributes tables by sanitized, longest prefix', () => {
  const s = new SqliteStore(':memory:');
  s.db.exec('CREATE TABLE my_app_channel (id TEXT)');
  s.db.exec('CREATE TABLE slack_channel (id TEXT)');
  s.db.exec('CREATE TABLE my_thing (id TEXT)');
  assert.deepEqual(listMaterializedTables(s, ['my-app', 'slack', 'my']), [
    { name: 'my_app_channel', adapterId: 'my-app' },
    { name: 'my_thing', adapterId: 'my' },
    { name: 'slack_channel', adapterId: 'slack' },
  ]);
  assert.deepEqual(dropMaterialized(s, ['my-app']), ['my_app_channel']);
  assert.deepEqual(listMaterializedTables(s, ['interaction', 'flow', 'captures', 'items']), []);
  s.close();
});
