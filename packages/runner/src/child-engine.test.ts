// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ChildEngine tests (§S1). Driven by a FAKE child (a `node -e` script that emits
 * canned NDJSON on fd 3), so the parent-side protocol, capture routing, and —
 * the point of the whole feature — crash handling are tested without mockttp.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capture, EngineStatus } from '@sluice/core';
import { ChildEngine } from './child-engine.js';

// Emits: starting → started(port 12345) → one capture, then waits on stdin for
// {t:'stop'}. With FAKE_CRASH=1 it instead exits(7) shortly after starting.
const FAKE = `
const { writeSync } = require('node:fs');
const emit = (f) => writeSync(3, JSON.stringify(f) + '\\n');
emit({ t: 'status', status: { engine: 'mitm', state: 'starting' } });
emit({ t: 'started', port: 12345, caPath: '/tmp/ca.pem' });
emit({ t: 'capture', capture: { id: 'cap-1', method: 'GET', host: 'x', path: '/', status: 200 } });
if (process.env.FAKE_CRASH === '1') { setTimeout(() => process.exit(7), 80); }
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  try { if (JSON.parse(l).t === 'stop') { process.exit(0); } } catch {}
});
`;

function make(env: Record<string, string> = {}): {
  engine: ChildEngine;
  captures: Capture[];
  statuses: EngineStatus[];
  errors: unknown[];
} {
  const captures: Capture[] = [];
  const statuses: EngineStatus[] = [];
  const errors: unknown[] = [];
  const engine = new ChildEngine({
    command: process.execPath,
    args: ['-e', FAKE],
    env,
    onCapture: (c) => captures.push(c),
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
  });
  return { engine, captures, statuses, errors };
}

test('start resolves on the started frame and routes captures', async () => {
  const { engine, captures } = make();
  const { port, caPath } = await engine.start();
  assert.equal(port, 12345);
  assert.equal(caPath, '/tmp/ca.pem');
  assert.equal(engine.status().state, 'running');
  assert.equal(engine.status().proxyPort, 12345);
  // Give the capture frame a beat to arrive after the started frame.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(captures.length, 1);
  assert.equal(captures[0]?.id, 'cap-1');
  await engine.stop();
});

test('an unexpected exit keeps status running so the supervisor restarts it', async () => {
  const { engine, errors } = make({ FAKE_CRASH: '1' });
  await engine.start();
  assert.equal(engine.status().state, 'running');
  // Wait past the fake's exit(7).
  await new Promise((r) => setTimeout(r, 250));
  // Status stays running (stale) — the supervisor's port probe drives recovery;
  // flipping to 'error' here would make it skip the restart.
  assert.equal(engine.status().state, 'running');
  assert.ok(errors.length >= 1, 'the crash is surfaced via onError');
  await engine.stop();
});

test('stop reports stopped and is safe to call twice', async () => {
  const { engine } = make();
  await engine.start();
  await engine.stop();
  assert.equal(engine.status().state, 'stopped');
  await engine.stop(); // no throw on an already-stopped engine
  assert.equal(engine.status().state, 'stopped');
});
