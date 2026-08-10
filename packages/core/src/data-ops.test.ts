// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Data-management store methods (v2). Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from './store.js';
import type { Capture } from './types.js';

function cap(over: Partial<Capture>): Capture {
  return {
    id: 'c', ts: 1_700_000_000_000, source: 'mitm', adapterId: null, method: 'GET',
    url: 'https://x/', host: 'x', path: '/', status: 200, durationMs: 1,
    reqHeaders: {}, reqBody: null, resHeaders: {}, resBody: 'hello world', ...over,
  };
}

test('deleteCaptures(unattributed) removes only the noise, and its count matches', () => {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'a', adapterId: 'slack' }));
  s.insertCapture(cap({ id: 'b', adapterId: null }));
  s.insertCapture(cap({ id: 'c', adapterId: null }));
  // The confirm dialog shows this; the delete uses the SAME predicate.
  assert.equal(s.countCaptures({ unattributed: true }), 2);
  assert.equal(s.deleteCaptures({ unattributed: true }), 2);
  assert.equal(s.countCaptures(), 1, 'the attributed one survives');
  assert.equal(s.countCaptures({ unattributed: true }), 0);
  s.close();
});

test('deleteCaptures drops the FTS rows too (no orphan search hits)', () => {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'a', adapterId: null, resBody: 'findme unique-token' }));
  assert.equal(s.searchCaptures('unique-token').length, 1);
  s.deleteCaptures({ unattributed: true });
  assert.equal(s.searchCaptures('unique-token').length, 0, 'FTS entry gone with the row');
  s.close();
});

test('deleteCaptures refuses an empty filter — wipe is by name', () => {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'a' }));
  assert.throws(() => s.deleteCaptures({}), /use wipe/);
  assert.equal(s.countCaptures(), 1, 'nothing deleted');
  s.close();
});

test('deleteCaptures by host targets exactly that host', () => {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'a', host: 'keep.test' }));
  s.insertCapture(cap({ id: 'b', host: 'drop.test' }));
  assert.equal(s.deleteCaptures({ host: 'drop.test' }), 1);
  assert.equal(s.countCaptures({ host: 'keep.test' }), 1);
  s.close();
});

test('storageStats reports tables and totals', () => {
  const s = new SqliteStore(':memory:');
  for (let i = 0; i < 20; i++) s.insertCapture(cap({ id: `c${i}`, resBody: 'x'.repeat(500) }));
  const stats = s.storageStats();
  assert.ok(stats.totalBytes > 0);
  const captures = stats.tables.find((t) => t.name === 'captures');
  assert.ok(captures, 'captures table is reported');
  assert.equal(captures?.rows, 20);
  s.close();
});

test('wipe empties everything and reports the capture count', () => {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'a', adapterId: 'slack' }));
  s.applyParseResult(
    { workspaces: [{ id: 'W1', adapterId: 'slack', name: 'Acme' }] },
    Date.now(),
  );
  assert.equal(s.listWorkspaces().length, 1);
  const { captures } = s.wipe();
  assert.equal(captures, 1);
  assert.equal(s.countCaptures(), 0);
  assert.equal(s.listWorkspaces().length, 0, 'derived entities gone too');
  s.close();
});

test('vacuum runs without error after a delete', () => {
  const s = new SqliteStore(':memory:');
  for (let i = 0; i < 50; i++) s.insertCapture(cap({ id: `c${i}`, adapterId: null }));
  s.deleteCaptures({ unattributed: true });
  assert.doesNotThrow(() => s.vacuum());
  s.close();
});

test('itemsForCapture returns only items whose parse cited that capture', () => {
  const s = new SqliteStore(':memory:');
  s.insertCapture(cap({ id: 'cap1', adapterId: 'slack' }));
  s.insertCapture(cap({ id: 'cap2', adapterId: 'slack' }));
  s.applyParseResult(
    {
      workspaces: [{ id: 'W1', adapterId: 'slack', name: 'Acme' }],
      containers: [{ id: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'channel', name: 'general' }],
      items: [
        { id: 'i1', containerId: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'message', ts: 1, text: 'from cap1', sourceCaptureIds: ['cap1'] },
        { id: 'i2', containerId: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'message', ts: 2, text: 'from cap2', sourceCaptureIds: ['cap2'] },
      ],
    },
    Date.now(),
  );
  const forCap1 = s.itemsForCapture('cap1');
  assert.equal(forCap1.length, 1, 'exactly the item derived from cap1');
  assert.equal(forCap1[0]?.id, 'i1');
  // A capture that produced no entities returns nothing, not everything.
  assert.equal(s.itemsForCapture('nope').length, 0);
  s.close();
});
