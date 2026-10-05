// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The debug Chrome's argv. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * No Chrome is spawned: the argv is the security-relevant part, and a pure
 * helper is what can be asserted without one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { debugChromeArgs } from './launch-chrome.js';

test('the debug Chrome never allows web origins onto its DevTools socket', () => {
  for (const headless of [false, true]) {
    const args = debugChromeArgs({ port: 9222, headless }, '/tmp/sluice-test-profile');
    assert.ok(!args.some((a) => a.startsWith('--remote-allow-origins')), args.join(' '));
  }
});

test('the argv carries the port, the dedicated profile and the start url last', () => {
  const args = debugChromeArgs({ port: 9333, startUrl: 'https://app.example.com/' }, '/tmp/p');
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.ok(args.includes('--user-data-dir=/tmp/p'));
  assert.ok(!args.includes('--headless=new'));
  assert.equal(args.at(-1), 'https://app.example.com/');
  assert.equal(debugChromeArgs({ port: 1 }, '/tmp/p').at(-1), 'about:blank');
});
