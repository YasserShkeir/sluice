// SPDX-License-Identifier: Apache-2.0
/**
 * replayAttempt and withCookieRefresh, against a fake host context — no network.
 * Cookie strings are placeholders.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppToolContext, Capture, ReplayRequest } from '@sluice/core';
import { makeCapture } from './fixtures.js';
import { replayAttempt, requireReplay, withCookieRefresh } from './live-request.js';
import type { LiveAttempt } from './live-request.js';

const REQ: ReplayRequest = { method: 'GET', url: 'https://example.com/api/x', headers: {} };

function ctxAnswering(capture: Partial<Capture>, seen: ReplayRequest[] = []): AppToolContext {
  return {
    replay: async (req) => {
      seen.push(req);
      return makeCapture(capture);
    },
  };
}

test('replayAttempt goes through ctx.replay and reports the answer', async () => {
  const seen: ReplayRequest[] = [];
  const ok = await replayAttempt(REQ, ctxAnswering({ status: 200, resBody: '{"a":1}' }, seen));
  assert.deepEqual(ok, { status: 200, body: '{"a":1}', authFailed: false });
  assert.deepEqual(seen, [REQ], 'the request reaches the host unchanged');
});

test('replayAttempt flags a 401 and a 2xx expired-session body as auth failures', async () => {
  const denied = await replayAttempt(REQ, ctxAnswering({ status: 401, resBody: '' }));
  assert.equal(denied.authFailed, true);
  const slack = await replayAttempt(REQ, ctxAnswering({ status: 200, resBody: '{"ok":false,"error":"invalid_auth"}' }));
  assert.equal(slack.authFailed, true);
  const forbidden = await replayAttempt(REQ, ctxAnswering({ status: 403, resBody: '' }));
  assert.equal(forbidden.authFailed, false, 'a 403 is not an expired session');
});

test('replayAttempt without a host context refuses rather than fetching around the rails', async () => {
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error('unreachable');
  }) as typeof fetch;
  try {
    await assert.rejects(replayAttempt(REQ, undefined), /replay pipeline/);
    await assert.rejects(replayAttempt(REQ, {} as AppToolContext), /sluice-mcp/);
    assert.throws(() => requireReplay(undefined), /replay pipeline/);
    assert.equal(fetched, false, 'a bare fetch would send the session with no replay rails');
  } finally {
    globalThis.fetch = realFetch;
  }
});

const OK: LiveAttempt = { status: 200, body: 'ok', authFailed: false };
const EXPIRED: LiveAttempt = { status: 401, body: '', authFailed: true };

test('a first success sends once and never re-reads', async () => {
  const sent: string[] = [];
  let rereads = 0;
  const r = await withCookieRefresh(
    'COOKIE-ONE',
    async (c) => {
      sent.push(c);
      return OK;
    },
    () => {
      rereads++;
      return 'COOKIE-TWO';
    },
  );
  assert.deepEqual(r, { attempt: OK, refreshed: false });
  assert.deepEqual(sent, ['COOKIE-ONE']);
  assert.equal(rereads, 0);
});

test('a re-read that throws keeps the original auth failure', async () => {
  const r = await withCookieRefresh(
    'COOKIE-ONE',
    async () => EXPIRED,
    () => {
      throw new Error('database is locked');
    },
  );
  assert.deepEqual(r, { attempt: EXPIRED, refreshed: false });
});

test('an identical cookie is not re-sent', async () => {
  let sends = 0;
  const r = await withCookieRefresh(
    'COOKIE-ONE',
    async () => {
      sends++;
      return EXPIRED;
    },
    () => 'COOKIE-ONE',
  );
  assert.deepEqual(r, { attempt: EXPIRED, refreshed: false });
  assert.equal(sends, 1);
});

test('a fresh cookie is sent exactly once more, strictly after the first send settles', async () => {
  const events: string[] = [];
  const r = await withCookieRefresh(
    'COOKIE-ONE',
    async (c) => {
      events.push(`start ${c}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end ${c}`);
      return c === 'COOKIE-ONE' ? EXPIRED : OK;
    },
    () => 'COOKIE-TWO',
  );
  assert.deepEqual(r, { attempt: OK, refreshed: true });
  assert.deepEqual(events, ['start COOKIE-ONE', 'end COOKIE-ONE', 'start COOKIE-TWO', 'end COOKIE-TWO']);
});
