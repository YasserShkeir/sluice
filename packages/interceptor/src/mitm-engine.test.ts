// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TLS-scoping helpers for Engine A. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * `tlsInterceptList` builds the host patterns used when intercept is scoped.
 * Default product behaviour is all-hosts (MitmEngine omits tlsInterceptOnly);
 * these tests lock the list shape when scoping is on.
 *
 * The patterns are handed to mockttp, which compiles them with URLPattern, so
 * the semantics asserted below (a bare host does NOT match its own subdomains)
 * are URLPattern's, not ours.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Adapter } from '@sluice/core';
import { MitmEngine, tlsInterceptList } from './mitm-engine.js';

function adapter(id: string, hosts: string[]): Adapter {
  return {
    id,
    displayName: id,
    hosts,
    matchRequest: () => false,
    parse: () => ({}),
    listReplayActions: () => [],
    buildReplayRequest: () => ({ method: 'GET', url: '', headers: {} }),
  };
}

const hostnames = (a: Adapter[], extra: string[] = []): string[] =>
  tlsInterceptList(a, extra).map((h) => h.hostname);

test('every adapter host contributes both the bare host and its subdomains', () => {
  const list = hostnames([adapter('slack', ['slack.com', 'edgeapi.slack.com'])]);
  assert.deepEqual(list, ['*.edgeapi.slack.com', '*.slack.com', 'edgeapi.slack.com', 'slack.com']);
});

test('a host no adapter declared is absent from the scoped list', () => {
  const list = hostnames([adapter('slack', ['slack.com'])]);
  assert.ok(!list.some((h) => h.includes('bank')));
  assert.ok(!list.includes('*'));
});

test('--host widens the scoped list without needing an adapter', () => {
  const list = hostnames([adapter('slack', ['slack.com'])], ['app.notion.so']);
  assert.ok(list.includes('app.notion.so'));
  assert.ok(list.includes('*.app.notion.so'));
});

test('a caller-written wildcard is passed through as given, not re-wrapped', () => {
  const list = hostnames([], ['*.notion.so']);
  assert.deepEqual(list, ['*.notion.so']);
});

test('hosts are normalised and de-duplicated across adapters', () => {
  const list = hostnames([adapter('a', ['Slack.com', ' slack.com ']), adapter('b', ['slack.com'])]);
  assert.deepEqual(list, ['*.slack.com', 'slack.com']);
});

test('no adapters and no extra hosts yields an empty scoped list (intercept nothing when scoped)', () => {
  // mockttp distinguishes the option being absent (no restriction) from an empty
  // array (nothing matches). Returning [] here is what makes "zero adapters"
  // capture nothing instead of everything when interceptAllHosts is false;
  // MitmEngine.start omits the option entirely when all-hosts is on (default).
  assert.deepEqual(tlsInterceptList([], []), []);
});

test('blank host entries are dropped rather than becoming a match-all', () => {
  assert.deepEqual(hostnames([adapter('a', ['', '   '])], ['']), []);
});

test('MitmEngine defaults to all-hosts (interceptedHosts is undefined)', () => {
  const engine = new MitmEngine({
    port: 0,
    adapters: [adapter('slack', ['slack.com'])],
    onCapture: () => {},
  });
  assert.equal(engine.interceptedHosts(), undefined);
});

test('MitmEngine with interceptAllHosts false returns the scoped list', () => {
  const engine = new MitmEngine({
    port: 0,
    adapters: [adapter('slack', ['slack.com'])],
    onCapture: () => {},
    interceptAllHosts: false,
  });
  assert.deepEqual(engine.interceptedHosts(), ['*.slack.com', 'slack.com']);
});
