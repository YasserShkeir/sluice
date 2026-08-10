// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Router tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * `parse` and `href` are pure and guard `typeof location`, so they run under
 * node:test with no DOM.
 *
 * The property that matters is the ROUND TRIP: every route the app can render
 * must survive `href` → `parse` unchanged. The app-detail page is reached by
 * URL — from a card, from a bookmark, from a reload — and a route that does not
 * round-trip sends the user to the overview with no error to explain why.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { href, parse } from './router.js';
import type { Route } from './router.js';

const ROUTES: Route[] = [
  { name: 'overview' },
  { name: 'traffic' },
  { name: 'apps' },
  { name: 'app', id: 'slack' },
  { name: 'data' },
];

test('every route round-trips through href and parse', () => {
  for (const route of ROUTES) {
    assert.deepEqual(parse(href(route)), route, `${href(route)} did not round-trip`);
  }
});

test('an app id needing escaping still resolves to its own page', () => {
  const route: Route = { name: 'app', id: 'google workspace/mail' };
  assert.equal(href(route), '/apps/google%20workspace%2Fmail');
  assert.deepEqual(parse(href(route)), route);
});

test('parse survives a malformed escape rather than blanking the page', () => {
  // decodeURIComponent throws on a lone '%'. Someone hand-editing the URL must
  // land on a page that says "unknown app", not on a crashed render.
  assert.deepEqual(parse('/apps/%zz'), { name: 'app', id: '%zz' });
});

test('parse ignores surrounding slashes so a trailing slash is not a new page', () => {
  assert.deepEqual(parse('/traffic/'), { name: 'traffic' });
  assert.deepEqual(parse('//apps//slack//'), { name: 'app', id: 'slack' });
  assert.deepEqual(parse(''), { name: 'overview' });
});

test('an unknown path lands on the overview instead of nothing', () => {
  assert.deepEqual(parse('/nope'), { name: 'overview' });
  assert.deepEqual(parse('/apps/slack/extra'), { name: 'app', id: 'slack' });
});
