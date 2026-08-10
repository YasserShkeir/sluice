// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * app-fast tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * Everything here is pure: URL construction, matching, classification, and
 * parsing. The actual speed test makes real network calls and is left to manual
 * verification.
 *
 * fast.com is the repo's degenerate adapter — no credentials, no pagination —
 * so `runConformance` at the bottom is doing more work here than anywhere else:
 * it is the proof that the contract does not quietly require either.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, makeJsonCapture, runConformance } from '@sluice/adapter-sdk';
import type { AppToolContext, Capture } from '@sluice/core';
import { classifyFastCapture, configUrl, fastApp, fetchConfig, parseFastCapture, rangeUrl } from './index.js';

/** The config call, since that is what most of these tests are about. */
function capture(over: Partial<Capture> = {}): Capture {
  return makeCapture({
    method: 'GET',
    url: 'https://api.fast.com/netflix/speedtest/v2',
    host: 'api.fast.com',
    path: '/netflix/speedtest/v2',
    ...over,
  });
}

test('matchRequest claims fast.com and its CDN, and nothing else', () => {
  const hit = (host: string) => fastApp.matchRequest({ host, path: '/', method: 'GET', url: '' });
  for (const h of ['fast.com', 'api.fast.com', 'nflxvideo.net', 'ipv4-c001.nflxvideo.net']) {
    assert.ok(hit(h), `${h} should match`);
  }
  for (const h of ['slack.com', 'trello.com', 'notfast.com.evil.test', 'notnflxvideo.net']) {
    assert.ok(!hit(h), `${h} must not match`);
  }
});

test('rangeUrl keeps the query params the OCA requires', () => {
  // The token/expiry params live in the query; dropping them makes the download
  // 403 rather than fail loudly, so this is worth pinning.
  const out = rangeUrl('https://oca.nflxvideo.net/speedtest?c=gb&n=1&v=5&e=99&t=abc', 2048);
  const u = new URL(out);
  assert.equal(u.pathname, '/speedtest/range/0-2047');
  assert.equal(u.searchParams.get('t'), 'abc');
  assert.equal(u.searchParams.get('e'), '99');
});

test('configUrl carries the token and the expected shape', () => {
  const u = new URL(configUrl('TOK'));
  assert.equal(u.host, 'api.fast.com');
  assert.equal(u.searchParams.get('token'), 'TOK');
  assert.equal(u.searchParams.get('https'), 'true');
  assert.equal(u.searchParams.get('urlCount'), '5');
});

// ── Classification ───────────────────────────────────────────────────────────────

test('the speedtest config is the one structural call', () => {
  const got = classifyFastCapture(capture({ resBody: '{"targets":[]}' }));
  assert.equal(got.class, 'structure');
  assert.equal(got.operation, 'speedtest.config');
});

test('an OCA range download is binary, so a recorder can refuse to store it', () => {
  // The whole point: these are ~25 MiB each. Before the class existed, the only
  // thing keeping them out of SQLite was a comment in speedtest.ts.
  const got = classifyFastCapture(
    capture({
      host: 'ipv4-c001.lhr001.ix.nflxvideo.net',
      path: '/speedtest/range/0-26214399',
      url: 'https://ipv4-c001.lhr001.ix.nflxvideo.net/speedtest/range/0-26214399?c=gb&t=abc',
    }),
  );
  assert.equal(got.class, 'binary');
  assert.equal(got.operation, 'speedtest.range');
});

test('the site shell and its app bundle are assets', () => {
  const shell = classifyFastCapture(
    capture({ host: 'fast.com', path: '/', url: 'https://fast.com/', resBody: '<!doctype html>' }),
  );
  assert.equal(shell.class, 'asset');
  assert.equal(shell.operation, 'app.shell');

  // The bundle matters by name: fetchToken() scrapes the API token out of it.
  const bundle = classifyFastCapture(
    capture({ host: 'fast.com', path: '/app-a1b2c3d4.js', url: 'https://fast.com/app-a1b2c3d4.js' }),
  );
  assert.equal(bundle.class, 'asset');
  assert.equal(bundle.operation, 'app.bundle');
});

test('a rejected call is an error, and still keeps its operation name', () => {
  // Status wins over shape: a 429 body is a rejection, not a config, and calling
  // it `structure` is what would send parse() looking for targets inside it.
  const got = classifyFastCapture(capture({ status: 429, resBody: '{"targets":[{"url":"https://x/"}]}' }));
  assert.equal(got.class, 'error');
  assert.equal(got.operation, 'speedtest.config');
  assert.deepEqual(parseFastCapture(capture({ status: 429, resBody: '{"targets":[{"url":"https://x/"}]}' })), {});
});

test('anything else fast.com serves is unknown, never a guess', () => {
  assert.equal(classifyFastCapture(capture({ host: 'fast.com', path: '/favicon.ico' })).class, 'unknown');
  // A config response with no body is named but not parseable.
  const empty = classifyFastCapture(capture({ resBody: null }));
  assert.equal(empty.class, 'unknown');
  assert.equal(empty.operation, 'speedtest.config');
});

// ── Pagination ───────────────────────────────────────────────────────────────────

test('nextCursors is always empty — fast.com has no pagination at all', () => {
  // urlCount=5 is a fan-out COUNT, not a page size, and nothing in a fast.com
  // response is a continuation token. An empty answer here is the correct one,
  // not a stub.
  for (const c of [
    capture({ resBody: JSON.stringify({ targets: [{ url: 'https://a.nflxvideo.net/speedtest' }] }) }),
    capture({ url: 'https://api.fast.com/netflix/speedtest/v2?urlCount=5', resBody: '{}' }),
    capture({ host: 'fast.com', path: '/', resBody: '<!doctype html>' }),
    capture({ resBody: null }),
  ]) {
    assert.deepEqual(fastApp.nextCursors?.(c), []);
  }
});

// ── Parsing ──────────────────────────────────────────────────────────────────────

test('parse turns a config response into one container per CDN target', () => {
  const result = parseFastCapture(
    capture({
      resBody: JSON.stringify({
        targets: [
          { url: 'https://a.nflxvideo.net/speedtest', name: 'a', location: { city: 'London' } },
          { url: 'https://b.nflxvideo.net/speedtest', name: 'b', location: { city: 'Paris' } },
        ],
      }),
    }),
  );
  assert.equal(result.containers?.length, 2);
  assert.equal(result.containers?.[0]?.name, 'London a');
  assert.equal(result.containers?.[0]?.adapterId, 'fast');
  assert.ok(result.containers?.[0]?.raw, 'raw payload is kept for the cartographer');
});

test('parse ignores anything that is not the config endpoint', () => {
  assert.deepEqual(parseFastCapture(capture({ host: 'fast.com', path: '/' })), {});
  assert.deepEqual(parseFastCapture(capture({ resBody: null })), {});
});

test('parse never throws on a malformed body', () => {
  // parse runs in the ingest path for every capture — a throw takes down the funnel.
  assert.deepEqual(parseFastCapture(capture({ resBody: '{not json' })), {});
  assert.deepEqual(parseFastCapture(capture({ resBody: '[]' })), { containers: [] });
  // Regression: `JSON.parse('null')` succeeds, and the `cfg.targets` read that
  // followed it sat outside the try — a literal `null` body threw a TypeError
  // straight into the funnel.
  assert.deepEqual(parseFastCapture(capture({ resBody: 'null' })), { containers: [] });
});

test('parse survives targets sent as an object instead of an array', () => {
  // Regression: this body classifies as `structure`, so the guard passes, and
  // `cfg?.targets ?? []` then handed the OBJECT to `for…of` — `??` only fires on
  // a MISSING field, and the field is present, just not iterable. The result was
  // `TypeError: object is not iterable` out of the ingest funnel, killing capture
  // for every app at once.
  assert.deepEqual(parseFastCapture(capture({ resBody: '{"targets":{"0":{"url":"https://x/"}}}' })), {
    containers: [],
  });
  for (const targets of ['"a string"', '42', 'true', 'null', '{}']) {
    assert.deepEqual(parseFastCapture(capture({ resBody: `{"targets":${targets}}` })), { containers: [] });
  }
});

test('parse skips targets whose own fields are wrong-typed, and keeps the rest', () => {
  // A target is not a shape fast.com owes us: a numeric url, a `location` that is
  // a string, a null entry. Each must be dropped or ignored, never thrown on.
  const result = parseFastCapture(
    capture({
      resBody: JSON.stringify({
        targets: [
          null,
          { url: 12345 },
          { url: '' },
          { url: 'https://a.nflxvideo.net/speedtest', name: [], location: 'London' },
          { url: 'https://b.nflxvideo.net/speedtest', name: 'b', location: { city: 'Paris' } },
        ],
      }),
    }),
  );
  assert.equal(result.containers?.length, 2);
  assert.equal(result.containers?.[0]?.name, '');
  assert.equal(result.containers?.[1]?.name, 'Paris b');
});

// ── The config fetch behind the speed test ───────────────────────────────────────

/**
 * An `AppToolContext` whose replay answers with one canned capture — the seam
 * that lets the config path be tested without a network.
 */
function ctxReturning(over: Partial<Capture>): AppToolContext {
  return { replay: () => Promise.resolve(capture(over)) };
}

test('fetchConfig rejects an unusable body with a clear message', async () => {
  // Regression: `runReplay` records `resBody: null` whenever `res.text()` rejects
  // — a connection dropped mid-body — so a 200 with a null body is routine, and
  // `JSON.parse(… ?? 'null') as FastConfig` handed `null` back as a config.
  // `runSpeedTest` then read `.targets` off it OUTSIDE the try that exists to
  // turn a bad config into a message, and threw a bare TypeError instead.
  for (const body of [null, 'null', '[]', '"a string"', '{not json']) {
    await assert.rejects(() => fetchConfig('TOK', ctxReturning({ resBody: body })), /non-JSON body/);
  }
});

test('fetchConfig always yields an array of targets that really have a url', async () => {
  // `?? []` never protected the `cfg.targets` iteration in runSpeedTest either:
  // a `targets` map keyed by index is present, so `??` passes it through and
  // `.filter` is not a function.
  const asObject = await fetchConfig('TOK', ctxReturning({ resBody: '{"targets":{"0":{"url":"https://x/"}}}' }));
  assert.deepEqual(asObject.targets, []);

  const mixed = await fetchConfig(
    'TOK',
    ctxReturning({
      resBody: JSON.stringify({
        client: { ip: '203.0.113.7', isp: 'Example ISP', location: { city: 'London', country: 'gb' } },
        targets: [null, { url: 42 }, { url: 'https://a.nflxvideo.net/speedtest', name: 'a' }],
      }),
    }),
  );
  assert.deepEqual(mixed.targets, [{ url: 'https://a.nflxvideo.net/speedtest', name: 'a' }]);
  assert.deepEqual(mixed.client, {
    ip: '203.0.113.7',
    isp: 'Example ISP',
    location: { city: 'London', country: 'gb' },
  });
});

test('fetchConfig surfaces the HTTP status when the config call was rejected', async () => {
  await assert.rejects(
    () => fetchConfig('TOK', ctxReturning({ status: 429, resBody: '{"error":"slow down"}' })),
    /HTTP 429/,
  );
  await assert.rejects(() => fetchConfig('TOK', ctxReturning({ status: null, resBody: null })), /HTTP error/);
});

test('the app declares its public token so captures stay replayable', () => {
  const rule = fastApp.redaction?.publicParams?.[0];
  assert.ok(rule, 'fast.com must declare its token public');
  assert.ok(rule.params.includes('token'));
});

// ── Conformance ──────────────────────────────────────────────────────────────────

/** One capture of each shape fast.com actually produces, in observed order. */
const FIXTURES: Capture[] = [
  makeCapture({
    method: 'GET',
    host: 'fast.com',
    path: '/',
    url: 'https://fast.com/',
    resHeaders: { 'content-type': 'text/html' },
    resBody: '<!doctype html><html><body><script src="/app-a1b2c3d4.js"></script></body></html>',
  }),
  makeJsonCapture(
    'api.fast.com',
    '/netflix/speedtest/v2',
    {
      client: { ip: '203.0.113.7', isp: 'Example ISP', location: { city: 'London', country: 'gb' } },
      targets: [
        {
          url: 'https://ipv4-c001.lhr001.ix.nflxvideo.net/speedtest?c=gb&n=1&v=5&e=99&t=abc',
          name: 'ipv4-c001.lhr001.ix',
          location: { city: 'London', country: 'gb' },
        },
      ],
    },
    { method: 'GET', url: 'https://api.fast.com/netflix/speedtest/v2?https=true&token=TOK&urlCount=5' },
  ),
  makeCapture({
    method: 'GET',
    host: 'ipv4-c001.lhr001.ix.nflxvideo.net',
    path: '/speedtest/range/0-26214399',
    url: 'https://ipv4-c001.lhr001.ix.nflxvideo.net/speedtest/range/0-26214399?c=gb&t=abc',
    resHeaders: { 'content-type': 'application/octet-stream' },
    // Deliberately null: this is the capture the `binary` class exists to stop
    // anyone from filling in.
    resBody: null,
  }),
];

// No `session`: fast.com has no credential seam, and the harness skipping the
// replay-secret checks for it is the behaviour being relied on, not a gap.
runConformance(fastApp, { fixtures: FIXTURES });
