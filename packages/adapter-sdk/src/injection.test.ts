// SPDX-License-Identifier: Apache-2.0
/** The NAME → values-KEY injection contract. Every value is a placeholder. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CredentialInjection, Session } from '@sluice/core';
import { injectedCookieHeader, injectedHeaders, injectedQuery } from './injection.js';

function session(values: Record<string, string>, injection: CredentialInjection): Session {
  return {
    id: 'sess_1',
    adapterId: 'demo',
    label: 'Demo',
    credentials: { kind: 'demo-session', values, injection },
    discoveredAt: 0,
    source: 'manual',
  };
}

const S = session(
  { hdr: 'HDR-VALUE', q: 'Q-VALUE', sid: 'SID-VALUE', empty: '' },
  {
    headers: { 'x-extra': 'hdr', 'x-literal': 'LITERAL-VALUE', 'x-empty': 'empty' },
    query: { team: 'q' },
    cookies: { SID: 'sid', PREF: 'LITERAL-PREF', GONE: 'empty' },
  },
);

test('a ref that names a values key resolves to its value, never to the key', () => {
  assert.equal(injectedHeaders(S)['x-extra'], 'HDR-VALUE');
  assert.deepEqual(injectedQuery(S), { team: 'Q-VALUE' });
  assert.ok(!Object.values(injectedHeaders(S)).includes('hdr'));
});

test('a ref that is not a values key is sent as a literal', () => {
  assert.equal(injectedHeaders(S)['x-literal'], 'LITERAL-VALUE');
  const lit = session({}, { headers: { 'x-a': 'constructor' } });
  assert.deepEqual(injectedHeaders(lit), { 'x-a': 'constructor' }, 'own keys only, never a prototype member');
});

test('an empty value is skipped rather than sent as an empty header or cookie', () => {
  assert.ok(!('x-empty' in injectedHeaders(S)));
  assert.equal(injectedCookieHeader(S), 'SID=SID-VALUE; PREF=LITERAL-PREF');
});

test('no cookies, or none that resolve, is undefined so a caller can fall back', () => {
  assert.equal(injectedCookieHeader(session({ a: '1' }, {})), undefined);
  assert.equal(injectedCookieHeader(session({ e: '' }, { cookies: { X: 'e' } })), undefined);
  assert.deepEqual(injectedHeaders(session({}, {})), {});
  assert.deepEqual(injectedQuery(session({}, {})), {});
});
