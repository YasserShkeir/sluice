// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pure display helpers. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureSize, formatBytes } from './format.js';

test('formatBytes steps units on 1024 boundaries', () => {
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1_500_000), '1.4 MB');
});

test('captureSize shows the response (else request) body at its full length', () => {
  assert.equal(captureSize({ reqBody: null, resBody: null }), '—');
  assert.equal(captureSize({ reqBody: 'abc', resBody: null }), formatBytes(3));
  assert.equal(captureSize({ reqBody: 'abc', resBody: 'x'.repeat(10) }), formatBytes(10));
  assert.equal(
    captureSize({ reqBody: null, resBody: 'x'.repeat(10), bodyLengths: { req: 0, res: 200 * 1024 } }),
    formatBytes(200 * 1024),
    'a preview reports the stored size',
  );
});
