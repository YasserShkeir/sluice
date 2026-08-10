// SPDX-License-Identifier: Apache-2.0
/**
 * Auth-failure classification. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * This predicate decides whether Sluice re-reads your credential — which means
 * re-entering the OS consent boundary and possibly raising a Keychain prompt. So
 * both directions of error are expensive, and both are pinned here:
 *
 *   too narrow → a long-running workflow dies on a cookie that could have been
 *                re-read in a millisecond (the whole point of D1)
 *   too broad  → a Keychain prompt every time you touch a private channel
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { authFailureReason, isAuthFailure } from './auth-failure.js';

const cap = (status: number | null, resBody: string | null = null) => ({ status, resBody });

test('401 is an auth failure', () => {
  assert.equal(isAuthFailure(cap(401)), true);
});

test('403 is NOT — it means authenticated and not allowed', () => {
  // A fresh copy of the same session changes nothing about permission, so
  // retrying costs a Keychain prompt and gets the identical answer.
  assert.equal(isAuthFailure(cap(403)), false);
});

test("Slack's HTTP 200 expiry is caught — the case a status-only check misses", () => {
  // Slack answers an expired session with 200 and {ok:false,error:"not_authed"}.
  // Slack also has the most session churn, so a 401-only check would make this
  // feature look finished while the app that motivated it stayed broken.
  assert.equal(isAuthFailure(cap(200, '{"ok":false,"error":"not_authed"}')), true);
  assert.equal(isAuthFailure(cap(200, '{"ok":false,"error":"invalid_auth"}')), true);
  assert.equal(isAuthFailure(cap(200, '{"ok":false,"error":"token_revoked"}')), true);
  assert.equal(isAuthFailure(cap(200, '{"ok":false,"error":"account_inactive"}')), true);
});

test('a Slack failure that re-extracting cannot fix is NOT an auth failure', () => {
  for (const code of ['not_in_channel', 'channel_not_found', 'missing_scope', 'ratelimited', 'is_archived']) {
    assert.equal(
      isAuthFailure(cap(200, `{"ok":false,"error":"${code}"}`)),
      false,
      `${code} must not trigger a credential re-read`,
    );
  }
});

test('a successful response is never an auth failure', () => {
  assert.equal(isAuthFailure(cap(200, '{"ok":true}')), false);
  assert.equal(isAuthFailure(cap(200, '{"ok":true,"error":"ignored"}')), false, 'ok:true wins over a stray error key');
  assert.equal(isAuthFailure(cap(204)), false);
});

test('server errors are not auth failures', () => {
  // Retrying a 500 with a fresh cookie just spends the replay budget twice.
  for (const s of [500, 502, 503, 429]) assert.equal(isAuthFailure(cap(s)), false);
});

test('classification never throws on a body that is not JSON', () => {
  for (const body of [null, '', '{', '<html>502</html>', '[1,2,3]', 'null', '"str"', '{"ok":']) {
    assert.doesNotThrow(() => isAuthFailure(cap(200, body)), `threw on ${JSON.stringify(body)}`);
    assert.equal(isAuthFailure(cap(200, body)), false);
  }
});

test('the reason names the service code when there is one', () => {
  assert.equal(authFailureReason(cap(200, '{"ok":false,"error":"not_authed"}')), 'not_authed');
  assert.equal(authFailureReason(cap(401)), 'HTTP 401');
});
