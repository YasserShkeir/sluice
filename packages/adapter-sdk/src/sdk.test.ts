// SPDX-License-Identifier: Apache-2.0
/**
 * SDK tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The helpers here sit underneath every adapter's parser, so the property under
 * test throughout is TOTALITY: given any input at all, they return a value
 * rather than throwing. parse() runs in the ingest funnel for every capture, so
 * a throw from one of these does not lose a row — it stops capture for every app
 * at once.
 *
 * runConformance itself is not tested here; it is exercised for real by every
 * app package and by the registry suite in @sluice/apps.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capture } from '@sluice/core';
import { arr, bool, compact, num, obj, safeJson, safeJsonObject, str } from './coerce.js';
import { makeCapture, makeJsonCapture, resetCaptureIds } from './fixtures.js';
import { parseNdjson, runMockCaptures, toNdjson } from './mock-runner.js';
import { requestParam, requestParams } from './request-params.js';

// ── Coercion ─────────────────────────────────────────────────────────────────

const HOSTILE = [null, undefined, 0, 1, '', 'x', true, false, [], {}, [1], { a: 1 }, Number.NaN, Infinity];

test('every coercion helper is total — no input throws', () => {
  for (const v of HOSTILE) {
    for (const fn of [str, num, bool, arr, obj]) {
      assert.doesNotThrow(() => fn(v), `${fn.name} threw on ${JSON.stringify(v)}`);
    }
  }
});

test('str accepts only strings, and does not stringify numbers', () => {
  assert.equal(str('x'), 'x');
  assert.equal(str(''), '');
  assert.equal(str(5), undefined, 'coercing a number here would fabricate an id');
  assert.equal(str(null), undefined);
});

test('num accepts numeric strings, because APIs send ids both ways', () => {
  assert.equal(num(5), 5);
  assert.equal(num('5'), 5);
  assert.equal(num('5.5'), 5.5);
  assert.equal(num(''), undefined);
  assert.equal(num('  '), undefined);
  assert.equal(num('abc'), undefined);
  assert.equal(num(Number.NaN), undefined, 'NaN is not a usable number');
  assert.equal(num(Infinity), undefined);
});

test('bool is not truthiness', () => {
  assert.equal(bool(true), true);
  assert.equal(bool(false), false);
  assert.equal(bool('true'), undefined, 'the string "true" is not a boolean the API meant');
  assert.equal(bool(1), undefined);
});

test('obj excludes arrays and null, which typeof alone allows', () => {
  assert.deepEqual(obj({ a: 1 }), { a: 1 });
  assert.equal(obj([]), undefined);
  assert.equal(obj(null), undefined);
  assert.deepEqual(arr([1]), [1]);
  assert.equal(arr({}), undefined);
});

test('safeJson survives everything a real response can be', () => {
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  for (const bad of [null, undefined, '', '{', '{"a":', '<html>', 'undefined']) {
    assert.doesNotThrow(() => safeJson(bad));
    assert.equal(safeJson(bad), undefined, `${JSON.stringify(bad)} must yield undefined`);
  }
  // Valid JSON that is not an object still parses, but is not an object.
  assert.ok(Array.isArray(safeJson('[1,2]')));
  assert.equal(safeJsonObject('[1,2]'), undefined);
  assert.equal(safeJsonObject('null'), undefined);
});

test('compact drops undefined without dropping falsy values', () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: 0, d: '', e: false, f: null }), {
    a: 1,
    c: 0,
    d: '',
    e: false,
    f: null,
  });
});

// ── Request params ───────────────────────────────────────────────────────────

test('request params come from a urlencoded body', () => {
  // Slack's channel id exists ONLY in the request for conversations.history, so
  // losing this produces zero items rather than an error.
  const c = makeCapture({ reqBody: 'channel=C123&limit=200', url: 'https://slack.com/api/conversations.history' });
  assert.equal(requestParam(c, 'channel'), 'C123');
  assert.equal(requestParam(c, 'limit'), '200');
});

test('request params come from a JSON body, including numbers and booleans', () => {
  const c = makeCapture({ reqBody: JSON.stringify({ channel: 'C1', limit: 200, inclusive: true }) });
  assert.deepEqual(requestParams(c), { channel: 'C1', limit: '200', inclusive: 'true' });
});

test('request params come from the query string, which wins over the body', () => {
  const c = makeCapture({
    url: 'https://slack.com/api/x?channel=FROM_QUERY',
    reqBody: 'channel=FROM_BODY&other=1',
  });
  assert.equal(requestParam(c, 'channel'), 'FROM_QUERY');
  assert.equal(requestParam(c, 'other'), '1', 'the body still contributes what the query lacks');
});

test('request params never throw on a malformed request', () => {
  for (const [url, body] of [
    ['not a url', '{'],
    ['https://x/', null],
    ['https://x/', '------WebKitFormBoundary\r\nContent-Disposition: form-data'],
  ] as Array<[string, string | null]>) {
    assert.doesNotThrow(() => requestParams(makeCapture({ url, reqBody: body })));
  }
});

// ── Fixture factory ──────────────────────────────────────────────────────────

test('makeCapture applies overrides last and gives distinct ids', () => {
  resetCaptureIds();
  const a = makeCapture();
  const b = makeCapture({ host: 'slack.com', status: 429 });
  assert.notEqual(a.id, b.id, 'two fixtures sharing an id would upsert onto each other');
  assert.equal(b.host, 'slack.com');
  assert.equal(b.status, 429);
  assert.equal(b.method, 'POST', 'defaults survive a partial override');
});

test('makeJsonCapture derives the url from host+path so they cannot disagree', () => {
  const c = makeJsonCapture('slack.com', '/api/users.list', { ok: true });
  assert.equal(c.url, 'https://slack.com/api/users.list');
  assert.equal(c.resBody, '{"ok":true}');
});

// ── Mock runner ──────────────────────────────────────────────────────────────

function fixture(id: string, ts: number): Capture {
  return makeCapture({ id, ts });
}

test('NDJSON round-trips', () => {
  const captures = [fixture('a', 1_000), fixture('b', 2_000)];
  const { captures: back, skipped } = parseNdjson(toNdjson(captures));
  assert.equal(back.length, 2);
  assert.deepEqual(skipped, []);
  assert.equal(back[0]?.id, 'a');
});

test('one broken line does not lose the whole fixture', () => {
  // A fixture is a file someone hand-edited to scrub it, so a broken line is an
  // expected condition — and it must be reported, not silently dropped.
  const text = ['{"id":"a","ts":1}', 'not json', '', '{"no":"id"}', '{"id":"b","ts":2}'].join('\n');
  const { captures, skipped } = parseNdjson(text);
  assert.deepEqual(captures.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(skipped, [2, 4], 'the caller must be able to report which lines went');
});

test('an empty fixture yields nothing rather than throwing', () => {
  assert.deepEqual(parseNdjson(''), { captures: [], skipped: [] });
  assert.equal(toNdjson([]), '');
});

test('replay feeds every capture to the sink, oldest first', async () => {
  // Order is not cosmetic: Slack resolves a channel's workspace from whichever
  // endpoint arrives first, so replaying out of order changes what is stored.
  const seen: string[] = [];
  const n = await runMockCaptures(
    [fixture('third', 3_000), fixture('first', 1_000), fixture('second', 2_000)],
    (c) => seen.push(c.id),
    { speed: Infinity },
  );
  assert.equal(n, 3);
  assert.deepEqual(seen, ['first', 'second', 'third']);
});

test('replay paces itself from the recorded gaps, divided by speed', async () => {
  const startedAt = Date.now();
  await runMockCaptures([fixture('a', 0), fixture('b', 600)], () => {}, { speed: 10 });
  const elapsed = Date.now() - startedAt;
  // 600ms of recorded gap at 10x is ~60ms. Bounded loosely on both sides: the
  // point is that it waits at all, and that speed divides the wait.
  assert.ok(elapsed >= 30, `expected a real delay, got ${elapsed}ms`);
  assert.ok(elapsed < 400, `expected the 10x divisor to apply, got ${elapsed}ms`);
});

test('a long idle gap in a recording is capped, not honoured', async () => {
  const startedAt = Date.now();
  await runMockCaptures([fixture('a', 0), fixture('b', 10 * 60 * 1000)], () => {}, {
    speed: 1,
    maxGapMs: 50,
  });
  assert.ok(Date.now() - startedAt < 1_000, 'a ten-minute recorded gap must not become a ten-minute test');
});

test('aborting resolves with a partial count instead of rejecting', async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  const done = await runMockCaptures(
    [fixture('a', 0), fixture('b', 5_000), fixture('c', 10_000)],
    (c) => {
      seen.push(c.id);
      if (seen.length === 1) controller.abort();
    },
    { speed: 1, maxGapMs: 30, signal: controller.signal },
  );
  assert.equal(done, 1, 'a partial replay is an outcome, not an error');
  assert.deepEqual(seen, ['a']);
});

test('replay preserves recorded timestamps by default, and retimes on request', async () => {
  const asRecorded: number[] = [];
  await runMockCaptures([fixture('a', 1_000), fixture('b', 2_000)], (c) => asRecorded.push(c.ts), {
    speed: Infinity,
  });
  assert.deepEqual(asRecorded, [1_000, 2_000], 'reproducibility is the default');

  const retimed: number[] = [];
  await runMockCaptures([fixture('a', 1_000), fixture('b', 2_000)], (c) => retimed.push(c.ts), {
    speed: Infinity,
    retime: true,
  });
  assert.ok((retimed[0] ?? 0) > 1_700_000_000_000, 'retimed captures land in the present');
  assert.ok((retimed[1] ?? 0) >= (retimed[0] ?? 0), 'and keep their relative order');
});

test('progress is reported per capture', async () => {
  const ticks: Array<[number, number]> = [];
  await runMockCaptures([fixture('a', 0), fixture('b', 1)], () => {}, {
    speed: Infinity,
    onProgress: (done, total) => ticks.push([done, total]),
  });
  assert.deepEqual(ticks, [
    [1, 2],
    [2, 2],
  ]);
});
