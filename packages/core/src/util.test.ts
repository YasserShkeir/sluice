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
import { operationName, splitUrl } from './util.js';

test('RPC-style paths keep their method name', () => {
  assert.equal(operationName('/api/conversations.history'), 'conversations.history');
  assert.equal(operationName('/api/users.list'), 'users.list');
});

test('REST-style paths collapse their ids', () => {
  assert.equal(operationName('/1/boards/5f3a91c8e4b0a2d1f9c37e5b/cards'), 'boards/:id/cards');
  assert.equal(operationName('/1/members/me/cards'), 'members/me/cards');
});

test('two calls to the same endpoint produce the same operation', () => {
  assert.equal(
    operationName('/1/boards/5f3a91c8e4b0a2d1f9c37e5b/cards'),
    operationName('/1/boards/60b2e4d7a1c9f30e82b45a16/cards'),
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
  assert.equal(operationName('/1/card/6uQ2uchS'), 'card/:id');
  assert.equal(operationName('/1/board/tTcMzr1z'), 'board/:id');
  assert.equal(
    operationName('/1/card/6uQ2uchS'),
    operationName('/1/card/tS5EG1UG'),
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
