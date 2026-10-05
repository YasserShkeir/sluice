// SPDX-License-Identifier: Apache-2.0
/**
 * Scrubber tests.
 *
 * Two properties, and they pull against each other, which is why both are
 * asserted on the same fixture rather than separately: the output must contain
 * NONE of the input's content, and it must have ALL of the input's shape. Give
 * up the first and the fixture cannot be committed; give up the second and the
 * fixture no longer tests the parser it was recorded for.
 *
 * The fixture below is a synthetic imitation of Gmail's `/sync/u/0/i/bv` — a
 * positional array with no field names anywhere, which is the case that makes
 * shape preservation load-bearing. Nothing here came from a real mailbox.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MASK } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { makeCapture } from './fixtures.js';
import { scrubCaptures } from './scrub.js';

// ── A synthetic positional-array fixture ─────────────────────────────────────

/** A sparse positional record: `len` slots, nulls everywhere not named. */
function slots(len: number, filled: Record<number, unknown>): unknown[] {
  const out: unknown[] = new Array(len).fill(null);
  for (const [i, v] of Object.entries(filled)) out[Number(i)] = v;
  return out;
}

const SUBJECT = 'Quarterly hedgehog census, north field';
const SNIPPET = 'We counted the hedgehogs twice this year and the second count disagreed with the first';
const ADDRESS = 'bartholomew@corvid-supply.invalid';
const DISPLAY_NAME = 'Bartholomew Featherstonehaugh';
const THREAD_ID = 'thread-f:1234567890123456789';
const MSG_ID = 'msg-f:9876543210987654';
const LABELS = ['^i', '^all', '^smartlabel_promo', '^p_ag'];

const message = slots(72, {
  0: MSG_ID,
  1: [1, DISPLAY_NAME, ADDRESS],
  6: 1_700_000_100_000,
  9: SNIPPET,
  10: LABELS,
  15: '<CAF9wonkyMessageIdentifier@mail.corvid-supply.invalid>',
  17: 1_700_000_100_500,
  30: 1_700_000_101_000,
  43: 3,
  55: 'fe90ab12cd34ef56',
  71: [],
});

const thread = slots(25, {
  0: SUBJECT,
  1: SNIPPET,
  2: 1_700_000_200_000,
  3: THREAD_ID,
  4: [message],
  14: [[[DISPLAY_NAME, ADDRESS]]],
  16: 1,
  19: '00a1b2c3d4e5f607',
  24: [[1], '^i', '^p_ag'],
});

const BV_BODY: unknown[] = [
  0,
  [[slots(28, { 0: '^i', 1: '^i', 6: 1, 17: 1, 27: 374 }), 12]],
  [[thread, 42]],
  1,
  2,
  1_700_000_300_000,
];

/** The real endpoint answers without a preamble; checkbuild answers with one. */
const PREAMBLE = ")]}'\n\n";

/**
 * Gmail's `x-framework-xsrf-token` SHAPE — `<34-character token>:<epoch ms>` —
 * with an obviously synthetic token, so no real session value sits in source.
 */
const XSRF_TOKEN = 'SYNTHETICxsrfTOKENforSCRUBtests000';

/** One fixed salt and shift, for the tests that are about determinism. */
const FIXED = { salt: 'scrub-test-salt', shiftMs: -40_000_000_000 };

function bvCapture(over: Partial<Capture> = {}): Capture {
  return makeCapture({
    host: 'mail.google.com',
    path: '/sync/u/0/i/bv',
    url: 'https://mail.google.com/sync/u/0/i/bv?hl=en&c=9&rt=r&pt=ji',
    method: 'POST',
    ts: 1_700_000_400_000,
    reqHeaders: {
      'content-type': 'application/json',
      cookie: MASK,
      referer: 'https://mail.google.com/mail/u/0/?compose=new',
      'x-framework-xsrf-token': `${XSRF_TOKEN}:1700000000123`,
    },
    reqBody: JSON.stringify([[9, 9, null, 'ji:^i', THREAD_ID]]),
    resHeaders: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': MASK },
    resBody: `${PREAMBLE}${JSON.stringify(BV_BODY)}`,
    ...over,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Types, lengths, array arity and object keys — everything except the values. */
function shapeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(shapeOf).join(',')}]`;
  if (typeof v === 'string') return `s${v.length}`;
  if (typeof v === 'number') return 'n';
  if (typeof v === 'boolean') return 'b';
  if (typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}:${shapeOf(x)}`)
      .join(',')}}`;
  }
  return typeof v;
}

function bodyJson(body: string | null): unknown {
  const text = body ?? '';
  return JSON.parse(text.startsWith(")]}'") ? text.slice(text.indexOf('[')) : text) as unknown;
}

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out);
  }
  return out;
}

function scrubOne(capture: Capture): Capture {
  const [only] = scrubCaptures([capture]);
  assert.ok(only, 'scrubCaptures dropped a capture');
  return only;
}

// ── Shape ────────────────────────────────────────────────────────────────────

test('shape survives exactly: arity, depth, types and string lengths', () => {
  const scrubbed = scrubOne(bvCapture());
  assert.equal(
    shapeOf(bodyJson(scrubbed.resBody)),
    shapeOf(BV_BODY),
    'a positional API has no field names — index, type and length ARE the contract',
  );
  assert.equal(shapeOf(bodyJson(scrubbed.reqBody)), shapeOf(JSON.parse(bvCapture().reqBody ?? '')));
});

test('every string keeps its length, so length heuristics still fire', () => {
  const before = collectStrings(BV_BODY);
  const after = collectStrings(bodyJson(scrubOne(bvCapture()).resBody));
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i]?.length, before[i]?.length, `string ${i} changed length`);
  }
});

test('routing metadata is kept verbatim — a fixture that cannot be matched is not a fixture', () => {
  const scrubbed = scrubOne(bvCapture());
  assert.equal(scrubbed.host, 'mail.google.com');
  assert.equal(scrubbed.path, '/sync/u/0/i/bv');
  assert.equal(scrubbed.method, 'POST');
  assert.equal(scrubbed.status, 200);
  assert.ok(scrubbed.url.startsWith('https://mail.google.com/sync/u/0/i/bv?'));
  assert.equal(scrubbed.resHeaders['content-type'], 'application/json; charset=utf-8');
});

// ── Content ──────────────────────────────────────────────────────────────────

test('no original content string survives anywhere in the output', () => {
  const scrubbed = scrubOne(bvCapture());
  const line = JSON.stringify(scrubbed);
  const original = [
    ...collectStrings(BV_BODY),
    // `content-type` is protocol vocabulary and is kept on purpose; every other
    // header value is the user's session, their browser, or where they were.
    ...Object.entries(bvCapture().reqHeaders)
      .filter(([name]) => name !== 'content-type')
      .map(([, value]) => value),
    SUBJECT,
    SNIPPET,
    ADDRESS,
    DISPLAY_NAME,
    THREAD_ID,
    MSG_ID,
  ];
  for (const s of original) {
    // Labels and masks are kept on purpose and asserted separately below. Very
    // short strings are excluded because a same-length replacement can collide
    // with them by chance, which would make this test flaky rather than strict.
    if (s.startsWith('^') || s === MASK || s.length < 4) continue;
    assert.ok(!line.includes(s), `original content survived the scrub: ${s.length} chars`);
  }
});

test('a session token that looks like a prefixed id is replaced, not preserved', () => {
  // `<34-char token>:<epoch ms>` matched an unbounded `<name>:<digits>` rule and
  // was written into the fixture verbatim. The prefix bound is what stops it.
  const scrubbed = scrubOne(bvCapture());
  assert.ok(!JSON.stringify(scrubbed).includes(XSRF_TOKEN));
});

test('redaction masks are left exactly as the redactor wrote them', () => {
  const scrubbed = scrubOne(bvCapture());
  assert.equal(scrubbed.reqHeaders['cookie'], MASK, 'the fixture also proves the redactor ran');
  assert.equal(scrubbed.resHeaders['set-cookie'], MASK);
});

// ── Structural markers ───────────────────────────────────────────────────────

test('label ids survive verbatim — a parser routing on ^i must still see ^i', () => {
  const scrubbed = bodyJson(scrubOne(bvCapture()).resBody);
  const strings = new Set(collectStrings(scrubbed));
  for (const label of LABELS) assert.ok(strings.has(label), `${label} did not survive`);
});

test('thread and message id FORM survives, with different digits of the same length', () => {
  const strings = collectStrings(bodyJson(scrubOne(bvCapture()).resBody));
  const thread = strings.find((s) => s.startsWith('thread-f:'));
  const msg = strings.find((s) => s.startsWith('msg-f:'));
  assert.ok(thread && msg, 'the id prefixes are what a parser recognizes a thread by');
  assert.equal(thread.length, THREAD_ID.length);
  assert.equal(msg.length, MSG_ID.length);
  assert.notEqual(thread, THREAD_ID);
  assert.notEqual(msg, MSG_ID);
  assert.match(thread, /^thread-f:[1-9]\d*$/);
  assert.match(msg, /^msg-f:[1-9]\d*$/);
});

test('epoch-ms numbers shift by one constant, so ordering and gaps survive', () => {
  const capture = scrubOne(bvCapture());
  const scrubbed = bodyJson(capture.resBody) as unknown[];
  const before = [1_700_000_100_000, 1_700_000_100_500, 1_700_000_101_000, 1_700_000_200_000];
  const found: number[] = [];
  (function walk(v: unknown): void {
    if (typeof v === 'number' && v > 1e11) found.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
  })(scrubbed);
  found.sort((a, b) => a - b);
  const shift = (found[0] ?? 0) - (before[0] ?? 0);
  assert.notEqual(shift, 0, 'an unshifted timestamp still says when the user did something');
  for (let i = 0; i < before.length; i++) {
    assert.equal(found[i], (before[i] ?? 0) + shift, 'one constant offset, or the gaps are lost');
  }
  assert.equal(capture.ts, 1_700_000_400_000 + shift, 'the capture ts shifts with them');
});

test('non-timestamp numbers pass through — a parser branching on kind === 2 needs 2', () => {
  const scrubbed = bodyJson(scrubOne(bvCapture()).resBody) as unknown[];
  assert.equal(scrubbed[0], 0);
  assert.equal(scrubbed[3], 1);
  assert.equal(scrubbed[4], 2);
});

// ── Bodies ───────────────────────────────────────────────────────────────────

test("the )]}' preamble is stripped, scrubbed under, and put back", () => {
  const scrubbed = scrubOne(bvCapture());
  assert.ok(scrubbed.resBody?.startsWith(PREAMBLE), 'else the fixture stops exercising the strip');
  assert.doesNotThrow(() => JSON.parse((scrubbed.resBody ?? '').slice(PREAMBLE.length)));
});

test('a body with no preamble does not grow one', () => {
  const scrubbed = scrubOne(bvCapture({ resBody: JSON.stringify(BV_BODY) }));
  assert.ok(!scrubbed.resBody?.startsWith(')'));
  assert.equal(shapeOf(JSON.parse(scrubbed.resBody ?? '')), shapeOf(BV_BODY));
});

test('a body that is not JSON is scrubbed as opaque text of the same length', () => {
  const html = '<html><body>Sorry, an error occurred. Contact hedgehog-support.</body></html>';
  const scrubbed = scrubOne(bvCapture({ resBody: html }));
  assert.equal(scrubbed.resBody?.length, html.length);
  assert.ok(!scrubbed.resBody?.includes('hedgehog-support'));
});

test('a preamble on a body that is NOT JSON is still put back', () => {
  // Gmail's `/mail/u/0/` answers with `)]}'` over a length-prefixed chunk stream,
  // which is not JSON. Losing the preamble there loses the strip under test.
  const chunked = `${PREAMBLE}463\n[["hedgehog census","north field"]]`;
  const scrubbed = scrubOne(bvCapture({ resBody: chunked }));
  assert.ok(scrubbed.resBody?.startsWith(PREAMBLE));
  assert.equal(scrubbed.resBody?.length, chunked.length);
  assert.ok(!scrubbed.resBody?.includes('hedgehog census'));
});

test('an absent body stays absent, and an empty one stays empty', () => {
  assert.equal(scrubOne(bvCapture({ resBody: null })).resBody, null);
  assert.equal(scrubOne(bvCapture({ reqBody: '' })).reqBody, '');
});

// ── URLs and headers ─────────────────────────────────────────────────────────

test('a URL keeps its origin and path and loses its query values', () => {
  const scrubbed = scrubOne(
    bvCapture({ url: 'https://mail.google.com/sync/u/0/i/fd?hl=en&q=hedgehog%20census' }),
  );
  const u = new URL(scrubbed.url);
  assert.equal(u.origin, 'https://mail.google.com');
  assert.equal(u.pathname, '/sync/u/0/i/fd');
  assert.deepEqual([...u.searchParams.keys()], ['hl', 'q'], 'param names are the API, not the user');
  assert.ok(!scrubbed.url.includes('hedgehog'), 'a search term is the user speaking');
});

test('a URL INSIDE a body loses its path AND its host, because both are payload', () => {
  // Gmail's image proxy encodes the original remote image URL into
  // `/proxy/<token>`. Keeping embedded paths wrote every remote image the
  // mailbox had loaded into the fixture — found by a leak check, not a test.
  //
  // The host went the same way for the same reason: a later leak check over an
  // already-scrubbed mailbox came back with a list of third-party domains read
  // straight out of the message bodies. Which companies email a person IS
  // content, and an embedded host is never what an adapter routes on —
  // `capture.host` is, and that one still survives.
  const proxied = 'https://ci3.googleusercontent.com/proxy/aGVkZ2Vob2ctY2Vuc3VzLXBob3RvLmpwZw';
  const scrubbed = scrubOne(bvCapture({ resBody: JSON.stringify([proxied]) }));
  const [only] = bodyJson(scrubbed.resBody) as string[];
  assert.ok(only);
  assert.equal(only.length, proxied.length, 'the shape a parser sees is unchanged');
  assert.ok(only.startsWith('https://'), 'the scheme is protocol, not payload');
  assert.ok(!only.includes('googleusercontent'), 'an embedded host is the user speaking');
  assert.ok(!only.includes('aGVkZ2Vob2ctY2Vuc3VzLXBob3RvLmpwZw'));
  assert.equal(only.split('/').length, proxied.split('/').length, 'segment count survives');
  const host = new URL(only).hostname;
  assert.equal(host.split('.').length, 3, 'label count survives, so a subdomain still looks like one');
  assert.deepEqual(
    host.split('.').map((l) => l.length),
    'ci3.googleusercontent.com'.split('.').map((l) => l.length),
  );
});

test('the capture’s OWN host survives — a fixture nothing matches is not a fixture', () => {
  // The mirror of the test above, and the reason the split exists at all:
  // `matchRequest` routes on `capture.host`, so scrambling it there would leave
  // a fixture that exercises no adapter.
  const scrubbed = scrubOne(bvCapture());
  assert.equal(new URL(scrubbed.url).hostname, 'mail.google.com');
});

test('the :path pseudo-header keeps its path and loses its query, like the url does', () => {
  // `:path` is the path AND the query string. Filed under "protocol vocabulary"
  // it republished every query value `capture.url` had just scrubbed.
  const scrubbed = scrubOne(
    bvCapture({
      reqHeaders: { ':path': '/mail/u/0/checkbuild?bl=acme.fixture-server_20000101.01_p0' },
    }),
  );
  const target = scrubbed.reqHeaders[':path'] ?? '';
  assert.ok(target.startsWith('/mail/u/0/checkbuild?bl='), 'the route still routes');
  assert.ok(!target.includes('fixture-server'), 'an internal build label is not ours to publish');
});

test('a URL keeps its exact length, whatever is nested inside it', () => {
  // `new URL('https://x.com').toString()` appends a `/` and `URLSearchParams`
  // re-encodes every value, so a nested `?u=https://…` came back 74 characters
  // longer than it went in. Neither is usable in a scrubber that promises length.
  const urls = [
    'https://mail.google.com',
    'https://mail.google.com/',
    'https://www.example.invalid/r?u=https://tracker.invalid/click/AbC123&e=x',
    'https://www.example.invalid/r?u=https%3A%2F%2Ftracker.invalid%2Fclick%2FAbC',
    'https://mail.google.com/mail/u/0/#inbox/FMfcgzabcdefghijklmnop',
    'https://alice:hunter2@files.example.invalid/private/report.pdf',
    'https://example.invalid/a?flag&b=2',
  ];
  const scrubbed = scrubOne(bvCapture({ resBody: JSON.stringify(urls) }));
  const after = bodyJson(scrubbed.resBody) as string[];
  for (let i = 0; i < urls.length; i++) {
    assert.equal(after[i]?.length, urls[i]?.length, `url ${i} changed length`);
  }
  assert.ok(!JSON.stringify(after).includes('hunter2'), 'userinfo is a credential');
  assert.ok(!JSON.stringify(after).includes('AbC123'), 'a tracking token is the user');
  assert.match(after[6] ?? '', /\?[A-Za-z-]{4}&b=/, 'a bare flag keeps its length and its place');
});

// ── Nested and encoded URLs ──────────────────────────────────────────────────
//
// The regression: a redirect wrapper's inner URL whose own query was encoded
// (`?email_token%3D…%26oid%3D…`) is ONE query part with no `=`, and a part with
// no `=` passed through as a "bare flag" — so the whole encoded query, tokens
// and all, rode into a published fixture with only `%` turned into `-`. Every
// value below is synthetic.

/** Scrub each string as an embedded URL (a body value) and return them in order. */
function scrubEmbedded(urls: string[]): string[] {
  return bodyJson(scrubOne(bvCapture({ resBody: JSON.stringify(urls) })).resBody) as string[];
}

const SECRETS = [
  'SYNTHTOKENalpha0001',
  'SYNTHTOKENbravo0002',
  'SYNTHTOKENcharlie03',
  'SYNTHSIGdelta0004',
  '5550001234',
  'travel.invalid',
  'targetUrl',
];

test('tokens inside an encoded redirect never survive, at any encoding depth', () => {
  const urls = [
    // Percent-encoded inner query under a literal inner URL: the leak as found.
    'https://www.google.com/url?q=https://m.shop.invalid/o/827?email_token%3DSYNTHTOKENalpha0001%26oid%3D5550001234&sa=D',
    // The whole inner URL percent-encoded, and double-encoded one level down.
    'https://www.google.com/url?q=https%3A%2F%2Fshop.invalid%2Fr%3FtargetUrl%3Dhttps%253A%252F%252Ftravel.invalid%252Fb%253Forderid%253D5550001234%2526sig%253DSYNTHSIGdelta0004',
    // The `-3D`/`-26` form an earlier scrub left in a committed fixture, as a
    // bare flag and with a later `=` that pulls it into the NAME position.
    'https://joh.example.invalid/Iin?q=https://m.shop.invalid/o/827?email_token-3DSYNTHTOKENbravo0002-26v-3D5550001234',
    'https://joh.example.invalid/Iin?q=https://m.shop.invalid/o/1?accesstoken-3DSYNTHTOKENcharlie03-26x=1',
    // SendGrid-style click link: `-2F`, `-3D` escapes in one opaque value.
    'https://u1.ct.sendgrid.invalid/ls/click?upn=u001.targetUrl-3Dhttps-253A-252F-252Ftravel.invalid-252F-253Ftoken-253DSYNTHTOKENalpha0001',
  ];
  const after = scrubEmbedded(urls);
  const text = JSON.stringify(after);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} survived the scrub`);
  for (let i = 0; i < urls.length; i++) {
    assert.equal(after[i]?.length, urls[i]?.length, `url ${i} changed length`);
  }
});

test('the same holds for the capture’s own url, its :path, its path and its referer', () => {
  const query = '?q=https://m.shop.invalid/o/827?email_token%3DSYNTHTOKENalpha0001%26oid%3D5550001234';
  const scrubbed = scrubOne(
    bvCapture({
      url: `https://mail.google.com/mail/u/0/${query}`,
      path: `/mail/u/0/${query}`,
      reqHeaders: {
        ':path': `/mail/u/0/${query}`,
        referer: `https://mail.google.com/mail/u/0/${query}`,
      },
    }),
  );
  const text = JSON.stringify(scrubbed);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} survived the scrub`);
  assert.ok(scrubbed.url.startsWith('https://mail.google.com/mail/u/0/?q=https://'), 'the route survives');
  assert.ok(scrubbed.path.startsWith('/mail/u/0/?q='), 'so does the path’s');
});

test('a bare query flag is scrubbed like a value, not kept as a name', () => {
  const [after] = scrubEmbedded(['https://files.example.invalid/dl?SYNTHTOKENalpha0001&b=2']);
  assert.ok(after);
  assert.ok(!after.includes('SYNTHTOKENalpha0001'));
  assert.match(after, /\?[A-Za-z-]{19}&b=.$/, 'its length and place survive, and b is still b');
});

test('a param NAME survives only while it looks like one', () => {
  // A base64 JSON blob with `=` padding puts the whole token in the name slot.
  const blob = 'eyJzeW50aGV0aWMiOiJmaXh0dXJlLXN0YXRlIn0';
  const [after] = scrubEmbedded([`https://example.invalid/cb?${blob}=&state_id=abc&f.sid=1&x-y_z=2`]);
  assert.ok(after);
  assert.ok(!after.includes(blob), 'a base64 JSON blob is a token wherever it sits');
  assert.match(after, /&state_id=[^&]{3}&f\.sid=.&x-y_z=.$/, 'real names are the API');
});

test('a base64 JSON blob in the capture’s own path is scrubbed; the rest of the route is not', () => {
  const blob = 'eyJzeW50aGV0aWMiOiJmaXh0dXJlLXN0YXRlIn0';
  const scrubbed = scrubOne(bvCapture({ url: `https://mail.google.com/mail/u/0/s/${blob}/x` }));
  assert.ok(!scrubbed.url.includes(blob));
  assert.ok(scrubbed.url.startsWith('https://mail.google.com/mail/u/0/s/'));
  assert.ok(scrubbed.url.endsWith('/x'));
  assert.equal(scrubbed.url.length, `https://mail.google.com/mail/u/0/s/${blob}/x`.length);
});

test('tabUrl is the user’s page, not a route: its host and path are scrubbed too', () => {
  const tabUrl = 'https://www.notes.invalid/Quarterly-hedgehog-census-plan-0123abcd?pvs=4';
  const scrubbed = scrubOne(bvCapture({ tabUrl }));
  assert.equal(scrubbed.tabUrl?.length, tabUrl.length);
  assert.ok(scrubbed.tabUrl?.startsWith('https://'));
  assert.ok(!scrubbed.tabUrl?.includes('notes'));
  assert.ok(!scrubbed.tabUrl?.includes('hedgehog'));
});

test('a caret passes through only when it is label-shaped', () => {
  const [after] = scrubEmbedded(['^tok%3DSYNTHTOKENalpha0001']);
  assert.ok(after && !after.includes('SYNTHTOKENalpha0001'));
});

test('a redirect chain nested past any real depth is bounded, not a stack overflow', () => {
  const deep = `${'https://r.example.invalid/?q='.repeat(5_000)}SYNTHTOKENalpha0001`;
  let after: string[] = [];
  assert.doesNotThrow(() => {
    after = scrubEmbedded([deep]);
  });
  assert.equal(after[0]?.length, deep.length);
  assert.ok(!after[0]?.includes('SYNTHTOKENalpha0001'));
});

test('JSON nested past the recursion limit degrades to opaque text, not a throw', () => {
  const body = `${'['.repeat(20_000)}"SYNTHTOKENalpha0001"${']'.repeat(20_000)}`;
  let scrubbed: Capture | undefined;
  assert.doesNotThrow(() => {
    scrubbed = scrubOne(bvCapture({ resBody: body }));
  });
  assert.equal(scrubbed?.resBody?.length, body.length);
  assert.ok(!scrubbed?.resBody?.includes('SYNTHTOKENalpha0001'));
});

test('a header value that is protocol vocabulary is not scrambled', () => {
  const scrubbed = scrubOne(bvCapture());
  assert.equal(scrubbed.reqHeaders['content-type'], 'application/json');
  assert.notEqual(scrubbed.reqHeaders['referer'], bvCapture().reqHeaders['referer']);
  assert.equal(
    scrubbed.reqHeaders['referer']?.length,
    bvCapture().reqHeaders['referer']?.length,
    'a Referer is still a URL of the same length',
  );
});

// ── Determinism ──────────────────────────────────────────────────────────────

test('a fixed salt and shift scrub the same recording to the same bytes', () => {
  // Pinned ids: makeCapture hands out a fresh one per call, and this is about
  // the scrubber's determinism, not the factory's.
  const a = scrubCaptures([bvCapture({ id: 'cap_pinned' })], FIXED);
  const b = scrubCaptures([bvCapture({ id: 'cap_pinned' })], FIXED);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a[0]?.ts, 1_700_000_400_000 + FIXED.shiftMs, 'an explicit shift is the shift');
});

test('a salt changes the synthetic text without changing the shape', () => {
  const one = scrubCaptures([bvCapture()], { ...FIXED, salt: 'salt-one' })[0];
  const two = scrubCaptures([bvCapture()], { ...FIXED, salt: 'salt-two' })[0];
  assert.notEqual(one?.resBody, two?.resBody, 'two fixtures must not line up against each other');
  assert.equal(shapeOf(bodyJson(two?.resBody ?? null)), shapeOf(BV_BODY));
});

test('the default salt and shift are random per run, so neither is a published constant', () => {
  // A fixed default salt let anyone scrub a guessed name or address and look
  // for the result in a published fixture; a fixed shift made every date exact.
  const a = scrubOne(bvCapture({ id: 'cap_pinned' }));
  const b = scrubOne(bvCapture({ id: 'cap_pinned' }));
  assert.notEqual(a.resBody, b.resBody, 'the default salt must not be shared between runs');
  assert.notEqual(a.ts, b.ts, 'the default shift must not be shared between runs');
  for (const c of [a, b]) {
    const back = 1_700_000_400_000 - c.ts;
    assert.ok(back >= 180 * 86_400_000 && back <= 730 * 86_400_000, 'shifted 180–730 days back');
    assert.equal(back % 1000, 0, 'whole seconds, so ms and seconds copies still agree');
    assert.equal(shapeOf(bodyJson(c.resBody)), shapeOf(BV_BODY));
  }
});

test('equal inputs scrub to equal outputs, so a repeated id stays repeated', () => {
  // The thread id appears in both the request and the response. A parser that
  // joins the two on it has to still be able to.
  const scrubbed = scrubOne(bvCapture());
  const inReq = collectStrings(bodyJson(scrubbed.reqBody)).find((s) => s.startsWith('thread-f:'));
  const inRes = collectStrings(bodyJson(scrubbed.resBody)).find((s) => s.startsWith('thread-f:'));
  assert.ok(inReq);
  assert.equal(inReq, inRes);
});

// ── Totality ─────────────────────────────────────────────────────────────────

const HOSTILE: unknown[] = [
  null,
  undefined,
  0,
  '',
  'x',
  [],
  {},
  { id: 1, ts: 'nope', reqHeaders: 'not a map', resHeaders: null, resBody: 42, url: 'not a url' },
  { id: 'a', ts: Number.NaN, resBody: '{"a":', reqBody: '{', url: '' },
  { id: 'b', resBody: '[1,2,', reqHeaders: { a: 1, b: null }, tabUrl: 'javascript:void(0)' },
  { id: 'c', resBody: 'null', reqBody: '"just a json string"' },
  { id: 'd', source: 'ws', direction: 'sent', wsId: 'w1', reqBody: '{"deep":[[[[[[[[[[1]]]]]]]]]]}' },
];

test('nothing throws, whatever it is handed', () => {
  for (const input of HOSTILE) {
    assert.doesNotThrow(
      () => scrubCaptures([input as Capture]),
      `threw on ${JSON.stringify(input)?.slice(0, 60)}`,
    );
  }
  assert.doesNotThrow(() => scrubCaptures(null as unknown as Capture[]));
  assert.doesNotThrow(() => scrubCaptures([bvCapture()], null as unknown as { salt: string }));
  assert.deepEqual(scrubCaptures([]), []);
});

test('a malformed capture still comes back as a well-formed one', () => {
  const [only] = scrubCaptures([{ id: 'x', ts: 'nope', reqHeaders: 'nope' } as unknown as Capture]);
  assert.ok(only);
  assert.equal(typeof only.ts, 'number');
  assert.deepEqual(only.reqHeaders, {}, 'a header map that was not a map becomes an empty one');
  assert.equal(only.resBody, null);
});

test('optional fields are not invented, and are kept when present', () => {
  const bare = scrubOne(bvCapture());
  assert.ok(!('wsId' in bare), 'a fixture must not grow keys the recorder never wrote');
  const frame = scrubOne(bvCapture({ source: 'ws', direction: 'received', wsId: 'ws_1' }));
  assert.equal(frame.source, 'ws');
  assert.equal(frame.direction, 'received');
  assert.equal(frame.wsId, 'ws_1');
});

test('caret passthrough is bound to label-shaped tokens only', () => {
  const [cap] = scrubCaptures([
    {
      id: 'c',
      ts: 1,
      source: 'mitm',
      adapterId: null,
      method: 'GET',
      url: 'https://example.com/',
      host: 'example.com',
      path: '/',
      status: 200,
      durationMs: 1,
      reqHeaders: {},
      reqBody: null,
      resHeaders: {},
      resBody: JSON.stringify({
        ok: '^i',
        leak: '^this-is-user-content-not-a-label-and-is-long',
      }),
    },
  ]);
  const body = JSON.parse(cap!.resBody!);
  assert.equal(body.ok, '^i');
  assert.notEqual(body.leak, '^this-is-user-content-not-a-label-and-is-long');
  assert.equal(String(body.leak).length, '^this-is-user-content-not-a-label-and-is-long'.length);
});

test('loaderId pageLoadId navigationId survive scrubCapture', () => {
  const [cap] = scrubCaptures([
    {
      id: 'c',
      ts: 1_700_000_000_000,
      source: 'cdp',
      adapterId: null,
      method: 'GET',
      url: 'https://example.com/x',
      host: 'example.com',
      path: '/x',
      status: 200,
      durationMs: 1,
      reqHeaders: {},
      reqBody: null,
      resHeaders: {},
      resBody: null,
      loaderId: 'loader-abc',
      pageLoadId: 'page-xyz',
      navigationId: 'nav-123',
    },
  ]);
  assert.equal(cap!.loaderId, 'loader-abc');
  assert.equal(cap!.pageLoadId, 'page-xyz');
  assert.equal(cap!.navigationId, 'nav-123');
});

test('epoch-seconds numbers shift like epoch-ms', () => {
  const sec = 1_700_000_000;
  const [cap] = scrubCaptures([
    {
      id: 'c',
      ts: 1,
      source: 'mitm',
      adapterId: null,
      method: 'GET',
      url: 'https://example.com/',
      host: 'example.com',
      path: '/',
      status: 200,
      durationMs: 1,
      reqHeaders: {},
      reqBody: null,
      resHeaders: {},
      resBody: JSON.stringify({ t: sec, n: 42 }),
    },
  ]);
  const body = JSON.parse(cap!.resBody!);
  assert.equal(body.n, 42);
  assert.notEqual(body.t, sec);
  assert.equal(typeof body.t, 'number');
});

test('ISO date strings shift', () => {
  const iso = '2024-01-15T12:00:00.000Z';
  const [cap] = scrubCaptures([
    {
      id: 'c',
      ts: 1,
      source: 'mitm',
      adapterId: null,
      method: 'GET',
      url: 'https://example.com/',
      host: 'example.com',
      path: '/',
      status: 200,
      durationMs: 1,
      reqHeaders: {},
      reqBody: null,
      resHeaders: {},
      resBody: JSON.stringify({ when: iso }),
    },
  ]);
  const body = JSON.parse(cap!.resBody!);
  assert.notEqual(body.when, iso);
  assert.equal(String(body.when).length, iso.length);
});

