// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Auth-flow mapping tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The property that matters: the analysis must be driven by evidence across
 * captures (who minted a credential, and whether anything later used it) rather
 * than by guessing from endpoint names.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capture } from '@sluice/core';
import { mapAuthFlow } from './auth-flow.js';

let seq = 0;
function capture(over: Partial<Capture> = {}): Capture {
  seq += 1;
  return {
    id: `c${seq}`,
    ts: 1_700_000_000_000 + seq,
    source: 'mitm',
    adapterId: 'demo',
    method: 'GET',
    url: 'https://demo.test/x',
    host: 'demo.test',
    path: '/x',
    status: 200,
    durationMs: 5,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: null,
    ...over,
  };
}

test('an endpoint that mints a cookie later used by traffic is an issuer', () => {
  const flow = mapAuthFlow([
    capture({ method: 'POST', path: '/login', resHeaders: { 'set-cookie': 'sid=abcdef123456; Path=/; HttpOnly' } }),
    capture({ path: '/api/a', reqHeaders: { cookie: 'sid=abcdef123456' } }),
    capture({ path: '/api/b', reqHeaders: { cookie: 'sid=abcdef123456' } }),
  ]);
  const issuer = flow.issuers[0];
  assert.ok(issuer);
  assert.equal(issuer.path, '/login');
  assert.ok(issuer.mints.includes('sid'));
  assert.equal(issuer.dependentRequests, 2, 'two later requests depend on it');
  assert.equal(issuer.role, 'login', 'issued once → a login');
});

test('an endpoint that re-issues the same credential repeatedly is a refresh', () => {
  // This is the distinction the per-capture scanner structurally cannot make:
  // nothing in a single capture says whether an endpoint recurs.
  const flow = mapAuthFlow([
    capture({ method: 'POST', path: '/session', resHeaders: { 'set-cookie': 'sid=v1abcdef1234' } }),
    capture({ path: '/api/a', reqHeaders: { cookie: 'sid=v1abcdef1234' } }),
    capture({ method: 'POST', path: '/session', resHeaders: { 'set-cookie': 'sid=v2abcdef1234' } }),
    capture({ path: '/api/b', reqHeaders: { cookie: 'sid=v2abcdef1234' } }),
  ]);
  const issuer = flow.issuers.find((i) => i.path === '/session');
  assert.equal(issuer?.role, 'refresh');
  assert.equal(issuer?.observations, 2);
});

test('a credential nothing ever uses is reported as unused, not as auth', () => {
  const flow = mapAuthFlow([
    capture({ path: '/track', resHeaders: { 'set-cookie': 'visitor=zzzz99998888' } }),
    capture({ path: '/api/a' }),
  ]);
  assert.equal(flow.issuers.find((i) => i.path === '/track')?.role, 'issues-unused');
});

test('analytics cookies are not reported as credential issuers', () => {
  const flow = mapAuthFlow([
    capture({ path: '/page', resHeaders: { 'set-cookie': '_ga=GA1.2.99; _gid=GA1.2.88' } }),
  ]);
  assert.equal(flow.issuers.length, 0);
});

test('a token in a JSON body counts as minted', () => {
  const flow = mapAuthFlow([
    capture({
      method: 'POST',
      path: '/oauth/token',
      resBody: JSON.stringify({ access_token: 'aaaaaaaaaaaaaaaa', expires_in: 3600 }),
    }),
    capture({ path: '/api/a', reqHeaders: { authorization: 'Bearer aaaaaaaaaaaaaaaa' } }),
  ]);
  const issuer = flow.issuers.find((i) => i.path === '/oauth/token');
  assert.ok(issuer, 'a token-bearing JSON response is an issuer');
  assert.ok(issuer.mints.includes('access_token'));
});

test('a credential used but never observed being issued is flagged', () => {
  // The common real case: capture started after login, so the session cookie has
  // no visible origin. Saying so is more useful than silently omitting it.
  const flow = mapAuthFlow([capture({ path: '/api/a', reqHeaders: { cookie: 'sid=preexisting123' } })]);
  assert.deepEqual(flow.unexplainedCredentials, ['sid']);
});

test('a redacted Set-Cookie still identifies the endpoint as an issuer', () => {
  // Captures are redacted before they are stored, so this is the NORMAL case —
  // the analysis has to work without ever seeing a secret.
  const flow = mapAuthFlow([
    capture({ method: 'POST', path: '/login', resHeaders: { 'set-cookie': '«redacted»' } }),
    capture({ path: '/api/a', reqHeaders: { cookie: '«redacted»' } }),
  ]);
  const issuer = flow.issuers.find((i) => i.path === '/login');
  assert.ok(issuer, 'presence is still evidence even when the value is masked');
  assert.ok(issuer.dependentRequests > 0);
});

test('no secret value is ever emitted', () => {
  const flow = mapAuthFlow([
    capture({ method: 'POST', path: '/login', resHeaders: { 'set-cookie': 'sid=SUPERSECRETVALUE123' } }),
    capture({ path: '/api/a', reqHeaders: { cookie: 'sid=SUPERSECRETVALUE123' } }),
  ]);
  assert.ok(!JSON.stringify(flow).includes('SUPERSECRETVALUE123'), 'only redacted previews may leave');
});

test('scoping to an adapter ignores other apps traffic', () => {
  const flow = mapAuthFlow(
    [
      capture({ adapterId: 'demo', method: 'POST', path: '/login', resHeaders: { 'set-cookie': 'sid=aaaa11112222' } }),
      capture({ adapterId: 'other', method: 'POST', path: '/signin', resHeaders: { 'set-cookie': 'oid=bbbb33334444' } }),
    ],
    'demo',
  );
  assert.equal(flow.issuers.length, 1);
  assert.equal(flow.issuers[0]?.path, '/login');
});
