// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { looksLikeDeniedOperation } from './replay-deny.js';

test('looksLikeDeniedOperation catches Slack write ops', () => {
  assert.equal(looksLikeDeniedOperation('chat.postMessage'), true);
  assert.equal(looksLikeDeniedOperation('/api/chat.postMessage'), true);
  assert.equal(looksLikeDeniedOperation('method=chat.postMessage&text=hi'), true);
  assert.equal(looksLikeDeniedOperation('conversations.history'), false);
  assert.equal(looksLikeDeniedOperation('/api/conversations.history'), false);
});

test('looksLikeDeniedOperation catches Trello write-shaped tokens', () => {
  assert.equal(looksLikeDeniedOperation('cards.create'), true);
  assert.equal(looksLikeDeniedOperation('boards.create'), true);
  assert.equal(looksLikeDeniedOperation('cards/:id'), false);
  assert.equal(looksLikeDeniedOperation('/1/cards/abc12345'), false);
  assert.equal(looksLikeDeniedOperation('/1/members/me/cards'), false);
});

test('looksLikeDeniedOperation ignores empty haystacks', () => {
  assert.equal(looksLikeDeniedOperation(undefined, null, ''), false);
});

test('looksLikeDeniedOperation catches GraphQL mutations', () => {
  assert.equal(looksLikeDeniedOperation('mutation { updateCard(id: "x") { id } }'), true);
  assert.equal(looksLikeDeniedOperation('query=mutation%20{'), true);
  assert.equal(looksLikeDeniedOperation('query { card(id: "x") { name } }'), false);
});

