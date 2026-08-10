// SPDX-License-Identifier: Apache-2.0
/**
 * Protocol validation tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * Most of these are payloads the OLD check accepted. `isClientMsg` looked at
 * `type` and nothing else, so every one of them reached a handler — which is
 * why they are written out one by one rather than summarised as "rejects junk".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClientFrame, parseClientMsg } from './index.js';

/** The message, or a failure with the reason attached to the assertion. */
function accepted(raw: unknown) {
  const r = parseClientMsg(raw);
  assert.ok(r.ok, `expected accepted, got: ${r.ok ? '' : r.reason}`);
  return r.msg;
}

function rejected(raw: unknown): string {
  const r = parseClientMsg(raw);
  assert.ok(!r.ok, `expected rejected, got ${JSON.stringify(raw)}`);
  return r.reason;
}

// ── The shapes that must work ────────────────────────────────────────────────────

test('every client message the protocol defines round-trips', () => {
  const messages = [
    { type: 'hello.ok', protocolVersion: 1 },
    { type: 'subscribe' },
    { type: 'subscribe', sinceSeq: 42, filter: { adapterId: 'slack' } },
    { type: 'replay.run', requestId: 'r1', actionId: 'a1', params: {} },
    { type: 'replay.run', requestId: 'r1', actionId: 'a1', params: { x: 'y' }, sessionId: 's1' },
    { type: 'export' },
    { type: 'export', containerId: 'C1' },
    { type: 'sync' },
    { type: 'capture.control', action: 'pause' },
    { type: 'capture.control', action: 'resume' },
  ];
  for (const m of messages) assert.equal(accepted(m).type, m.type);
});

test('a filter with nothing in it is no filter', () => {
  // `filter` being SET is what the broadcast loop tests, once per frame per
  // subscriber. An empty object left set would make every subscriber take the
  // scoped path to conclude it was not scoped.
  const msg = accepted({ type: 'subscribe', filter: {} });
  assert.equal(msg.type === 'subscribe' ? msg.filter : 'wrong type', undefined);
});

// ── What the old check let through ───────────────────────────────────────────────

test('sinceSeq must be a sequence number, not something shaped like one', () => {
  // Each of these reached the ring lookup, missed, and produced a full re-prime
  // presented to the client as a resume.
  for (const sinceSeq of ['5', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
    assert.match(rejected({ type: 'subscribe', sinceSeq }), /sinceSeq/);
  }
});

test('a filter that is not an object is refused rather than ignored', () => {
  for (const filter of [7, 'slack', [], true]) {
    assert.match(rejected({ type: 'subscribe', filter }), /filter/);
  }
});

test('an unknown filter key is refused, not silently dropped', () => {
  // `.strict()`. A client scoping itself by a key the server does not implement
  // would otherwise be handed the UNSCOPED stream — every capture on the
  // machine — while believing it asked for one app's.
  assert.match(rejected({ type: 'subscribe', filter: { workspaceId: 'W1' } }), /workspaceId/);
});

test('replay params must be strings, because that is what a request is built from', () => {
  // These go straight to an adapter's `buildReplayRequest`, which interpolates
  // them into a URL or a body. No adapter is written against an object here.
  for (const params of [{ a: 1 }, { a: null }, { a: ['x'] }, { a: { b: 'c' } }, 'x', 5, null]) {
    assert.match(rejected({ type: 'replay.run', requestId: 'r', actionId: 'a', params }), /params/);
  }
});

test('replay.run without the fields it needs is refused', () => {
  assert.match(rejected({ type: 'replay.run', actionId: 'a', params: {} }), /requestId/);
  assert.match(rejected({ type: 'replay.run', requestId: 'r', params: {} }), /actionId/);
  // An empty id is not an id: it reaches `getApp('')` and answers "no such
  // action", which reads as a bug in the catalog rather than in the caller.
  assert.match(rejected({ type: 'replay.run', requestId: '', actionId: 'a', params: {} }), /requestId/);
});

test('capture.control takes the two actions it has and no others', () => {
  // `action` used to be compared with `=== 'pause'`, so ANY other value — a
  // typo, a future action this runner does not implement — read as "resume".
  // Silently resuming a capture that was paused on purpose is the one outcome
  // this message must never produce.
  for (const action of ['stop', 'clear', '', 'PAUSE', 1, null]) {
    assert.match(rejected({ type: 'capture.control', action }), /action/);
  }
});

test('oversized strings are refused rather than allocated', () => {
  const huge = 'x'.repeat(2000);
  assert.match(rejected({ type: 'export', containerId: huge }), /containerId/);
  assert.match(
    rejected({ type: 'replay.run', requestId: 'r', actionId: 'a', params: { k: 'y'.repeat(9000) } }),
    /params/,
  );
  const manyParams = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v']));
  assert.match(
    rejected({ type: 'replay.run', requestId: 'r', actionId: 'a', params: manyParams }),
    /params/,
  );
});

// ── Non-messages ─────────────────────────────────────────────────────────────────

test('anything that is not a message at all is refused with a reason', () => {
  for (const raw of [null, undefined, 7, 'subscribe', [], {}, { type: 'nope' }, { type: 7 }]) {
    assert.ok(rejected(raw).length > 0, `${JSON.stringify(raw)} must say why`);
  }
});

test('a frame that is not JSON says so instead of throwing', () => {
  // This runs on every socket message. A throw here takes down the connection
  // handler, which is a worse outcome than any malformed frame.
  const r = parseClientFrame('{not json');
  assert.deepEqual(r, { ok: false, reason: 'not JSON' });
  assert.equal(parseClientFrame('{"type":"sync"}').ok, true);
});

test('a rejection names the field, so the notice is actionable', () => {
  // The reason ends up in a `notice` the UI shows. "invalid message" would send
  // someone to read the runner's source; the field name does not.
  assert.match(rejected({ type: 'subscribe', sinceSeq: 'x' }), /^sinceSeq: /);
  assert.match(rejected({ type: 'export', containerId: 3 }), /^containerId: /);
});

// ── Prototype pollution ──────────────────────────────────────────────────────────

test('a params map cannot smuggle a prototype', () => {
  // `JSON.parse` gives `__proto__` as an own property rather than the real one,
  // and zod's record copies own keys — so this is about the value SURVIVING as
  // data rather than about it being assigned anywhere. What must not happen is
  // the object arriving with a mutated prototype.
  const msg = accepted(JSON.parse('{"type":"replay.run","requestId":"r","actionId":"a","params":{"__proto__":"x"}}'));
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(msg.type, 'replay.run');
});
