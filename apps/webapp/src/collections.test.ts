// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The shared collection helpers. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { groupBy, toggled } from './collections.js';

test('toggled flips a value without mutating; groupBy keeps first-seen order', () => {
  assert.deepEqual([...toggled(new Set(['a']), 'b')], ['a', 'b']);
  const s = new Set(['a', 'b']);
  assert.deepEqual([...toggled(s, 'a')], ['b']);
  assert.deepEqual([...s], ['a', 'b']);
  const out = groupBy([{ k: 'b', v: 1 }, { k: 'a', v: 2 }, { k: 'b', v: 3 }], (i) => i.k);
  assert.deepEqual([...out.keys()], ['b', 'a']);
  assert.deepEqual(out.get('b')?.map((i) => i.v), [1, 3]);
});
