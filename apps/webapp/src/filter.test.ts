// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Filter-language tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * Two properties carry most of the weight.
 *
 * PARSING IS TOTAL. This runs on every keystroke, so half-typed input is the
 * normal state: `dur:>`, `body:"unclosed`, `-`, `:` must all leave the table
 * usable. A parser that throws or that blanks the results mid-word makes the
 * box feel broken even though the eventual query is fine.
 *
 * AND, not OR. Every term must hold. That is what a search box trains people to
 * expect, and getting it backwards silently WIDENS a filter someone wrote to
 * narrow — the failure you would not notice until you trusted the result.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capture } from '@sluice/core';
import { formatFilter, isEmptyQuery, matchesFilter, parseFilter, serverSideTerms } from './filter.js';

function capture(over: Partial<Capture> = {}): Capture {
  return {
    id: 'c1',
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/conversations.history',
    host: 'slack.com',
    path: '/api/conversations.history',
    status: 200,
    durationMs: 120,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: '{"ok":true}',
    classification: 'conversations.history',
    ...over,
  };
}

const match = (input: string, over: Partial<Capture> = {}): boolean =>
  matchesFilter(capture(over), parseFilter(input));

// ── Parsing is total ─────────────────────────────────────────────────────────

test('no input at all yields a query that matches everything', () => {
  for (const input of ['', '   ', '\t\n']) {
    const q = parseFilter(input);
    assert.ok(isEmptyQuery(q));
    assert.equal(matchesFilter(capture(), q), true);
  }
});

test('half-typed input never throws and never blanks the table', () => {
  // Every one of these is a real intermediate state on the way to a valid query.
  for (const input of ['status:', 'dur:>', '-', ':', 'body:"unclosed', 'op:', '--', '>500', '"']) {
    const q = parseFilter(input);
    assert.doesNotThrow(() => matchesFilter(capture(), q), `threw on ${JSON.stringify(input)}`);
    if (isEmptyQuery(q)) {
      assert.equal(matchesFilter(capture(), q), true, `${JSON.stringify(input)} must not hide every row`);
    }
  }
});

test('an unknown field is reported, not silently dropped or fatal', () => {
  const q = parseFilter('nonsense:x status:200');
  assert.equal(q.errors.length, 1);
  assert.match(q.errors[0] ?? '', /nonsense/);
  assert.equal(q.terms.length, 1, 'the valid half of the query still applies');
  assert.equal(matchesFilter(capture(), q), true);
});

test('a comparison on a text field is refused with an explanation', () => {
  const q = parseFilter('host:>slack');
  assert.equal(q.terms.length, 0);
  assert.match(q.errors[0] ?? '', /text/);
});

test('a non-numeric comparison value is refused', () => {
  const q = parseFilter('dur:>abc');
  assert.equal(q.terms.length, 0);
  assert.match(q.errors[0] ?? '', /not a number/);
});

// ── Field matching ───────────────────────────────────────────────────────────

test('bare words search across every visible column', () => {
  assert.equal(match('slack'), true);
  assert.equal(match('conversations'), true);
  assert.equal(match('POST'), true);
  assert.equal(match('nothing-like-this'), false);
});

test('field terms match their own field only', () => {
  assert.equal(match('host:slack.com'), true);
  assert.equal(match('host:trello'), false);
  assert.equal(match('method:POST'), true);
  assert.equal(match('app:slack'), true);
  assert.equal(match('source:mitm'), true);
});

test('text matching is substring and case-insensitive', () => {
  // Someone typing host:slack means "slack somewhere in the host".
  assert.equal(match('host:SLACK'), true);
  assert.equal(match('op:HISTORY'), true);
});

test('globs anchor, so they can be precise where substring is not', () => {
  assert.equal(match('op:conversations.*'), true);
  assert.equal(match('op:users.*'), false);
  assert.equal(match('op:*.history'), true);
  assert.equal(match('op:conversations.history'), true);
});

test('a glob metacharacter in a value is not a regex injection', () => {
  // The value goes into a RegExp, so an unescaped `(` would throw at match time
  // — on a keystroke, in the middle of typing.
  for (const input of ['op:conv(ersations', 'host:a+b', 'path:[x]', 'op:a|b', 'text:$^']) {
    assert.doesNotThrow(() => matchesFilter(capture(), parseFilter(input)), `threw on ${input}`);
  }
  assert.equal(match('op:a+b*'), false, 'a literal + must not act as a quantifier');
});

test('a literal space inside a glob stays literal', () => {
  // The escape-then-substitute approach needs a placeholder for `*`, and a space
  // placeholder turns the user's own space into a second wildcard.
  const q = parseFilter('body:"a b*c"');
  assert.equal(matchesFilter(capture({ resBody: 'a b--c' }), q), true);
  assert.equal(matchesFilter(capture({ resBody: 'aXbXc' }), q), false, 'the space must not match anything');
});

// ── Numbers ──────────────────────────────────────────────────────────────────

test('status matches exactly, and by class', () => {
  assert.equal(match('status:200'), true);
  assert.equal(match('status:429'), false);
  assert.equal(match('status:2xx'), true);
  assert.equal(match('status:4xx'), false);
  assert.equal(match('status:4xx', { status: 429 }), true);
  assert.equal(match('status:5XX', { status: 503 }), true, 'the class is case-insensitive');
});

test('comparisons work on the numeric fields', () => {
  assert.equal(match('dur:>100'), true);
  assert.equal(match('dur:>1500'), false);
  assert.equal(match('dur:<200'), true);
  assert.equal(match('dur:>=120'), true);
  assert.equal(match('dur:<=120'), true);
  assert.equal(match('status:>=400', { status: 429 }), true);
});

test('a null numeric field never matches a comparison', () => {
  // A WebSocket frame has no status and no duration. Treating null as 0 would
  // sweep every frame into `status:<400`, which reads as a real result.
  assert.equal(match('dur:>0', { durationMs: null }), false);
  assert.equal(match('dur:<10000', { durationMs: null }), false);
  assert.equal(match('status:<400', { status: null }), false);
});

test('size measures both bodies', () => {
  assert.equal(match('size:>5', { resBody: 'x'.repeat(10) }), true);
  assert.equal(match('size:>100', { resBody: 'x'.repeat(10) }), false);
  assert.equal(match('size:>5', { reqBody: 'x'.repeat(10), resBody: null }), true);
});

// ── Composition ──────────────────────────────────────────────────────────────

test('terms are ANDed, never ORed', () => {
  // Getting this backwards silently WIDENS a filter written to narrow.
  assert.equal(match('app:slack status:200'), true);
  assert.equal(match('app:slack status:429'), false);
  assert.equal(match('app:trello status:200'), false);
});

test('negation subtracts', () => {
  assert.equal(match('-app:trello'), true);
  assert.equal(match('-app:slack'), false);
  assert.equal(match('-op:client.counts'), true);
  assert.equal(match('status:2xx -op:conversations.*'), false);
});

test('a negated term on a field the row lacks still matches', () => {
  // "not a trello row" is true of a row with no app at all — the alternative
  // makes -app:trello silently hide every unclassified capture.
  assert.equal(match('-app:trello', { adapterId: null }), true);
});

test('quoted values may contain spaces', () => {
  const q = parseFilter('body:"rate limited"');
  assert.equal(q.terms[0]?.value, 'rate limited');
  assert.equal(matchesFilter(capture({ resBody: 'the API said rate limited' }), q), true);
  assert.equal(matchesFilter(capture({ resBody: 'ratelimited' }), q), false);
});

test('the documented example query parses to exactly its five terms', () => {
  const q = parseFilter('status:429 op:conversations.* dur:>1500 body:"not_in_channel" -op:client.counts');
  assert.deepEqual(q.errors, []);
  assert.deepEqual(
    q.terms.map((t) => [t.field, t.comparator, t.value, t.negated]),
    [
      ['status', '=', '429', false],
      ['op', '=', 'conversations.*', false],
      ['dur', '>', '1500', false],
      ['body', '=', 'not_in_channel', false],
      ['op', '=', 'client.counts', true],
    ],
  );
});

test('field aliases resolve to the canonical field', () => {
  assert.equal(parseFilter('adapter:slack').terms[0]?.field, 'app');
  assert.equal(parseFilter('duration:>10').terms[0]?.field, 'dur');
  assert.equal(parseFilter('code:429').terms[0]?.field, 'status');
});

// ── Server-side handoff ──────────────────────────────────────────────────────

test('body terms are flagged for the server, because the client window is partial', () => {
  // The WS backfill is a bounded window, so answering body: from it silently
  // answers a different question than the one asked.
  const q = parseFilter('status:429 body:not_in_channel -body:noise');
  const server = serverSideTerms(q);
  assert.equal(server.length, 1);
  assert.equal(server[0]?.value, 'not_in_channel');
  assert.equal(serverSideTerms(parseFilter('status:429')).length, 0);
});

test('a query round-trips through formatFilter', () => {
  const input = 'status:429 op:conversations.* dur:>1500 -op:client.counts';
  assert.equal(formatFilter(parseFilter(input)), input);
  assert.equal(formatFilter(parseFilter('body:"rate limited"')), 'body:"rate limited"');
});
