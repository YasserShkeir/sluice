// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInterceptScope } from './config.js';

test('resolveInterceptScope defaults to all hosts when nothing is set', () => {
  const s = resolveInterceptScope({ config: {} });
  assert.deepEqual(s, { interceptHosts: [], interceptAllHosts: true });
});

test('resolveInterceptScope scopes when --host is passed', () => {
  const s = resolveInterceptScope({ config: {}, cliHosts: ['linkedin.com'] });
  assert.equal(s.interceptAllHosts, false);
  assert.deepEqual(s.interceptHosts, ['linkedin.com']);
});

test('resolveInterceptScope scopes when config.interceptHosts is set', () => {
  const s = resolveInterceptScope({ config: { interceptHosts: ['*.example.com'] } });
  assert.equal(s.interceptAllHosts, false);
  assert.deepEqual(s.interceptHosts, ['*.example.com']);
});

test('resolveInterceptScope merges config hosts with CLI hosts', () => {
  const s = resolveInterceptScope({
    config: { interceptHosts: ['a.com'] },
    cliHosts: ['b.com'],
  });
  assert.equal(s.interceptAllHosts, false);
  assert.deepEqual(s.interceptHosts, ['a.com', 'b.com']);
});

test('resolveInterceptScope respects interceptAllHosts: false with empty hosts', () => {
  const s = resolveInterceptScope({ config: { interceptAllHosts: false } });
  assert.deepEqual(s, { interceptHosts: [], interceptAllHosts: false });
});

test('resolveInterceptScope --all-hosts wins over a host list', () => {
  const s = resolveInterceptScope({
    config: { interceptHosts: ['only.this'] },
    cliHosts: ['also.this'],
    cliAllHosts: true,
  });
  assert.equal(s.interceptAllHosts, true);
  assert.deepEqual(s.interceptHosts, ['only.this', 'also.this']);
});

test('resolveInterceptScope config interceptAllHosts: true wins over host list', () => {
  const s = resolveInterceptScope({
    config: { interceptHosts: ['x.com'], interceptAllHosts: true },
  });
  assert.equal(s.interceptAllHosts, true);
});
