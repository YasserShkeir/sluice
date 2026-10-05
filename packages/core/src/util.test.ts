// SPDX-License-Identifier: Apache-2.0
/**
 * Operation-name tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The property that matters: every call to the same endpoint must collapse to
 * the SAME string, and two different endpoints must not. The traffic table
 * groups on this, so over-eager id detection silently merges unrelated rows and
 * under-eager detection explodes one endpoint into thousands.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  errorMessage,
  headerValue,
  operationName,
  resolveJsonPath,
  safeJsonObject,
  safeJsonParse,
  splitUrl,
} from './util.js';

test('RPC-style paths keep their method name', () => {
  assert.equal(operationName('/api/conversations.history'), 'conversations.history');
  assert.equal(operationName('/api/users.list'), 'users.list');
});

test('REST-style paths collapse their ids', () => {
  assert.equal(operationName('/1/boards/0000000000000000000000a1/cards'), 'boards/:id/cards');
  assert.equal(operationName('/1/members/me/cards'), 'members/me/cards');
});

test('two calls to the same endpoint produce the same operation', () => {
  assert.equal(
    operationName('/1/boards/0000000000000000000000a1/cards'),
    operationName('/1/boards/0000000000000000000000b2/cards'),
  );
});

test('two different endpoints do NOT collapse together', () => {
  assert.notEqual(operationName('/api/users.list'), operationName('/api/users.info'));
  assert.notEqual(operationName('/1/boards/abc123def456/cards'), operationName('/1/boards/abc123def456/lists'));
});

test('version and api prefixes are dropped, but never the last segment', () => {
  assert.equal(operationName('/v2/teams'), 'teams');
  assert.equal(operationName('/api/v1/messages'), 'messages');
  assert.equal(operationName('/api'), 'api', 'the only segment must survive');
  assert.equal(operationName('/'), '/');
  assert.equal(operationName(''), '/');
});

test('numeric, uuid and long opaque segments read as ids', () => {
  assert.equal(operationName('/users/12345/posts'), 'users/:id/posts');
  assert.equal(operationName('/x/550e8400-e29b-41d4-a716-446655440000/y'), 'x/:id/y');
  assert.equal(operationName('/files/T02ABCDEFGH/download'), 'files/:id/download');
});

test('Trello-style 8-char shortLinks collapse to :id', () => {
  assert.equal(operationName('/1/card/AAAA1111'), 'card/:id');
  assert.equal(operationName('/1/board/aB3dE5gH'), 'board/:id');
  assert.equal(
    operationName('/1/card/AAAA1111'),
    operationName('/1/card/BBBB2222'),
  );
});

test('ordinary words are not mistaken for ids', () => {
  // Merging two real operations into one row is worse than leaving an id in a
  // name, so the id test stays conservative about short lowercase words.
  assert.equal(operationName('/api/conversations/history'), 'conversations/history');
  assert.equal(operationName('/search/messages'), 'search/messages');
  assert.equal(operationName('/1/members/me/boards'), 'members/me/boards');
});

test('splitUrl tolerates input that is not a URL', () => {
  assert.deepEqual(splitUrl('https://slack.com/api/x?y=1'), { host: 'slack.com', path: '/api/x' });
  assert.deepEqual(splitUrl('not a url'), { host: '', path: 'not a url' });
});

test('errorMessage reads an Error and stringifies anything else', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(42), '42');
  assert.equal(errorMessage({ a: 1 }), '[object Object]');
});

test('headerValue is case-insensitive, first match wins, and ignores non-strings', () => {
  assert.equal(headerValue({ 'Content-Type': 'text/html' }, 'content-type'), 'text/html');
  assert.equal(headerValue(undefined, 'x'), undefined);
  assert.equal(headerValue({ a: '1' }, 'b'), undefined);
  assert.equal(headerValue({ x: 7 } as unknown as Record<string, string>, 'x'), undefined);
  assert.equal(headerValue({ 'X-A': 'first', 'x-a': 'second' }, 'x-a'), 'first');
});

test('safeJsonParse never throws and returns undefined for no JSON', () => {
  assert.equal(safeJsonParse(null), undefined);
  assert.equal(safeJsonParse(undefined), undefined);
  assert.equal(safeJsonParse(''), undefined);
  assert.equal(safeJsonParse('garbage'), undefined);
  assert.equal(safeJsonParse('0'), 0);
  assert.deepEqual(safeJsonParse('[1]'), [1]);
  for (const t of ['[1]', 'null', '0', 'garbage', '']) assert.equal(safeJsonObject(t), undefined, t);
  assert.deepEqual(safeJsonObject('{"a":1}'), { a: 1 });
});

test('resolveJsonPath walks flow-learn bind paths to a primitive leaf', () => {
  const data = { a: [{ b: 'x' }], channel: { id: 'C1' }, members: [{ id: 'U1' }, { id: 'U2' }], n: 1, t: true, o: { k: 1 }, z: null };
  assert.equal(resolveJsonPath('root', '$'), 'root');
  assert.equal(resolveJsonPath(42, ''), '42');
  assert.equal(resolveJsonPath(data, 'a[0].b'), 'x');
  assert.equal(resolveJsonPath(data, 'channel.id'), 'C1');
  assert.equal(resolveJsonPath(data, 'members[1].id'), 'U2');
  assert.equal(resolveJsonPath(data, 'channel[0]'), undefined, 'an index on a non-array');
  assert.equal(resolveJsonPath(data, 'n'), '1');
  assert.equal(resolveJsonPath(data, 't'), 'true');
  assert.equal(resolveJsonPath(data, 'o'), undefined, 'an object leaf');
  assert.equal(resolveJsonPath(data, 'a'), undefined, 'an array leaf');
  assert.equal(resolveJsonPath(data, 'z.k'), undefined, 'a null in the middle');
  assert.equal(resolveJsonPath(data, 'missing'), undefined);
});
