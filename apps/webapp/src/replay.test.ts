// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The replay form's pure parts. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppCatalogReplayAction } from '@sluice/core';
import { initialValues } from './pages/ReplayPage.js';

const action = (params: AppCatalogReplayAction['params']): AppCatalogReplayAction => ({
  id: 'a',
  label: 'An action',
  method: 'GET',
  params,
});

test("a field starts at the adapter's own default", () => {
  // `default` used to be dropped in transit by the catalog, so an action
  // declaring `limit=200` arrived as an empty box and a user guessing at a
  // number the adapter had already chosen.
  const v = initialValues(
    action([
      { name: 'limit', kind: 'number', default: '200' },
      { name: 'types', kind: 'string', default: 'public_channel,im' },
    ]),
  );
  assert.deepEqual(v, { limit: '200', types: 'public_channel,im' });
});

test('a field with no default starts empty, not undefined', () => {
  // The inputs are controlled. `undefined` flips React to an uncontrolled input
  // and logs a warning the first time someone types into it.
  const v = initialValues(action([{ name: 'cursor', kind: 'cursor' }]));
  assert.deepEqual(v, { cursor: '' });
  assert.equal(typeof v.cursor, 'string');
});

test('an action with no params yields an empty map, not a crash', () => {
  assert.deepEqual(initialValues(action([])), {});
});
