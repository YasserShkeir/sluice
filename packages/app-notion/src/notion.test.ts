// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * app-notion tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * Every fixture below is the SHAPE of a real response from a live workspace —
 * the same field names and nesting, with the ids and text replaced. Guessed
 * shapes are the failure mode this package exists to avoid, so a fixture that
 * drifts from the service is a bug here, not a test to relax.
 *
 * Cookie decryption is macOS/Keychain-bound and is skipped off darwin rather
 * than failing; everything else here is pure.
 *
 * The shared invariants (never-throws, host lookalikes, seed ownership, secrets
 * resolved by value) come from `runConformance` at the bottom — this file only
 * pins what is specific to Notion.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, makeJsonCapture, runConformance } from '@sluice/adapter-sdk';
import type { Capture, ParseResult, Session } from '@sluice/core';
import {
  classifyNotionCapture,
  notionAdapter,
  notionApp,
  notionNextCursors,
  parseNotionCapture,
  plainText,
  reconcileNotion,
  recordValue,
  toPageId,
} from './index.js';

const SPACE = '308d7257-5d64-49b2-a688-e9b8be83433f';
const USER = 'c2bcad04-5d6c-4207-a594-1767a4cd95d8';
const PAGE = '7bf74c6f-dcff-4013-a680-bf4fd4e5a048';
const CHILD = '28bef5e0-60d9-4d48-86f3-93c3da361b91';
const DB = '944a9618-5f3a-41a3-92d4-ebec167433a1';
const VIEW = 'c94f8e36-82b4-4147-868c-b20b13193a49';
const ROW = 'daddb957-afff-4603-9c59-77b042067e01';
const TEAM = '2a06306b-b53e-456b-9bd4-ed0b2d7d4188';
const DISCUSSION = '9b386453-7d7a-4ae3-ab3b-e5f2b61dadae';
const COMMENT = '26be673b-4818-4c87-9bf9-b9b4a158b8a1';
const ROW2 = 'daddb957-afff-4603-9c59-77b042067e02';
const ROW3 = 'daddb957-afff-4603-9c59-77b042067e03';
/** The shape Notion stores a person filter in — `query2.filter` on the view record. */
const VIEW_FILTER = {
  operator: 'and',
  filters: [
    {
      property: 'notion://tasks/assign_property',
      filter: { operator: 'person_contains', value: { type: 'exact', value: { id: USER, table: 'notion_user' } } },
    },
  ],
};
const VIEW_SORT = [{ property: 'notion://tasks/due_date_property', direction: 'ascending' }];

const SESSION: Session = {
  id: 's1',
  adapterId: 'notion',
  label: 'Notion',
  credentials: {
    kind: 'notion-session',
    values: { cookieHeader: 'token_v2=REAL_COOKIE_VALUE', activeUserId: USER },
    injection: { headers: { Cookie: 'cookieHeader', 'x-notion-active-user-header': 'activeUserId' } },
  },
  discoveredAt: 0,
  source: 'local-store',
};

/** Notion's wrapper: `{ spaceId, value: { value: <record>, role } }`. */
const wrap = (record: Record<string, unknown>, spaceId = SPACE) => ({
  spaceId,
  value: { role: 'editor', value: record },
});

/** A Notion API response from `operation`, with the url derived rather than restated. */
const notionJson = (operation: string, body: unknown, over: Partial<Capture> = {}): Capture =>
  makeJsonCapture('app.notion.com', `/api/v3/${operation}`, body, { method: 'POST', ...over });

const PAGE_CHUNK = {
  cursor: { stack: [] },
  recordMap: {
    __version__: 3,
    block: {
      [PAGE]: wrap({
        id: PAGE,
        type: 'page',
        properties: { title: [['Launch checklist']] },
        content: [CHILD],
        parent_id: TEAM,
        parent_table: 'team',
        created_by_id: USER,
        created_time: 1_757_000_000_000,
        last_edited_time: 1_757_500_000_000,
        space_id: SPACE,
        alive: true,
      }),
      [CHILD]: wrap({
        id: CHILD,
        type: 'page',
        properties: { title: [['Rollout notes']] },
        parent_id: PAGE,
        parent_table: 'block',
        created_by_id: USER,
        last_edited_time: 1_757_400_000_000,
        space_id: SPACE,
      }),
      'b1000000-0000-4000-8000-000000000001': wrap({
        id: 'b1000000-0000-4000-8000-000000000001',
        type: 'collection_view',
        collection_id: DB,
        view_ids: [VIEW],
        parent_id: PAGE,
        parent_table: 'block',
        space_id: SPACE,
      }),
    },
    collection: {
      [DB]: wrap({
        id: DB,
        name: [['Project plans']],
        schema: { title: { name: 'Name', type: 'title' }, _SiA: { name: 'Status', type: 'select' } },
        parent_id: PAGE,
        space_id: SPACE,
      }),
    },
    collection_view: {
      [VIEW]: wrap({
        id: VIEW,
        type: 'board',
        name: 'My tasks',
        parent_id: 'b1000000-0000-4000-8000-000000000001',
        query2: { filter: VIEW_FILTER, sort: VIEW_SORT },
        space_id: SPACE,
      }),
    },
    notion_user: {
      [USER]: wrap({ id: USER, email: 'someone@example.com', name: 'Some One' }),
    },
    discussion: {
      [DISCUSSION]: wrap({ id: DISCUSSION, parent_id: PAGE, parent_table: 'block', resolved: false }),
    },
    comment: {
      [COMMENT]: wrap({
        id: COMMENT,
        parent_id: DISCUSSION,
        parent_table: 'discussion',
        text: [['‣', [['u', USER]]], [' looks good to me']],
        created_by_id: USER,
        created_time: 1_757_300_000_000,
        space_id: SPACE,
      }),
    },
  },
};

const USER_CONTENT = {
  recordMap: {
    __version__: 3,
    space: {
      [SPACE]: wrap({ id: SPACE, name: 'Example Space', pages: [PAGE], icon: '🧪' }),
    },
    team: {
      [TEAM]: wrap({ id: TEAM, space_id: SPACE, name: 'Operations', team_pages: [PAGE, CHILD] }),
    },
    space_user: {
      [`${USER}|${SPACE}`]: wrap({
        id: `${USER}|${SPACE}`,
        user_id: USER,
        space_id: SPACE,
        membership_type: 'member',
      }),
    },
    notion_user: { [USER]: wrap({ id: USER, email: 'someone@example.com', name: 'Some One' }) },
  },
};

const COLLECTION_ROWS = {
  result: {
    type: 'reducer',
    reducerResults: { collection_group_results: { type: 'results', blockIds: [ROW], hasMore: false } },
  },
  recordMap: {
    __version__: 3,
    block: {
      [ROW]: wrap({
        id: ROW,
        type: 'page',
        parent_id: DB,
        parent_table: 'collection',
        properties: { title: [['Export fails on large files']], _SiA: [['Draft']] },
        created_by_id: USER,
        last_edited_time: 1_757_200_000_000,
        space_id: SPACE,
      }),
    },
  },
};

// ── matching ─────────────────────────────────────────────────────────────────────

test('matchRequest claims both Notion domains and rejects lookalikes', () => {
  const hit = (host: string) => notionAdapter.matchRequest({ host, path: '/', method: 'POST', url: '' });
  assert.ok(hit('notion.com'));
  assert.ok(hit('app.notion.com'));
  assert.ok(hit('notion.so'));
  assert.ok(hit('www.notion.so'));
  assert.ok(hit('msgstore-001.app.notion.com'));
  // The lookalikes the conformance probe generates, and the one a careless
  // `includes('notion')` would claim.
  assert.equal(hit('notnotion.com'), false);
  assert.equal(hit('notion.com.evil.test'), false);
  assert.equal(hit('mynotion.so'), false);
});

// ── the recordMap envelope ───────────────────────────────────────────────────────

test('recordValue unwraps both nestings Notion ships', () => {
  const record = { id: PAGE, type: 'page' };
  assert.deepEqual(recordValue({ spaceId: SPACE, value: { value: record, role: 'editor' } }), record);
  // The older single-hop shape. A parser that hardcoded `.value.value` returned
  // undefined for every record here — silently, as zero entities.
  assert.deepEqual(recordValue({ role: 'editor', value: record }), record);
  assert.equal(recordValue({ value: { value: { noId: true } } }), undefined);
  assert.equal(recordValue(null), undefined);
});

test('plainText flattens rich text and names mentions instead of dropping them', () => {
  assert.equal(plainText([['Hello '], ['world', [['b']]]]), 'Hello world');
  // Bare `‣` would turn "@someone approved this" into " approved this".
  assert.equal(plainText([['‣', [['u', USER]]], [' approved']]), `@user:${USER} approved`);
  assert.equal(plainText([['‣', [['p', PAGE, SPACE]]]]), `@page:${PAGE}`);
  assert.equal(plainText('not an array'), '');
  assert.equal(plainText(undefined), '');
});

// ── parsing ──────────────────────────────────────────────────────────────────────

test('a page chunk yields pages, the database, its author and its comments', () => {
  const out = parseNotionCapture(notionJson('loadPageChunk', PAGE_CHUNK));

  const pages = (out.items ?? []).filter((i) => i.kind === 'page');
  assert.deepEqual(
    pages.map((p) => p.id).sort(),
    [CHILD, PAGE].sort(),
    'both page blocks become items; the collection_view block does not',
  );

  const page = pages.find((p) => p.id === PAGE);
  assert.equal(page?.text, 'Launch checklist');
  assert.equal(page?.containerId, TEAM, 'containerId is the parent whatever table it points at');
  assert.equal(page?.workspaceId, SPACE);
  assert.equal(page?.ts, 1_757_500_000_000, 'last_edited_time wins over created_time');

  const db = (out.containers ?? []).find((c) => c.id === DB);
  assert.equal(db?.kind, 'board');
  assert.equal(db?.name, 'Project plans', "a collection's name is rich text, not a string");
  assert.equal(db?.itemCount, undefined, 'a collection record does not know its row count');

  const comment = (out.items ?? []).find((i) => i.kind === 'message');
  assert.equal(comment?.id, COMMENT);
  assert.equal(comment?.text, `@user:${USER} looks good to me`);
  assert.equal(comment?.threadId, DISCUSSION);

  const actor = (out.actors ?? []).find((a) => a.id === USER);
  assert.equal(actor?.handle, 'someone@example.com', 'email is the cross-service join key');

  const discussionEdge = (out.edges ?? []).find((e) => e.rel === 'discussion-on');
  assert.equal(discussionEdge?.dstId, PAGE, 'the discussion is what names the page a comment sits on');
});

test('a database row is parsed as a page inside its database', () => {
  const out = parseNotionCapture(notionJson('queryCollection', COLLECTION_ROWS));
  const row = (out.items ?? [])[0];
  assert.equal(row?.id, ROW);
  assert.equal(row?.kind, 'page', 'Notion stores a row as a page block — same code path');
  assert.equal(row?.containerId, DB);
  assert.equal(row?.text, 'Export fails on large files');
});

test('loadUserContent yields the space, its teamspaces and membership', () => {
  const out = parseNotionCapture(notionJson('loadUserContent', USER_CONTENT));
  assert.deepEqual((out.workspaces ?? []).map((w) => w.name), ['Example Space']);

  const team = (out.containers ?? []).find((c) => c.id === TEAM);
  assert.equal(team?.kind, 'group');
  assert.equal(team?.itemCount, 2, 'a teamspace does know how many root pages it holds');

  // space_user carries no name or email: parsing it as an Actor would shadow the
  // real profile with a uuid-handled ghost.
  assert.equal((out.actors ?? []).length, 1);
  const member = (out.edges ?? []).find((e) => e.rel === 'member-of');
  assert.equal(member?.srcId, USER);
  assert.equal(member?.dstId, SPACE);
});

test('getVisibleUsers is the roster, and its space id comes from the request', () => {
  // 124 people here against the 4 that appear across every page chunk put
  // together: a notion_user record only rides along when that person wrote
  // something, so without this branch the roster is whoever happened to comment.
  const capture = notionJson(
    'getVisibleUsers',
    {
      users: [
        { userId: USER, aliases: ['someone@example.com'], membershipType: 'member', isPageGuest: false },
        { userId: 'u2', aliases: ['guest@example.com'], membershipType: 'page_guest', isPageGuest: true },
        { aliases: ['nobody@example.com'] },
      ],
      joinedMemberIds: [],
    },
    // The response never names the space — only the request does.
    { reqBody: JSON.stringify({ spaceId: SPACE, supportsEdgeCache: false }) },
  );
  const out = parseNotionCapture(capture);
  assert.equal((out.actors ?? []).length, 2, 'a row with no userId is skipped, not guessed at');
  const actor = (out.actors ?? []).find((a) => a.id === USER);
  assert.equal(actor?.handle, 'someone@example.com');
  assert.equal(actor?.workspaceId, SPACE);
  assert.equal(actor?.displayName, undefined, 'no name in this payload — do not invent one');

  const guest = (out.edges ?? []).find((e) => e.srcId === 'u2');
  assert.equal(guest?.rel, 'member-of');
  // Keeping the membership type is what separates teammates from people who
  // merely hold a share link.
  assert.equal((guest?.raw as { membershipType?: string })?.membershipType, 'page_guest');

  // No spaceId anywhere = nothing to attach the roster to. Filing it under a
  // guessed workspace is not recoverable.
  assert.deepEqual(parseNotionCapture(notionJson('getVisibleUsers', { users: [{ userId: USER }] })), {});
});

test('parse survives bodies it does not recognise', () => {
  for (const body of ['', 'null', '[]', '"a string"', '{"recordMap":null}', '{"recordMap":{"block":7}}']) {
    assert.doesNotThrow(() =>
      parseNotionCapture(makeCapture({ host: 'app.notion.com', path: '/api/v3/loadPageChunk', resBody: body })),
    );
  }
  assert.deepEqual(parseNotionCapture(notionJson('loadPageChunk', { recordMap: { __version__: 3 } })), {});
});

test('a static asset on the app host parses to nothing', () => {
  // app.notion.com serves the SPA and the API from one host, so parse sees the
  // bundles too and must not try to read them.
  const out = parseNotionCapture(makeJsonCapture('app.notion.com', '/icons/home_orange.svg', {}));
  assert.deepEqual(out, {});
});

// ── reconciliation ───────────────────────────────────────────────────────────────

test('reconcile gives each person both halves of their identity', () => {
  // Notion never sends the email and the name in the same capture: the roster
  // knows `aliases`, a notion_user record sends `email: ""` and knows the name.
  // Whichever parses last wins the row, so 124 people ended up with 122 names
  // and 2 emails — and email is what joins this person to Slack and Trello.
  const roster = notionJson(
    'getVisibleUsers',
    { users: [{ userId: USER, aliases: ['someone@example.com'], membershipType: 'member' }] },
    { reqBody: JSON.stringify({ spaceId: SPACE }) },
  );
  const profile = notionJson('syncRecordValues', {
    recordMap: {
      __version__: 3,
      notion_user: { [USER]: wrap({ id: USER, email: '', name: 'Some One' }) },
    },
  });

  // Parsed in the order that loses: the profile lands after the roster.
  const beforeRoster = parseNotionCapture(roster).actors?.[0];
  const beforeProfile = parseNotionCapture(profile).actors?.[0];
  assert.equal(beforeRoster?.handle, 'someone@example.com');
  assert.equal(beforeProfile?.handle, USER, 'an empty email must not become the handle');
  assert.equal(beforeProfile?.displayName, 'Some One');

  const applied: ParseResult[] = [];
  const store = {
    listWorkspaces: () => [],
    listCaptures: () => [roster, profile],
    queryItems: () => [],
    applyParseResult: (pr: ParseResult) => applied.push(pr),
    deleteWorkspace: () => undefined,
  };

  const outcome = reconcileNotion(store);
  assert.equal(outcome.changed, 1);
  const merged = applied[0]?.actors?.[0];
  assert.equal(merged?.handle, 'someone@example.com', 'the email survives');
  assert.equal(merged?.displayName, 'Some One', 'and so does the name');
  assert.equal(merged?.workspaceId, SPACE);

  // Idempotent: same captures in, same row out.
  reconcileNotion(store);
  assert.deepEqual(applied[1]?.actors?.[0], merged);
});

test('reconcile does nothing when there is nothing to settle', () => {
  const store = {
    listWorkspaces: () => [],
    listCaptures: () => [],
    queryItems: () => [],
    applyParseResult: () => {
      throw new Error('reconcile must not write when it learned nothing');
    },
    deleteWorkspace: () => undefined,
  };
  assert.deepEqual(reconcileNotion(store), { changed: 0 });
});

// ── classification ───────────────────────────────────────────────────────────────

test('classify separates the API from the SPA, and names the operation', () => {
  assert.deepEqual(classifyNotionCapture(notionJson('loadPageChunk', PAGE_CHUNK)), {
    class: 'messages',
    operation: 'loadPageChunk',
  });
  assert.equal(classifyNotionCapture(notionJson('loadUserContent', USER_CONTENT)).class, 'structure');
  assert.equal(classifyNotionCapture(notionJson('ping', {})).class, 'asset');
  assert.equal(
    classifyNotionCapture(makeJsonCapture('app.notion.com', '/icons/home_orange.svg', {})).class,
    'asset',
  );
});

test('classify catches the HTTP-200 failure Notion answers with', () => {
  // A `queryCollection` reducer key Notion does not recognise comes back 200
  // with an empty recordMap — which otherwise reads as an empty database.
  const c = notionJson('queryCollection', { isNotionError: true, name: 'ValidationError', message: 'bad loader' });
  assert.equal(classifyNotionCapture(c).class, 'error');
  assert.deepEqual(notionNextCursors(c), [], 'an error response is not more work');
});

// ── fan-out ──────────────────────────────────────────────────────────────────────

test('a page chunk fans out to child pages and to each database view', () => {
  const seeds = notionNextCursors(
    notionJson('loadPageChunk', PAGE_CHUNK, { reqBody: JSON.stringify({ pageId: PAGE }) }),
  );
  const ids = seeds.map((s) => s.actionId);
  assert.ok(ids.includes('notion.collection.query'));
  assert.ok(ids.includes('notion.page.chunk'));

  const pageIds = seeds.filter((s) => s.actionId === 'notion.page.chunk').map((s) => s.containerId);
  assert.deepEqual(pageIds, [CHILD], 'the page we just fetched is not re-seeded');

  const view = seeds.find((s) => s.actionId === 'notion.collection.query');
  assert.equal(view?.params?.collectionId, DB);
  assert.equal(view?.params?.viewId, VIEW, 'a seed with no view id could only ever fail');
  assert.equal(view?.reason, 'fanout', 'Notion has no page cursor anywhere in its read API');
});

test('loadUserContent fans out to the space and teamspace root pages', () => {
  const seeds = notionNextCursors(notionJson('loadUserContent', USER_CONTENT));
  assert.deepEqual(
    seeds.map((s) => s.containerId).sort(),
    [CHILD, PAGE].sort(),
    'root pages are the only entry points no page chunk reaches on its own',
  );
});

test('a rate-limited read is re-seeded, not treated as a leaf', () => {
  // Notion answers 429 freely and with no body, so a rate-limited page looks
  // exactly like a page with no children. Dropping it discards every subtree
  // underneath: a crawl of one workspace took 5,477 of these against 421
  // successes, and the difference does not show up as an error anywhere.
  const limited = notionJson(
    'loadPageChunk',
    { isNotionError: true, name: 'UserRateLimitResponse', message: 'Something went wrong. (429)' },
    { status: 429, reqBody: JSON.stringify({ pageId: PAGE }) },
  );
  const seeds = notionNextCursors(limited);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]?.actionId, 'notion.page.chunk');
  assert.equal(seeds[0]?.containerId, PAGE, 'the retry is for the page we were refused');
  assert.equal(seeds[0]?.reason, 'cursor', 'a retry is not a new fan-out');

  const limitedView = notionJson('queryCollection', {}, {
    status: 429,
    reqBody: JSON.stringify({ source: { id: DB, spaceId: SPACE }, collectionView: { id: VIEW } }),
  });
  assert.deepEqual(notionNextCursors(limitedView)[0]?.params, {
    collectionId: DB,
    viewId: VIEW,
    spaceId: SPACE,
  });

  // A 400 is not a retry — asking again gets the same answer and burns a call.
  const invalid = notionJson('queryCollection', { isNotionError: true, name: 'ValidationError' }, {
    status: 400,
    reqBody: JSON.stringify({ source: { id: DB }, collectionView: { id: VIEW } }),
  });
  assert.deepEqual(notionNextCursors(invalid), []);
});

test('a view seed carries the filter and sort the view itself applies', () => {
  // Verified live: `collectionView.id` alone scopes nothing. Two views of one
  // database — "All" and a board pinned to one assignee — returned identical
  // rows until the view's own query2 travelled with the request.
  const seeds = notionNextCursors(
    notionJson('loadPageChunk', PAGE_CHUNK, { reqBody: JSON.stringify({ pageId: PAGE }) }),
  );
  const view = seeds.find((s) => s.actionId === 'notion.collection.query');
  assert.ok(view?.params?.filter, 'the filter must travel with the seed');
  assert.deepEqual(JSON.parse(view.params.filter), VIEW_FILTER);
  assert.deepEqual(JSON.parse(view.params?.sort ?? '[]'), VIEW_SORT);
});

test('a view with no filter or sort seeds without them', () => {
  const plain = structuredClone(PAGE_CHUNK) as typeof PAGE_CHUNK;
  plain.recordMap.collection_view[VIEW] = wrap({ id: VIEW, type: 'table', name: 'All', query2: { filter: { filters: [], operator: 'and' }, sort: [] } });
  const seeds = notionNextCursors(notionJson('loadPageChunk', plain));
  const view = seeds.find((s) => s.actionId === 'notion.collection.query');
  assert.equal(view?.params?.filter, undefined, 'an empty filter is absent, not "{}"');
  assert.equal(view?.params?.sort, undefined);
});

test('rows a collection query names but does not deliver are seeded for a record sync', () => {
  // Notion inlines at most 1,000 row records however large the limit, while
  // blockIds lists every row and hasMore stays false: 1,462 named against
  // 1,000 delivered on one database. The undelivered rows have to be asked
  // for by id, and nothing did.
  const truncated = structuredClone(COLLECTION_ROWS) as typeof COLLECTION_ROWS;
  truncated.result.reducerResults.collection_group_results.blockIds = [ROW, ROW2, ROW3];
  const capture = notionJson('queryCollection', truncated, {
    reqBody: JSON.stringify({ source: { type: 'collection', id: DB, spaceId: SPACE }, collectionView: { id: VIEW } }),
  });
  const seeds = notionNextCursors(capture);
  const sync = seeds.filter((s) => s.actionId === 'notion.records.sync');
  assert.equal(sync.length, 1, 'one batch for two missing rows');
  assert.equal(sync[0]?.containerId, DB);
  assert.equal(sync[0]?.params?.ids, `${ROW2},${ROW3}`, 'only the rows the recordMap lacks');
  assert.equal(sync[0]?.params?.spaceId, SPACE);
  assert.equal(sync[0]?.cursor, ROW2, 'a distinct cursor per batch, or the worklist collapses them');
  assert.equal(sync[0]?.reason, 'cursor', 'the rest of this read, not new fan-out');
  // The delivered row still fans out as a page.
  assert.ok(seeds.some((s) => s.actionId === 'notion.page.chunk' && s.containerId === ROW));

  const complete = notionJson('queryCollection', COLLECTION_ROWS, {
    reqBody: JSON.stringify({ source: { id: DB }, collectionView: { id: VIEW } }),
  });
  assert.equal(
    notionNextCursors(complete).filter((s) => s.actionId === 'notion.records.sync').length,
    0,
    'a fully delivered answer seeds no record syncs',
  );
});

test('a rate-limited record sync is re-seeded with the same ids', () => {
  const limited = notionJson('syncRecordValues', {}, {
    status: 429,
    reqBody: JSON.stringify({
      requests: [
        { pointer: { table: 'block', id: ROW2, spaceId: SPACE }, version: -1 },
        { pointer: { table: 'block', id: ROW3, spaceId: SPACE }, version: -1 },
      ],
    }),
  });
  const seeds = notionNextCursors(limited);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]?.actionId, 'notion.records.sync');
  assert.equal(seeds[0]?.params?.ids, `${ROW2},${ROW3}`);
  assert.equal(seeds[0]?.params?.spaceId, SPACE);
});

test('every seed names an action the adapter actually offers', () => {
  const known = new Set(notionAdapter.listReplayActions().map((a) => a.id));
  for (const body of [PAGE_CHUNK, USER_CONTENT, COLLECTION_ROWS]) {
    for (const seed of notionNextCursors(notionJson('loadPageChunk', body))) {
      assert.ok(known.has(seed.actionId), `${seed.actionId} is not a replay action`);
      assert.notEqual(seed.cursor, '', 'an empty cursor re-fetches page one forever');
    }
  }
});

// ── replay ───────────────────────────────────────────────────────────────────────

test('a replay request carries the cookie and the three notion client headers', () => {
  const action = notionAdapter.listReplayActions().find((a) => a.id === 'notion.page.chunk');
  assert.ok(action);
  const req = notionAdapter.buildReplayRequest(action, { pageId: PAGE, spaceId: SPACE }, SESSION);

  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://app.notion.com/api/v3/loadPageChunk');
  assert.equal(req.headers.Cookie, 'token_v2=REAL_COOKIE_VALUE');
  assert.equal(req.headers['notion-audit-log-platform'], 'web');
  // Without this header Notion picks an account when the jar holds several —
  // it does not fail, it answers as somebody else.
  assert.equal(req.headers['x-notion-active-user-header'], USER);
  assert.equal(req.headers['x-notion-space-id'], SPACE);
  assert.deepEqual(JSON.parse(req.body ?? '{}'), {
    pageId: PAGE,
    limit: 100,
    cursor: { stack: [] },
    chunkNumber: 0,
    verticalColumns: false,
  });
});

test('the collection query sends a loader Notion recognises', () => {
  const action = notionAdapter.listReplayActions().find((a) => a.id === 'notion.collection.query');
  assert.ok(action);
  const req = notionAdapter.buildReplayRequest(action, { collectionId: DB, viewId: VIEW, spaceId: SPACE }, SESSION);
  const body = JSON.parse(req.body ?? '{}') as {
    source: { id: string };
    collectionView: { id: string };
    loader: { type: string; reducers: { collection_group_results: { type: string; limit: number } } };
  };
  assert.equal(body.source.id, DB);
  assert.equal(body.collectionView.id, VIEW);
  // An unrecognised reducer key returns 200 + isNotionError with an empty
  // recordMap, which is indistinguishable from an empty database.
  assert.equal(body.loader.type, 'reducer');
  assert.equal(body.loader.reducers.collection_group_results.type, 'results');
  assert.equal(body.loader.reducers.collection_group_results.limit, 200);
});

test('the collection query forwards the view filter and sort it was given', () => {
  const action = notionAdapter.listReplayActions().find((a) => a.id === 'notion.collection.query');
  assert.ok(action);
  const withQuery = JSON.parse(
    notionAdapter.buildReplayRequest(
      action,
      { collectionId: DB, viewId: VIEW, filter: JSON.stringify(VIEW_FILTER), sort: JSON.stringify(VIEW_SORT) },
      SESSION,
    ).body ?? '{}',
  ) as { loader: { filter?: unknown; sort: unknown } };
  assert.deepEqual(withQuery.loader.filter, VIEW_FILTER, 'the filter rides in the loader, where the client puts it');
  assert.deepEqual(withQuery.loader.sort, VIEW_SORT);

  const without = JSON.parse(
    notionAdapter.buildReplayRequest(action, { collectionId: DB, viewId: VIEW }, SESSION).body ?? '{}',
  ) as { loader: { filter?: unknown; sort: unknown } };
  assert.equal('filter' in without.loader, false, 'no filter param, no filter key');
  assert.deepEqual(without.loader.sort, []);

  // Garbage in a JSON param is dropped, not thrown: a seed must never build a
  // request that can only fail.
  const garbage = JSON.parse(
    notionAdapter.buildReplayRequest(action, { collectionId: DB, viewId: VIEW, filter: '{not json' }, SESSION).body ?? '{}',
  ) as { loader: { filter?: unknown } };
  assert.equal('filter' in garbage.loader, false);
});

test('a record sync accepts a batch of ids', () => {
  const action = notionAdapter.listReplayActions().find((a) => a.id === 'notion.records.sync');
  assert.ok(action);
  const body = JSON.parse(
    notionAdapter.buildReplayRequest(action, { ids: `${ROW2}, ${ROW3}`, spaceId: SPACE }, SESSION).body ?? '{}',
  ) as { requests: Array<{ pointer: { id: string; table: string; spaceId?: string } }> };
  assert.deepEqual(
    body.requests.map((r) => r.pointer.id),
    [ROW2, ROW3],
  );
  assert.equal(body.requests[0]?.pointer.table, 'block');
  assert.equal(body.requests[0]?.pointer.spaceId, SPACE);
  // The single-id form still works, and `id` is still required when `ids` is absent.
  assert.equal(
    (JSON.parse(notionAdapter.buildReplayRequest(action, { id: ROW }, SESSION).body ?? '{}') as { requests: unknown[] })
      .requests.length,
    1,
  );
  assert.throws(() => notionAdapter.buildReplayRequest(action, {}, SESSION), /id/);
});

test('search does not send a paginationToken back', () => {
  const action = notionAdapter.listReplayActions().find((a) => a.id === 'notion.search');
  assert.ok(action);
  const body = JSON.parse(
    notionAdapter.buildReplayRequest(action, { spaceId: SPACE, query: 'export' }, SESSION).body ?? '{}',
  ) as Record<string, unknown>;
  // Verified live: the token is a session timestamp, and passing it back returns
  // the identical first page.
  assert.equal('paginationToken' in body, false);
  assert.equal(body.spaceId, SPACE);
  assert.equal(body.query, 'export');
});

test('a missing required param throws by name instead of building a broken body', () => {
  const action = notionAdapter.listReplayActions().find((a) => a.id === 'notion.page.chunk');
  assert.ok(action);
  assert.throws(() => notionAdapter.buildReplayRequest(action, {}, SESSION), /pageId/);
  assert.throws(() => notionAdapter.buildReplayRequest(action, { pageId: '' }, SESSION), /pageId/);
});

test('the two param-free actions come first, so `sluice sync` reconstructs structure', () => {
  const [first, second] = notionAdapter.listReplayActions();
  assert.equal(first?.id, 'notion.user.content');
  assert.equal(second?.id, 'notion.spaces');
  // sync runs only actions with no required params.
  for (const a of [first, second]) assert.equal(a?.params.length, 0);
});

// ── ids ──────────────────────────────────────────────────────────────────────────

test('toPageId accepts the URL form people actually paste', () => {
  assert.equal(
    toPageId('https://app.notion.com/p/example-space/some-title-7bf74c6fdcff4013a680bf4fd4e5a048'),
    PAGE,
  );
  assert.equal(toPageId(PAGE), PAGE);
  assert.equal(toPageId('7bf74c6fdcff4013a680bf4fd4e5a048'), PAGE);
  assert.equal(toPageId('not a page'), undefined);
});

// ── app wiring ───────────────────────────────────────────────────────────────────

test('the app exposes a credential provider with a passive probe', () => {
  assert.ok(notionApp.credentials, 'notion authenticates, so it needs a provider');
  assert.equal(typeof notionApp.credentials.listWorkspaces, 'function');
});

test('the active-user header is NOT redacted — it is a principal, not a secret', () => {
  // Masking it was the first instinct and it cost real provenance: the header
  // names WHICH signed-in account a capture was made as, the same uuid appears
  // unmasked as `created_by_id` throughout every recordMap, and the actual
  // credential is token_v2 in the Cookie. With it masked, a consumer reading
  // these captures could not say who authorized the read.
  assert.deepEqual(notionApp.redaction?.headers ?? [], []);
});

test('redaction masks the session token by value, not by field name', () => {
  const pattern = notionApp.redaction?.patterns?.[0];
  assert.ok(pattern, 'token_v2 has a distinctive shape and leaves the Cookie header');
  const token = `v02:user_token_or_cookies:${'A'.repeat(64)}`;
  // The field name varies (`token_v2`, `auth_sync_message_accountSwitcher`, a
  // query param in a redirect), so only a value pattern catches all of them.
  assert.match(`{"auth_sync_message":"${token}"}`, new RegExp(pattern.source));
  assert.match(`?redirect=v02%3Auser_token_or_cookies%3A${'B'.repeat(40)}`, new RegExp(pattern.source));
});

test('sessionFromInput accepts a pasted token on a machine we cannot read Chrome on', () => {
  const session = notionApp.credentials?.sessionFromInput?.({ token_v2: 'PASTED' });
  assert.equal(session?.credentials.values.cookieHeader, 'token_v2=PASTED');
  assert.equal(notionApp.credentials?.sessionFromInput?.({}), undefined);
});

test('listWorkspaces is passive and never throws', { skip: process.platform !== 'darwin' }, async () => {
  const out = await notionApp.credentials?.listWorkspaces?.();
  assert.ok(Array.isArray(out));
});

// ── the shared invariants ────────────────────────────────────────────────────────

runConformance(notionApp, {
  session: SESSION,
  fixtures: [
    notionJson('loadUserContent', USER_CONTENT),
    notionJson('loadPageChunk', PAGE_CHUNK),
    notionJson('queryCollection', COLLECTION_ROWS),
    notionJson('search', { results: [{ id: PAGE }], total: 1, recordMap: { __version__: 3 } }),
    notionJson('ping', {}),
    makeJsonCapture('app.notion.com', '/icons/home_orange.svg', {}),
  ],
});
