// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Replay header sanitisation. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * `runReplay` itself makes real outbound HTTPS, so it is not unit-tested here;
 * `sendableHeaders` is the pure boundary that is, because its failure mode is a
 * whole-replay crash, not a bad header.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sendableHeaders } from './replay.js';

test('a header undici would reject is dropped, at the boundary every replay crosses', () => {
  // undici throws "Cannot convert argument to a ByteString" out of the ENTIRE
  // fetch on a code unit > 255 — so one odd header must not fail the replay.
  // makeFaithful guards learned headers; this guards the adapter's own base
  // request and every other caller.
  const out = sendableHeaders({
    'user-agent': 'Mozilla/5.0 Chrome/141',
    Cookie: 'SID=abc',
    'x-weird': 'valu…e', // an ellipsis (U+2026) — > 255
  });
  assert.equal(out['user-agent'], 'Mozilla/5.0 Chrome/141', 'clean headers pass');
  assert.equal(out.Cookie, 'SID=abc', 'auth survives');
  assert.equal(out['x-weird'], undefined, 'the non-latin1 value is dropped, not fatal');
});

test('everything latin1 passes through unchanged', () => {
  const headers = { a: 'b', 'content-type': 'application/json', 'x-1': 'ÿ (U+00FF, still one byte)' };
  assert.deepEqual(sendableHeaders(headers), headers);
});

test('an empty header set is fine', () => {
  assert.deepEqual(sendableHeaders({}), {});
});
