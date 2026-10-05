// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Replay safety-rail tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The property under test is what keeps Sluice's replay path from issuing
 * requests that look like writes. The rails are heuristics, not a proof of
 * non-mutation, but they sit below every caller, so this suite is what stops a
 * future refactor from quietly re-opening a known write path.
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

test('the runtime rail closes the deny gaps the name-only check left open', () => {
  // Two of core's replay-deny.test.ts gap rows (percent-encoded name,
  // method-override header) through the runtime assert: core owns the full
  // table; these prove the whole request reaches it, so a refactor back to a
  // weaker name-only check here fails loudly.
  const gaps: Array<Partial<ReplayRequest>> = [
    { url: 'https://slack.com/api/chat%2EpostMessage', body: 'text=hi' },
    { url: 'https://api.example.test/items/1', body: 'x=1', headers: { 'X-HTTP-Method-Override': 'DELETE' } },
  ];
  for (const over of gaps) {
    assert.throws(
      () => assertReplayAllowed(req(over)),
      (e: unknown) => e instanceof ReplayDeniedError && e.code === 'operation_not_allowed',
      `${over.url} ${over.body ?? ''} must be refused`,
    );
  }
});

test('shipped reads over POST stay allowed, including a harmless GET override', () => {
  const reads: Array<Partial<ReplayRequest>> = [
    { url: 'https://slack.com/api/conversations.history', body: 'channel=C1&limit=100' },
    { url: 'https://slack.com/api/users.info', body: 'user=U1' },
    { url: 'https://app.notion.com/api/v3/loadPageChunk', body: '{"pageId":"p1","limit":100}' },
    { url: 'https://api.example.test/items', body: 'x=1', headers: { 'X-HTTP-Method-Override': 'GET' } },
  ];
  for (const over of reads) assert.doesNotThrow(() => assertReplayAllowed(req(over)), over.url);
});

test('denials do not claim the rails prove a request is read-only', () => {
  for (const over of [{ method: 'DELETE' }, { url: 'https://slack.com/api/chat.postMessage' }]) {
    assert.throws(
      () => assertReplayAllowed(req(over)),
      (e: unknown) => e instanceof ReplayDeniedError && !/reads only/i.test(e.message),
    );
  }
});

test('with allowedHosts, a host outside the app is refused', () => {
  const hosts = ['slack.com', '*.slack-edge.com'];
  assert.throws(
    () => assertReplayAllowed(req({ method: 'GET', url: 'https://evil.test/x' }), { allowedHosts: hosts }),
    (e: unknown) => e instanceof ReplayDeniedError && e.code === 'host_not_allowed',
  );
  assert.throws(
    () => assertReplayAllowed(req({ url: 'https://slack.com.evil.test/api/x' }), { allowedHosts: hosts }),
    (e: unknown) => e instanceof ReplayDeniedError && e.code === 'host_not_allowed',
    'a suffix trick is not a subdomain',
  );
  assert.throws(
    () => assertReplayAllowed(req(), { allowedHosts: [] }),
    (e: unknown) => e instanceof ReplayDeniedError && e.code === 'host_not_allowed',
    'an empty allowlist allows nothing',
  );
});

test('with allowedHosts, the app host and its subdomains pass; omitted skips the check', () => {
  const hosts = ['slack.com', '*.slack-edge.com'];
  assert.doesNotThrow(() => assertReplayAllowed(req({ method: 'GET', url: 'https://edgeapi.slack.com/x' }), { allowedHosts: hosts }));
  assert.doesNotThrow(() => assertReplayAllowed(req({ url: 'https://SLACK.com/api/conversations.list' }), { allowedHosts: hosts }));
  assert.doesNotThrow(() => assertReplayAllowed(req({ method: 'GET', url: 'https://a.slack-edge.com/x' }), { allowedHosts: hosts }));
  assert.doesNotThrow(() => assertReplayAllowed(req({ method: 'GET', url: 'https://evil.test/x' })));
});

test('the rate budget eventually refuses', () => {
  const { tokens } = replayBudget.snapshot();
  for (let i = 0; i < tokens; i++) replayBudget.take();
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
