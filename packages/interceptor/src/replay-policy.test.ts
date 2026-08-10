// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Replay safety-rail tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The property under test is the one that keeps Sluice a read-only tool: it can
 * observe your session but must not act as you. These rails sit below every
 * caller, so this suite is what stops a future refactor from quietly
 * re-opening the write path.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import type { ReplayRequest } from '@sluice/core';
import { assertReplayAllowed, replayBudget, ReplayDeniedError, withReplaySlot } from './replay-policy.js';

afterEach(() => replayBudget.reset());

function req(over: Partial<ReplayRequest> = {}): ReplayRequest {
  return {
    method: 'POST',
    url: 'https://slack.com/api/conversations.list',
    headers: {},
    ...over,
  };
}

test('ordinary read operations are allowed', () => {
  assert.doesNotThrow(() => assertReplayAllowed(req()));
  assert.doesNotThrow(() => assertReplayAllowed(req({ method: 'GET', url: 'https://trello.com/1/members/me/cards' })));
});

test('mutating verbs are refused', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.throws(
      () => assertReplayAllowed(req({ method })),
      (e: unknown) => e instanceof ReplayDeniedError && e.code === 'method_not_allowed',
      `${method} must be refused`,
    );
  }
});

test('write and admin operations are refused even over an allowed verb', () => {
  // Slack POSTs for ordinary reads, so the verb alone proves nothing — this is
  // why the operation denylist exists.
  const denied = [
    'https://slack.com/api/chat.postMessage',
    'https://slack.com/api/chat.delete',
    'https://slack.com/api/admin.users.session.reset',
    'https://slack.com/api/conversations.invite',
    'https://slack.com/api/conversations.archive',
    'https://slack.com/api/files.upload',
    'https://slack.com/api/reactions.add',
    'https://slack.com/api/auth.revoke',
  ];
  for (const url of denied) {
    assert.throws(
      () => assertReplayAllowed(req({ url })),
      (e: unknown) => e instanceof ReplayDeniedError && e.code === 'operation_not_allowed',
      `${url} must be refused`,
    );
  }
});

test('a write operation hidden in the body is still refused', () => {
  assert.throws(
    () => assertReplayAllowed(req({ url: 'https://example.com/rpc', body: 'method=chat.postMessage&text=hi' })),
    (e: unknown) => e instanceof ReplayDeniedError && e.code === 'operation_not_allowed',
  );
});

test('the rate budget eventually refuses', () => {
  replayBudget.configure({ capacity: 3, refillMs: 60_000 });
  for (let i = 0; i < 3; i++) replayBudget.take();
  assert.throws(
    () => replayBudget.take(),
    (e: unknown) => e instanceof ReplayDeniedError && e.code === 'rate_budget_exhausted',
  );
});

test('withReplaySlot serialises work and survives a rejection', async () => {
  const order: string[] = [];
  const slow = withReplaySlot(async () => {
    order.push('a:start');
    await new Promise((r) => setTimeout(r, 20));
    order.push('a:end');
  });
  const next = withReplaySlot(async () => {
    order.push('b');
  });
  await Promise.all([slow, next]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b'], 'the second call must wait for the first');

  // A failure must not wedge the chain for everyone after it.
  await assert.rejects(withReplaySlot(async () => {
    throw new Error('boom');
  }));
  assert.equal(await withReplaySlot(async () => 'ok'), 'ok');
});
