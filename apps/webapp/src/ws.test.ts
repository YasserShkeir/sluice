// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The store's pure helpers. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { RedactedSession } from '@sluice/core';
import { captureToggleAction, foldSession } from './ws.js';

test('the Record button asks for what it shows, not the inverse of local state', () => {
  // Paused on the runner (another tab, the CLI) while this view still records:
  // the button reads "Record", so a click must resume — it used to send pause.
  assert.equal(captureToggleAction(true, true), 'resume');
  assert.equal(captureToggleAction(true, false), 'pause');
  assert.equal(captureToggleAction(false, false), 'resume');
  assert.equal(captureToggleAction(false, true), 'resume');
});

const session = (id: string, label: string): RedactedSession => ({
  id,
  adapterId: 'app',
  label,
  source: 'local-store',
  discoveredAt: 0,
  credentialKinds: ['cookie'],
});

test('a re-announced session replaces its row in place; a new one is appended', () => {
  let list: RedactedSession[] = [];
  list = foldSession(list, session('a', 'A'));
  list = foldSession(list, session('b', 'B'));
  list = foldSession(list, session('a', 'A2'));
  assert.deepEqual(
    list.map((s) => `${s.id}:${s.label}`),
    ['a:A2', 'b:B'],
  );
});
