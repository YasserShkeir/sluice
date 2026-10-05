// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The replay form's pure parts. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppCatalogReplayAction, RedactedSession } from '@sluice/core';
import { initialValues, missingRequired, nonBlankParams, sessionChoice } from './pages/ReplayPage.js';

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

test('missingRequired names a blank required param by its label, else its name', () => {
  const missing = missingRequired(
    [
      { name: 'channel', required: true, label: 'Channel' },
      { name: 'ts', required: true },
    ],
    {},
  );
  assert.deepEqual(missing, ['Channel', 'ts']);
});

test('missingRequired treats whitespace as missing and ignores optional params', () => {
  const missing = missingRequired(
    [
      { name: 'channel', required: true },
      { name: 'cursor', required: false },
      { name: 'limit' },
    ],
    { channel: '   ', cursor: '', limit: '' },
  );
  assert.deepEqual(missing, ['channel']);
});

test('nonBlankParams drops blank and whitespace-only values and keeps the rest as typed', () => {
  assert.deepEqual(nonBlankParams({ a: '', b: '  ', c: ' x ', d: '0' }), { c: ' x ', d: '0' });
});

const session = (id: string, adapterId: string): RedactedSession => ({
  id,
  adapterId,
  label: `label-${id}`,
  source: 'local-store',
  discoveredAt: 0,
  credentialKinds: ['none'],
});

test('a single session for the app is sent by id without asking', () => {
  const c = sessionChoice([session('s1', 'app'), session('o1', 'other')], 'app', '');
  assert.deepEqual(c.options.map((s) => s.id), ['s1']);
  assert.equal(c.sessionId, 's1');
});

test('several sessions for the app send nothing until one is picked', () => {
  // The runner used to fall back to the first session, which is a request sent
  // as whichever account happened to be discovered first.
  const all = [session('s1', 'app'), session('s2', 'app')];
  assert.equal(sessionChoice(all, 'app', '').sessionId, undefined);
  assert.equal(sessionChoice(all, 'app', 's2').sessionId, 's2');
});

test('a pick that is no longer offered counts as no pick', () => {
  const all = [session('s1', 'app'), session('s2', 'app')];
  assert.equal(sessionChoice(all, 'app', 'gone').sessionId, undefined);
  assert.equal(sessionChoice(all, 'app', 'o1').sessionId, undefined, "another app's session is not offered");
});

test('no session for the app sends none and leaves the answer to the runner', () => {
  const c = sessionChoice([session('o1', 'other')], 'app', '');
  assert.deepEqual(c.options, []);
  assert.equal(c.sessionId, undefined);
});
