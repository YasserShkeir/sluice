// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The op-progress fold. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The whole reason the operations model exists is that the single `notice` slot
 * clobbered a per-action loop; these pin the folding that prevents that.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpProgress } from '@sluice/core';
import { foldOperations } from './ws.js';

const op = (requestId: string, over: Partial<OpProgress> = {}): OpProgress => ({
  requestId,
  kind: 'sync',
  state: 'running',
  ...over,
});

test('successive frames for one op UPDATE a single row, not append', () => {
  let list: OpProgress[] = [];
  list = foldOperations(list, op('a', { state: 'running', count: 1 }));
  list = foldOperations(list, op('a', { state: 'running', count: 5 }));
  list = foldOperations(list, op('a', { state: 'ok', count: 5 }));
  assert.equal(list.length, 1, 'one operation, not three');
  assert.equal(list[0]?.state, 'ok');
  assert.equal(list[0]?.count, 5);
});

test('distinct ops each get a row, newest first', () => {
  let list: OpProgress[] = [];
  list = foldOperations(list, op('a'));
  list = foldOperations(list, op('b'));
  assert.deepEqual(list.map((o) => o.requestId), ['b', 'a']);
});

test('the list is capped, dropping the oldest', () => {
  let list: OpProgress[] = [];
  for (let i = 0; i < 5; i++) list = foldOperations(list, op(`op${i}`), 3);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((o) => o.requestId), ['op4', 'op3', 'op2'], 'newest kept, oldest dropped');
});

test('an update to an existing op does not reorder or duplicate it', () => {
  let list: OpProgress[] = [];
  list = foldOperations(list, op('a'));
  list = foldOperations(list, op('b'));
  list = foldOperations(list, op('a', { state: 'error', detail: 'boom' }));
  assert.deepEqual(list.map((o) => o.requestId), ['b', 'a'], 'a stays in place, no dup');
  assert.equal(list.find((o) => o.requestId === 'a')?.state, 'error');
});
