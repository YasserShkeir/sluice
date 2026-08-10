// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * app-trello tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The cookie decryption is macOS/Keychain-bound and is skipped off darwin rather
 * than failing; everything else here is pure.
 *
 * The shared invariants (never-throws, host lookalikes, seed ownership, secrets
 * resolved by value) come from `runConformance` at the bottom — this file only
 * pins what is specific to Trello.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, makeJsonCapture, runConformance } from '@sluice/adapter-sdk';
import type { Capture, Session } from '@sluice/core';
import {
  classifyTrelloCapture,
  parseTrelloCapture,
  trelloAdapter,
  trelloApp,
  trelloNextCursors,
} from './index.js';

/** A Trello capture; the SDK factory fills in everything a test is not about. */
function capture(over: Partial<Capture> = {}): Capture {
  return makeCapture({
    adapterId: 'trello',
    method: 'GET',
    url: 'https://trello.com/1/members/me/boards',
    host: 'trello.com',
    path: '/1/members/me/boards',
    ...over,
  });
}

/** A Trello JSON response from `path`, with the url derived rather than restated. */
const trelloJson = (path: string, body: unknown, over: Partial<Capture> = {}): Capture =>
  makeJsonCapture('trello.com', path, body, over);

const BOARD = '5f3a91c8e4b0a2d1f9c37e5b';
const OTHER_BOARD = '60b2e4d7a1c9f30e82b45a16';

const SESSION: Session = {
  id: 's1',
  adapterId: 'trello',
  label: 'Trello',
  credentials: {
    kind: 'trello-session',
    values: { cookieHeader: 'token=REAL_COOKIE_VALUE' },
    injection: { headers: { Cookie: 'cookieHeader' } },
  },
  discoveredAt: 0,
  source: 'local-store',
};

test('matchRequest claims trello hosts only', () => {
  const hit = (host: string) => trelloAdapter.matchRequest({ host, path: '/', method: 'GET', url: '' });
  assert.ok(hit('trello.com'));
  assert.ok(hit('api.trello.com'));
  assert.ok(!hit('slack.com'));
  assert.ok(!hit('trello.com.evil.test'));
});

test('parse never throws on a malformed or irrelevant body', () => {
  assert.doesNotThrow(() => parseTrelloCapture(capture({ resBody: '{not json' })));
  assert.doesNotThrow(() => parseTrelloCapture(capture({ resBody: null })));
  assert.doesNotThrow(() => parseTrelloCapture(capture({ host: 'example.com' })));
});

// ── parse ────────────────────────────────────────────────────────────────────────

test('a top-level boards array parses into containers', () => {
  // The regression: the only top-level array handled was a cards one, so
  // /1/members/me/boards — the endpoint classify calls `structure` and
  // nextCursors fans out from — parsed to nothing at all.
  const r = parseTrelloCapture(
    trelloJson('/1/members/me/boards', [
      { id: BOARD, name: 'Roadmap' },
      { id: OTHER_BOARD, name: 'Ops', prefs: { permissionLevel: 'private' } },
    ]),
  );
  assert.equal(r.items, undefined, 'a board is not a card');
  assert.deepEqual(
    r.containers?.map((c) => [c.id, c.kind, c.name, c.isPrivate]),
    [
      [BOARD, 'board', 'Roadmap', undefined],
      [OTHER_BOARD, 'board', 'Ops', true],
    ],
  );
});

test('a list or checklist is not recorded as a card', () => {
  // The regression: the single-object branch keyed on body shape, and every
  // Trello entity carries a string idBoard — so a board COLUMN was filed as a
  // card Item under the board's own id.
  for (const path of [`/1/lists/60aa11`, `/1/checklists/60aa11`]) {
    const r = parseTrelloCapture(
      trelloJson(path, { id: '60aa11', name: 'Doing', idBoard: BOARD, pos: 16384 }),
    );
    assert.equal(r.items, undefined, `${path} is not a card endpoint`);
    assert.equal(r.containers, undefined);
  }
});

test('a single card endpoint still parses into one item', () => {
  const r = parseTrelloCapture(
    trelloJson(`/1/cards/c1`, { id: 'c1', name: 'Ship it', idBoard: BOARD }),
  );
  assert.deepEqual(
    r.items?.map((i) => [i.id, i.text, i.containerId]),
    [['c1', 'Ship it', BOARD]],
  );
});

// ── classify ─────────────────────────────────────────────────────────────────────

test('classify labels the SPA as assets, not as unrecognized API calls', () => {
  // matchRequest is host-only, so every one of these is already attributed to
  // trello and pushed through parse(). Without this they read as endpoints the
  // adapter failed to handle.
  for (const path of ['/', '/b/abc123/my-board', '/app-1a2b3c.js', '/images/header.png']) {
    const got = classifyTrelloCapture(trelloJson(path, null));
    assert.equal(got.class, 'asset', `${path} is not an API call`);
    assert.equal(got.operation, 'asset', 'assets collapse to one operation on purpose');
  }
});

test('classify names each API shape it knows', () => {
  const cases: Array<[path: string, cls: string, operation: string]> = [
    ['/1/members/me', 'auth', 'members/me'],
    ['/1/members/me/boards', 'structure', 'members/me/boards'],
    ['/1/members/me/organizations', 'structure', 'members/me/organizations'],
    [`/1/boards/${BOARD}`, 'structure', 'boards/:id'],
    [`/1/board/${BOARD}`, 'structure', 'boards/:id'],
    [`/1/boards/${BOARD}/lists`, 'structure', 'boards/:id/lists'],
    ['/1/members/me/cards', 'messages', 'members/me/cards'],
    [`/1/boards/${BOARD}/cards`, 'messages', 'boards/:id/cards'],
    [`/1/lists/${BOARD}/cards`, 'messages', 'lists/:id/cards'],
    [`/1/cards/${BOARD}`, 'messages', 'cards/:id'],
    [`/1/boards/${BOARD}/actions`, 'messages', 'boards/:id/actions'],
    [`/1/cards/${BOARD}/actions`, 'messages', 'cards/:id/actions'],
  ];
  for (const [path, cls, operation] of cases) {
    const got = classifyTrelloCapture(trelloJson(path, []));
    assert.equal(got.class, cls, path);
    assert.equal(got.operation, operation, path);
  }
});

test('classify falls back to unknown for an unhandled /1/ endpoint', () => {
  const got = classifyTrelloCapture(trelloJson('/1/webhooks', []));
  assert.equal(got.class, 'unknown');
  // Still named: "which endpoints do we not handle yet" is the question.
  assert.equal(got.operation, 'webhooks');
});

test('classify reports a failure as an error but keeps the operation', () => {
  // 'error' alone cannot tell you WHICH call failed, which is the only thing
  // worth knowing about a 401 here.
  const got = classifyTrelloCapture(trelloJson('/1/members/me', {}, { status: 401 }));
  assert.equal(got.class, 'error');
  assert.equal(got.operation, 'members/me');
});

// ── nextCursors ──────────────────────────────────────────────────────────────────

test('a boards response fans out one seed per board', () => {
  const seeds = trelloNextCursors(
    trelloJson('/1/members/me/boards', [
      { id: BOARD, name: 'Roadmap' },
      { id: OTHER_BOARD, name: 'Ops' },
      { name: 'nameless and id-less' },
    ]),
  );
  assert.equal(seeds.length, 2);
  assert.deepEqual(
    seeds.map((s) => s.containerId),
    [BOARD, OTHER_BOARD],
  );
  for (const s of seeds) {
    assert.equal(s.actionId, 'trello.board.cards');
    assert.equal(s.reason, 'fanout', 'Trello has no cursor token — this is fan-out');
    assert.equal(s.params?.boardId, s.containerId);
    assert.equal(s.cursor, undefined);
  }
});

test('a cards response fans out one seed per DISTINCT board', () => {
  const seeds = trelloNextCursors(
    trelloJson('/1/members/me/cards', [
      { id: 'c1', idBoard: BOARD },
      { id: 'c2', idBoard: BOARD },
      { id: 'c3', idBoard: OTHER_BOARD },
      { id: 'c4' },
    ]),
  );
  assert.deepEqual(
    seeds.map((s) => s.containerId),
    [BOARD, OTHER_BOARD],
  );
  for (const s of seeds) assert.equal(s.actionId, 'trello.board.lists');
});

test('a card in a boards response is not fanned out from', () => {
  // The discriminator is a single field: a card carries a string idBoard, a
  // board does not. Seeding board/{cardId}/cards fetches nothing.
  const seeds = trelloNextCursors(
    trelloJson('/1/members/me/boards', [{ id: 'card1', idBoard: BOARD }]),
  );
  assert.deepEqual(seeds, []);
});

test('an actions feed at exactly `limit` yields a before-cursor seed', () => {
  const rows = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
  const seeds = trelloNextCursors(
    trelloJson(`/1/boards/${BOARD}/actions`, rows, {
      url: `https://trello.com/1/boards/${BOARD}/actions?limit=3`,
    }),
  );
  assert.equal(seeds.length, 1);
  const seed = seeds[0];
  assert.equal(seed?.actionId, 'trello.board.actions');
  assert.equal(seed?.containerId, BOARD);
  assert.equal(seed?.cursor, 'a3', 'the window is the id of the LAST row returned');
  assert.equal(seed?.reason, 'cursor');
  assert.equal(seed?.params?.boardId, BOARD);
});

test('a short actions feed yields nothing — a short page is the only exhaustion signal', () => {
  const seeds = trelloNextCursors(
    trelloJson(`/1/boards/${BOARD}/actions`, [{ id: 'a1' }, { id: 'a2' }], {
      url: `https://trello.com/1/boards/${BOARD}/actions?limit=3`,
    }),
  );
  assert.deepEqual(seeds, []);
});

test('a full actions feed above Trello’s cap still pages', () => {
  // The regression: `limit=5000` returns 1000 rows, and 1000 < 5000 read as
  // "exhausted" on the very first page of the busiest boards there are.
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` }));
  const seeds = trelloNextCursors(
    trelloJson(`/1/cards/${BOARD}/actions`, rows, {
      url: `https://trello.com/1/cards/${BOARD}/actions?limit=5000`,
    }),
  );
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]?.actionId, 'trello.card.actions');
  assert.equal(seeds[0]?.cursor, 'a999');
  assert.equal(seeds[0]?.params?.cardId, BOARD);
});

test('an errored response produces no work', () => {
  const seeds = trelloNextCursors(
    trelloJson('/1/members/me/boards', [{ id: BOARD, name: 'Roadmap' }], { status: 401 }),
  );
  assert.deepEqual(seeds, []);
});

test('every seed addresses a replay action this adapter actually has', () => {
  // A seed naming an action that does not exist is work nothing can ever run.
  const known = new Set(trelloAdapter.listReplayActions().map((a) => a.id));
  const bodies: Array<[string, unknown]> = [
    ['/1/members/me/boards', [{ id: BOARD, name: 'Roadmap' }]],
    ['/1/members/me/cards', [{ id: 'c1', idBoard: BOARD }]],
    [`/1/boards/${BOARD}/actions`, Array.from({ length: 50 }, (_, i) => ({ id: `a${i}` }))],
    [`/1/cards/${BOARD}/actions`, Array.from({ length: 50 }, (_, i) => ({ id: `b${i}` }))],
  ];
  let seen = 0;
  for (const [path, body] of bodies) {
    for (const s of trelloNextCursors(trelloJson(path, body))) {
      seen += 1;
      assert.ok(known.has(s.actionId), `${s.actionId} is not a Trello replay action`);
      assert.equal(s.adapterId, trelloAdapter.id);
    }
  }
  assert.equal(seen, 4, 'precondition: all four seed shapes were exercised');
});

// ── replay ───────────────────────────────────────────────────────────────────────

test('buildReplayRequest puts the session cookie in the Cookie header', () => {
  // The regression this guards: reading the credential via `injection` instead of
  // `values` emitted the literal string "cookieHeader" as the header value.
  const action = trelloAdapter.listReplayActions()[0];
  assert.ok(action, 'precondition: trello has a replay action');
  const req = trelloAdapter.buildReplayRequest(action, {}, SESSION);
  assert.equal(req.headers.Cookie, 'token=REAL_COOKIE_VALUE');
  assert.ok(req.headers['User-Agent'], 'browser-like headers are sent too');
});

test('a board-scoped action interpolates the id into the PATH', () => {
  // `new URL('…/boards/{boardId}/cards')` percent-encodes the braces, so a
  // template left to the query-string loop 404s on a url that looks right.
  const action = trelloAdapter.listReplayActions().find((a) => a.id === 'trello.board.cards');
  assert.ok(action, 'precondition: the fan-out target exists');
  const req = trelloAdapter.buildReplayRequest(action, { boardId: BOARD }, SESSION);
  const url = new URL(req.url);
  assert.equal(url.pathname, `/1/boards/${BOARD}/cards`);
  assert.equal(url.searchParams.get('boardId'), null, 'a path param is not also a query param');
  assert.ok(url.searchParams.get('fields'), 'the other params still ride in the query string');
});

test('a missing path param throws by name instead of building a broken url', () => {
  // The regression: substituting '' produced https://trello.com/1/boards//cards,
  // which Trello answers with a 404 that names nothing. onReplayRun passes the
  // UI's params straight through with no required check, so the UI reaches here.
  const action = trelloAdapter.listReplayActions().find((a) => a.id === 'trello.board.cards');
  assert.ok(action, 'precondition: the fan-out target exists');
  assert.throws(
    () => trelloAdapter.buildReplayRequest(action, {}, SESSION),
    /boardId/,
    'the error has to name the param the caller left out',
  );
  assert.throws(() => trelloAdapter.buildReplayRequest(action, { boardId: '' }, SESSION), /boardId/);
});

// ── app wiring ───────────────────────────────────────────────────────────────────

test('the app exposes a credential provider with a passive probe', () => {
  // doctor cannot verify an app without listWorkspaces, so a broken cookie would
  // stay invisible until a tool failed.
  assert.ok(trelloApp.credentials, 'trello authenticates, so it needs a provider');
  assert.equal(typeof trelloApp.credentials.listWorkspaces, 'function');
});

test('listWorkspaces is passive and never throws', { skip: process.platform !== 'darwin' }, async () => {
  const out = await trelloApp.credentials?.listWorkspaces?.();
  assert.ok(Array.isArray(out));
});

// ── the shared invariants ────────────────────────────────────────────────────────

runConformance(trelloApp, {
  session: SESSION,
  fixtures: [
    trelloJson('/1/members/me/boards', [{ id: BOARD, name: 'Roadmap' }]),
    trelloJson('/1/members/me/cards', [{ id: 'c1', name: 'Ship it', idBoard: BOARD }]),
    trelloJson(`/1/boards/${BOARD}`, { id: BOARD, name: 'Roadmap', prefs: { permissionLevel: 'private' } }),
    trelloJson(`/1/boards/${BOARD}/actions`, [{ id: 'a1', type: 'commentCard' }]),
    trelloJson('/app-1a2b3c.js', '(function(){})()'),
  ],
});
