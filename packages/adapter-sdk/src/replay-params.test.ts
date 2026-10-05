// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReplayAction } from '@sluice/core';
import { actionParam, actionUrl, fillPathParams, requireActionParam } from './replay-params.js';

const ACTION: ReplayAction = {
  id: 'demo.cards',
  adapterId: 'demo',
  label: 'Cards',
  method: 'GET',
  urlTemplate: 'https://demo.test/1/boards/{boardId}/cards',
  params: [
    { name: 'boardId', label: 'Board', kind: 'string', required: true },
    { name: 'limit', label: 'Limit', kind: 'number', default: '100' },
  ],
};

test('actionParam prefers the caller, falls back to the default, and keeps an empty string', () => {
  assert.equal(actionParam(ACTION, {}, 'limit'), '100');
  assert.equal(actionParam(ACTION, { limit: '5' }, 'limit'), '5');
  assert.equal(actionParam(ACTION, { limit: '' }, 'limit'), '', "'' is the caller's answer, not a gap");
  assert.equal(actionParam(ACTION, {}, 'missing'), undefined);
  assert.equal(actionParam(ACTION, {}, 'constructor'), undefined, 'never a prototype member');
});

test('requireActionParam returns a value, or throws naming the param, the action and the hint', () => {
  assert.equal(requireActionParam(ACTION, { boardId: 'b1' }, 'boardId'), 'b1');
  assert.throws(() => requireActionParam(ACTION, {}, 'boardId'), /"demo\.cards" needs a value for "boardId"\.$/);
  assert.throws(
    () => requireActionParam(ACTION, { boardId: '' }, 'boardId', ' — it is a required body field'),
    /"boardId" — it is a required body field\.$/,
  );
});

test('fillPathParams encodes, reports the path params, and throws on a missing one', () => {
  const { url, pathParams } = fillPathParams(ACTION, { boardId: 'a/b#c' });
  assert.equal(url, 'https://demo.test/1/boards/a%2Fb%23c/cards');
  assert.deepEqual([...pathParams], ['boardId']);
  assert.throws(() => fillPathParams(ACTION, {}), /boardId.*path segment/);
  assert.throws(() => fillPathParams(ACTION, { boardId: '' }), /boardId/);
});

test('fillPathParams uses a custom resolver, and is repeatable (no shared regex state)', () => {
  const custom = fillPathParams(ACTION, {}, (name) => (name === 'boardId' ? 'x1' : undefined));
  assert.equal(custom.url, 'https://demo.test/1/boards/x1/cards');
  assert.equal(fillPathParams(ACTION, { boardId: 'b2' }).url, 'https://demo.test/1/boards/b2/cards');
});

test('fillPathParams refuses dot segments, which a URL parser would resolve out of the path', () => {
  for (const dots of ['.', '..']) {
    assert.throws(() => fillPathParams(ACTION, { boardId: dots }), /boardId.*"\." and "\.\." are not path segments/);
  }
  for (const ok of ['...', 'a..b', '.hidden']) {
    assert.equal(new URL(fillPathParams(ACTION, { boardId: ok }).url).pathname, `/1/boards/${ok}/cards`);
  }
});

test('actionUrl keeps path params out of the query, applies defaults, and drops blanks and undeclared keys', () => {
  assert.equal(
    actionUrl(ACTION, { boardId: 'b 1', extra: 'x' }),
    'https://demo.test/1/boards/b%201/cards?limit=100',
  );
  assert.equal(actionUrl(ACTION, { boardId: 'b1', limit: '' }), 'https://demo.test/1/boards/b1/cards');
  assert.throws(() => actionUrl(ACTION, {}), /boardId/);
});
