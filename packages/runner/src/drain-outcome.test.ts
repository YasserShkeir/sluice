// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { apiErrorText, drainOutcome } from './drain-outcome.js';

test('a 429 is retried later, never settled as failed', () => {
  assert.deepEqual(drainOutcome({ status: 429, resBody: null }), { kind: 'retry-later' });
  // Even when the body also says ok:false — the status is what decides.
  assert.deepEqual(drainOutcome({ status: 429, resBody: '{"ok":false,"error":"ratelimited"}' }), {
    kind: 'retry-later',
  });
});

test('an app-level error in a 200 fails the item and names the error', () => {
  assert.deepEqual(drainOutcome({ status: 200, resBody: '{"ok":false,"error":"channel_not_found"}' }), {
    kind: 'failed',
    error: 'channel_not_found',
  });
  // No error string still fails: a 200 saying ok:false must never settle as done.
  assert.deepEqual(drainOutcome({ status: 200, resBody: '{"ok":false}' }), { kind: 'failed', error: 'error' });
});

test('an HTTP error with no body fails the item with its status', () => {
  assert.deepEqual(drainOutcome({ status: 500, resBody: null }), { kind: 'failed', error: 'HTTP 500' });
});

test('a successful response, JSON or not, is done', () => {
  assert.deepEqual(drainOutcome({ status: 200, resBody: '{"ok":true}' }), { kind: 'done' });
  assert.deepEqual(drainOutcome({ status: 200, resBody: '<html>not json</html>' }), { kind: 'done' });
});

test('apiErrorText reports what the scope check said was missing', () => {
  assert.equal(
    apiErrorText({ status: 200, resBody: '{"ok":false,"error":"missing_scope","needed":"channels:read"}' }),
    'missing_scope (needed: channels:read; provided: -)',
  );
});
