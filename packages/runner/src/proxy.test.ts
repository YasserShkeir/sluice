// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The system-proxy guards. Pure logic, so no `networksetup` runs: `proxy on`
 * must never overwrite someone else's proxy, and `proxy off` must only clear
 * Sluice's own.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoForeignProxy, isOurProxy } from './proxy.js';

test('a disabled proxy is nobody’s and may be replaced', () => {
  const st = { enabled: false };
  assert.equal(isOurProxy(st, 8080), false);
  assert.doesNotThrow(() => assertNoForeignProxy(st, 8080));
});

test('a proxy on another host is foreign and is never replaced', () => {
  const st = { enabled: true, host: '10.0.0.1', port: 3128 };
  assert.equal(isOurProxy(st, 8080), false);
  assert.throws(() => assertNoForeignProxy(st, 8080), /already set → 10\.0\.0\.1:3128/);
});

test('loopback on another port is foreign too', () => {
  const st = { enabled: true, host: '127.0.0.1', port: 9999 };
  assert.equal(isOurProxy(st, 8080), false);
  assert.throws(() => assertNoForeignProxy(st, 8080));
});

test('loopback on our port is ours, by address or by name', () => {
  for (const host of ['127.0.0.1', 'localhost']) {
    const st = { enabled: true, host, port: 8080 };
    assert.equal(isOurProxy(st, 8080), true);
    assert.doesNotThrow(() => assertNoForeignProxy(st, 8080));
  }
});
