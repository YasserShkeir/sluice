// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppToolContext, ReadOnlyStore } from '@sluice/core';
import { isoTime, pageArgs, previewText, requireStore } from './tool-args.js';

test('pageArgs defaults, floors and clamps', () => {
  assert.deepEqual(pageArgs({}), { limit: 50, offset: 0 });
  assert.deepEqual(pageArgs({ limit: 10, offset: 5 }), { limit: 10, offset: 5 });
  assert.equal(pageArgs({ limit: '10' }).limit, 10, 'a numeric string counts');
  assert.equal(pageArgs({ limit: 9999 }).limit, 500);
  assert.equal(pageArgs({ limit: 2.7 }).limit, 2);
  assert.equal(pageArgs({ limit: 0.5 }).limit, 1, 'a positive limit never floors to an empty page');
  assert.equal(pageArgs({ limit: -3 }).limit, 50);
  assert.equal(pageArgs({ limit: 'many' }).limit, 50);
  assert.equal(pageArgs({ offset: -1 }).offset, 0);
  assert.equal(pageArgs({ offset: 3.7 }).offset, 3);
  assert.deepEqual(pageArgs({ limit: 80 }, { defaultLimit: 20, maxLimit: 50 }), { limit: 50, offset: 0 });
  assert.deepEqual(pageArgs({}, { defaultLimit: 20, maxLimit: 50 }), { limit: 20, offset: 0 });
});

test('isoTime is null for anything that is not a time, never a throw', () => {
  assert.equal(isoTime(null), null);
  assert.equal(isoTime(undefined), null);
  assert.equal(isoTime(Number.NaN), null);
  assert.equal(isoTime(Number.POSITIVE_INFINITY), null);
  assert.equal(isoTime(0), '1970-01-01T00:00:00.000Z');
});

test('previewText collapses whitespace and clips with an ellipsis', () => {
  assert.equal(previewText('  a\n\t b  '), 'a b');
  assert.equal(previewText('abcdef', 3), 'abc…');
  assert.equal(previewText('abc', 3), 'abc');
  assert.equal(previewText('x'.repeat(300)).length, 241);
});

test('requireStore returns the store or names what is missing', () => {
  assert.throws(() => requireStore(undefined), /capture store/);
  assert.throws(() => requireStore({} as AppToolContext), /sluice-mcp/);
  const store = {} as ReadOnlyStore;
  assert.equal(requireStore({ store } as AppToolContext), store);
});
