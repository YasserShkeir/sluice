// SPDX-License-Identifier: Apache-2.0
/**
 * Store tests against a real in-memory SQLite. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * Mocking better-sqlite3 would hide exactly the class of bug these cover, so the
 * store is exercised for real.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readOnlyStore, SqliteStore } from './store.js';
import type { Capture } from './types.js';

function capture(over: Partial<Capture> = {}): Capture {
  return {
    id: 'cap',
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/api.test',
    host: 'slack.com',
    path: '/api/api.test',
    status: 200,
    durationMs: 10,
    reqHeaders: { 'content-type': 'application/json' },
    reqBody: null,
    resHeaders: { 'content-type': 'application/json' },
    resBody: null,
    ...over,
  };
}

test('captures round-trip through insert + list', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'c1', resBody: '{"ok":true}' }));
  const [got] = store.listCaptures();
  assert.equal(got?.id, 'c1');
  assert.equal(got?.host, 'slack.com');
  assert.deepEqual(got?.resHeaders, { 'content-type': 'application/json' });
  store.close();
});

test('a malformed JSON column does not throw out of the read path', () => {
  // One truncated write used to take down listCaptures — and with it the WS
  // backfill, the cartographer and the api-map, since all three read through it.
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'c1' }));
  store.db.prepare(`UPDATE captures SET req_headers = ? WHERE id = ?`).run('{not json', 'c1');

  const rows = store.listCaptures();
  assert.equal(rows.length, 1, 'the row must still be returned');
  assert.deepEqual(rows[0]?.reqHeaders, {}, 'unparseable JSON degrades to empty, not a throw');
  store.close();
});

test('pruneCaptures drops rows older than maxAgeMs', () => {
  const store = new SqliteStore(':memory:');
  const now = Date.now();
  store.insertCapture(capture({ id: 'old', ts: now - 10 * 24 * 60 * 60 * 1000 }));
  store.insertCapture(capture({ id: 'new', ts: now }));

  const removed = store.pruneCaptures({ maxAgeMs: 24 * 60 * 60 * 1000 });
  assert.equal(removed, 1);
  assert.equal(store.countCaptures(), 1);
  assert.equal(store.listCaptures()[0]?.id, 'new');
  store.close();
});

test('pruneCaptures keeps only the newest maxRows', () => {
  const store = new SqliteStore(':memory:');
  for (let i = 0; i < 10; i++) store.insertCapture(capture({ id: `c${i}`, ts: 1_000 + i }));

  const removed = store.pruneCaptures({ maxRows: 3 });
  assert.equal(removed, 7);
  const left = store.listCaptures().map((c) => c.id).sort();
  assert.deepEqual(left, ['c7', 'c8', 'c9']);
  store.close();
});

test('pruneCaptures with no bounds removes nothing', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'c1' }));
  assert.equal(store.pruneCaptures({}), 0);
  assert.equal(store.countCaptures(), 1);
  store.close();
});

test('an existing database gains new columns on open', () => {
  // The regression this guards: `CREATE TABLE IF NOT EXISTS` is a no-op on a
  // table that already exists, so a column added only to SCHEMA_SQL would reach
  // brand-new stores and silently never reach anyone who already has data.
  const store = new SqliteStore(':memory:');

  // Simulate a pre-migration database by dropping a later column back off.
  store.db.exec('DROP TABLE captures');
  store.db.exec(`CREATE TABLE captures (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL, adapter_id TEXT,
    method TEXT NOT NULL, url TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL,
    status INTEGER, duration_ms INTEGER,
    req_headers TEXT NOT NULL DEFAULT '{}', req_body TEXT,
    res_headers TEXT NOT NULL DEFAULT '{}', res_body TEXT,
    pid INTEGER, process_name TEXT
  )`);
  const before = (store.db.prepare('PRAGMA table_info(captures)').all() as Array<{ name: string }>)
    .map((r) => r.name);
  assert.ok(!before.includes('tab_id'), 'precondition: the old table lacks tab_id');

  store.migrate();

  const after = (store.db.prepare('PRAGMA table_info(captures)').all() as Array<{ name: string }>)
    .map((r) => r.name);
  for (const col of [
    'tab_id',
    'tab_url',
    'direction',
    'ws_id',
    'classification',
    'parsed_at',
    'req_body_encoding',
    'res_body_encoding',
  ]) {
    assert.ok(after.includes(col), `migrate() must add ${col}`);
  }

  // And it must be idempotent — migrate runs on every single startup.
  assert.doesNotThrow(() => store.migrate());
  store.close();
});

test('tab fields round-trip and listCaptures can filter by tab', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'a', tabId: 'TAB1', tabUrl: 'https://app.slack.com/' }));
  store.insertCapture(capture({ id: 'b', tabId: 'TAB2', tabUrl: 'https://trello.com/' }));

  const onlyTab1 = store.listCaptures({ tabId: 'TAB1' });
  assert.equal(onlyTab1.length, 1);
  assert.equal(onlyTab1[0]?.id, 'a');
  assert.equal(onlyTab1[0]?.tabUrl, 'https://app.slack.com/');
  assert.equal(store.listCaptures().length, 2, 'unfiltered still returns both');
  store.close();
});

test('a WebSocket frame round-trips with its direction and socket id', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'f1',
      source: 'ws',
      method: 'WS',
      status: null,
      direction: 'received',
      wsId: 'sock-1',
      resBody: '{"type":"message"}',
    }),
  );
  const [got] = store.listCaptures();
  assert.equal(got?.source, 'ws');
  assert.equal(got?.direction, 'received');
  assert.equal(got?.wsId, 'sock-1');
  assert.equal(got?.resBody, '{"type":"message"}');
  store.close();
});

test('listCaptures honours sinceTs — the incremental materialize path', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'old', ts: 1_000 }));
  store.insertCapture(capture({ id: 'new', ts: 5_000 }));

  const recent = store.listCaptures({ sinceTs: 2_000 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.id, 'new');
  store.close();
});

// ── Body compression ─────────────────────────────────────────────────────────

test('a large body is stored compressed and reads back identical', () => {
  const store = new SqliteStore(':memory:');
  // Repetitive JSON, which is exactly what an API returns and what gzip is good at.
  const big = JSON.stringify({ messages: Array.from({ length: 400 }, (_, i) => ({ ts: i, text: 'hello world' })) });
  store.insertCapture(capture({ id: 'big', resBody: big }));

  const row = store.db
    .prepare('SELECT res_body, res_body_encoding FROM captures WHERE id = ?')
    .get('big') as { res_body: unknown; res_body_encoding: string | null };
  assert.equal(row.res_body_encoding, 'gzip', 'a body over the threshold must be compressed');
  assert.ok(Buffer.isBuffer(row.res_body), 'compressed bodies are stored as a BLOB');
  assert.ok((row.res_body as Buffer).length < big.length / 2, 'compression must actually save space');

  // The whole contract: no reader downstream of rowToCapture knows any of that.
  assert.equal(store.listCaptures()[0]?.resBody, big);
  store.close();
});

test('a small body stays plain text and greppable', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'small', resBody: '{"ok":true}' }));
  const row = store.db
    .prepare('SELECT res_body, res_body_encoding FROM captures WHERE id = ?')
    .get('small') as { res_body: unknown; res_body_encoding: string | null };
  assert.equal(row.res_body_encoding, null);
  assert.equal(row.res_body, '{"ok":true}');
  store.close();
});

test('rows written before compression existed still read back', () => {
  // A NULL encoding means plain text, which is what every pre-existing row is.
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'legacy' }));
  store.db
    .prepare('UPDATE captures SET res_body = ?, res_body_encoding = NULL WHERE id = ?')
    .run('{"legacy":true}', 'legacy');
  assert.equal(store.listCaptures()[0]?.resBody, '{"legacy":true}');
  store.close();
});

// ── Full-text search over bodies ─────────────────────────────────────────────

test('searchCaptures finds a term inside a response body', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'hit', resBody: '{"ok":false,"error":"not_in_channel"}' }));
  store.insertCapture(capture({ id: 'miss', resBody: '{"ok":true}' }));

  const found = store.searchCaptures('not_in_channel');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.id, 'hit');
  store.close();
});

test('search reaches into a body large enough to have been compressed', () => {
  // The trap this guards: a gzip BLOB cannot be tokenized, so the index has to be
  // fed the plaintext at insert time. If that ordering ever flips, big bodies —
  // the ones worth searching — become silently unsearchable.
  const store = new SqliteStore(':memory:');
  const big = `${'x'.repeat(4000)} needle_token_9f3a`;
  store.insertCapture(capture({ id: 'big', resBody: big }));
  assert.equal(store.searchCaptures('needle_token_9f3a')[0]?.id, 'big');
  store.close();
});

test('search also covers request bodies', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'req', reqBody: 'channel=C123&oldest=0' }));
  assert.equal(store.searchCaptures('C123')[0]?.id, 'req');
  store.close();
});

test('re-inserting the same capture id replaces its indexed body, not adds to it', () => {
  // Guards the rowid contract: INSERT OR REPLACE would assign a NEW rowid and
  // orphan the old index entry, so the stale term would keep matching forever.
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'c1', resBody: '{"error":"first_error"}' }));
  store.insertCapture(capture({ id: 'c1', resBody: '{"error":"second_error"}' }));

  assert.equal(store.searchCaptures('first_error').length, 0, 'the old body must stop matching');
  assert.equal(store.searchCaptures('second_error').length, 1);
  assert.equal(store.countCaptures(), 1);
  store.close();
});

test('pruning a capture also drops it from the search index', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'old', ts: 1_000, resBody: '{"error":"vanishing"}' }));
  store.pruneCaptures({ maxAgeMs: 1 });
  assert.equal(store.countCaptures(), 0);
  assert.equal(store.searchCaptures('vanishing').length, 0, 'an orphaned index entry would still match');
  store.close();
});

test('user text that is FTS syntax searches literally instead of throwing', () => {
  // FTS5 treats " * ( : - and bare AND/OR/NOT as syntax, so a search box passing
  // text straight through turns a stray quote into a SQLite ERROR — the search
  // fails loudly rather than returning nothing.
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'c1', resBody: '{"error":"rate limited"}' }));
  for (const q of ['"', '-', 'rate "limited', 'AND', '*', '()', '']) {
    assert.doesNotThrow(() => store.searchCaptures(q), `must not throw on ${JSON.stringify(q)}`);
  }
  assert.equal(store.searchCaptures('rate limited').length, 1);
  assert.equal(store.searchCaptures('   ').length, 0, 'an empty query is not a match-all');
  store.close();
});

test('an existing database gets its bodies indexed on first open', () => {
  // CREATE VIRTUAL TABLE IF NOT EXISTS gives an upgraded database the index but
  // not its contents, so without a backfill every capture the user already had
  // would be silently unsearchable forever.
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'c1', resBody: '{"error":"pre_existing"}' }));
  store.db.exec('DELETE FROM captures_fts');
  assert.equal(store.searchCaptures('pre_existing').length, 0, 'precondition: index emptied');

  store.migrate();
  assert.equal(store.searchCaptures('pre_existing').length, 1);
  store.close();
});

// ── parsed_at / classification ───────────────────────────────────────────────

test('unparsed captures are queryable, and markParsed removes them from the worklist', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'a' }));
  store.insertCapture(capture({ id: 'b' }));
  assert.equal(store.listCaptures({ unparsed: true }).length, 2);

  store.markParsed(['a'], 1_700_000_000_100);
  const left = store.listCaptures({ unparsed: true });
  assert.equal(left.length, 1);
  assert.equal(left[0]?.id, 'b');
  assert.equal(store.getCapture('a')?.parsedAt, 1_700_000_000_100);
  store.close();
});

test('classification round-trips and filters', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(capture({ id: 'a', classification: 'conversations.history' }));
  store.insertCapture(capture({ id: 'b', classification: 'users.list' }));
  const only = store.listCaptures({ classification: 'users.list' });
  assert.equal(only.length, 1);
  assert.equal(only[0]?.id, 'b');
  assert.equal(store.getCapture('a')?.classification, 'conversations.history');
  store.close();
});

// ── Edges ────────────────────────────────────────────────────────────────────

test('edges round-trip and re-observing one refreshes rather than duplicates it', () => {
  const store = new SqliteStore(':memory:');
  const edge = {
    srcKind: 'actor' as const,
    srcId: 'U1',
    rel: 'member-of',
    dstKind: 'container' as const,
    dstId: 'C1',
    adapterId: 'slack',
    workspaceId: 'W1',
  };
  store.upsertEdge(edge, 1_000);
  store.upsertEdge(edge, 2_000);

  const all = store.listEdges();
  assert.equal(all.length, 1, 'the same relationship must not accumulate rows');
  assert.equal(all[0]?.rel, 'member-of');
  assert.equal(store.listEdges({ dstId: 'C1' }).length, 1);
  assert.equal(store.listEdges({ rel: 'authored' }).length, 0);
  store.close();
});

test('an edge may point at an entity that was never captured', () => {
  // A message mentioning a user whose profile appeared in no response is normal,
  // so a dangling edge must not be rejected.
  const store = new SqliteStore(':memory:');
  assert.doesNotThrow(() =>
    store.upsertEdge(
      { srcKind: 'item', srcId: 'M1', rel: 'mentions', dstKind: 'actor', dstId: 'UNSEEN', adapterId: 'slack' },
      1_000,
    ),
  );
  assert.equal(store.listEdges({ dstId: 'UNSEEN' }).length, 1);
  store.close();
});

test('applyParseResult writes edges and counts them', () => {
  const store = new SqliteStore(':memory:');
  const counts = store.applyParseResult(
    {
      containers: [{ id: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'channel', name: 'general' }],
      edges: [
        { srcKind: 'actor', srcId: 'U1', rel: 'member-of', dstKind: 'container', dstId: 'C1', adapterId: 'slack' },
      ],
    },
    1_000,
  );
  assert.equal(counts.edges, 1);
  assert.equal(counts.containers, 1);
  assert.equal(store.listEdges().length, 1);
  store.close();
});

// ── Cursors worklist ─────────────────────────────────────────────────────────

test('enqueueCursors is idempotent on the same page', () => {
  const store = new SqliteStore(':memory:');
  const seed = { adapterId: 'slack', actionId: 'conversations.history', containerId: 'C1', cursor: 'abc' };
  assert.equal(store.enqueueCursors([seed]), 1);
  assert.equal(store.enqueueCursors([seed]), 0, 're-parsing a capture must not re-enqueue its page');
  assert.equal(store.listCursors().length, 1);
  store.close();
});

test('claiming work marks it running so a second drainer cannot take it', () => {
  // Two drainers replaying the same page costs real API quota, so the claim and
  // the state flip have to be one transaction.
  const store = new SqliteStore(':memory:');
  store.enqueueCursors([
    { adapterId: 'slack', actionId: 'a', cursor: '1' },
    { adapterId: 'slack', actionId: 'a', cursor: '2' },
  ]);

  const first = store.claimCursors(1);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.state, 'running');
  assert.equal(first[0]?.attempts, 1);

  const second = store.claimCursors(10);
  assert.equal(second.length, 1, 'the already-claimed item must not come back');
  assert.notEqual(second[0]?.id, first[0]?.id);
  assert.equal(store.claimCursors(10).length, 0);
  store.close();
});

test('completing and failing a work item are distinguishable', () => {
  const store = new SqliteStore(':memory:');
  store.enqueueCursors([
    { adapterId: 'slack', actionId: 'a', cursor: '1' },
    { adapterId: 'slack', actionId: 'a', cursor: '2' },
  ]);
  const [ok, bad] = store.claimCursors(2);
  store.completeCursor(ok?.id ?? '');
  store.completeCursor(bad?.id ?? '', 'HTTP 429');

  assert.deepEqual(store.countCursors(), { pending: 0, running: 0, done: 1, failed: 1 });
  assert.equal(store.listCursors({ state: 'failed' })[0]?.lastError, 'HTTP 429');
  store.close();
});

test('a killed drainer does not strand its claims forever', () => {
  const store = new SqliteStore(':memory:');
  store.enqueueCursors([{ adapterId: 'slack', actionId: 'a', cursor: '1' }]);
  store.claimCursors(1);
  assert.equal(store.claimCursors(1).length, 0, 'precondition: nothing left to claim');

  assert.equal(store.releaseStaleCursors(), 1);
  assert.equal(store.claimCursors(1).length, 1);
  store.close();
});

test('extra params survive the worklist round-trip', () => {
  const store = new SqliteStore(':memory:');
  store.enqueueCursors([
    { adapterId: 'slack', actionId: 'a', cursor: '1', params: { limit: '200', inclusive: 'true' } },
  ]);
  assert.deepEqual(store.claimCursors(1)[0]?.params, { limit: '200', inclusive: 'true' });
  store.close();
});

// ── Item search ──────────────────────────────────────────────────────────────

test('searchItems finds message text and can be scoped to a container', () => {
  const store = new SqliteStore(':memory:');
  const item = (id: string, containerId: string, text: string) => ({
    id, containerId, workspaceId: 'W1', adapterId: 'slack', kind: 'message' as const, ts: 1_000, text,
  });
  store.upsertItem(item('m1', 'C1', 'the deploy is running now'));
  store.upsertItem(item('m2', 'C2', 'lunch?'));

  assert.equal(store.searchItems('deploy').length, 1);
  // Stemmed, unlike the capture-body index: item text is prose a human wrote.
  assert.equal(store.searchItems('run').length, 1, 'porter stemming should match "running"');
  assert.equal(store.searchItems('deploy', { containerId: 'C2' }).length, 0);
  store.close();
});

test('searchItems scopes to one adapter inside the query, not after it', () => {
  // The LIMIT is applied by SQLite. A caller filtering the RESULT would get
  // whatever survived the limit, so one noisy adapter can starve another out of
  // its own search — and the answer looks like "no matches" rather than "cut off".
  const store = new SqliteStore(':memory:');
  const item = (id: string, adapterId: string, ts: number) => ({
    id, containerId: 'C1', workspaceId: 'W1', adapterId, kind: 'message' as const, ts, text: 'invoice attached',
  });
  store.upsertItem(item('s1', 'slack', 3_000));
  store.upsertItem(item('s2', 'slack', 2_000));
  store.upsertItem(item('g1', 'gmail', 1_000));

  assert.equal(store.searchItems('invoice', { limit: 2 }).length, 2);
  const gmail = store.searchItems('invoice', { adapterId: 'gmail', limit: 2 });
  assert.deepEqual(gmail.map((i) => i.id), ['g1']);
  store.close();
});

test('editing an item replaces its indexed text', () => {
  const store = new SqliteStore(':memory:');
  const base = { id: 'm1', containerId: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'message' as const, ts: 1_000 };
  store.upsertItem({ ...base, text: 'original wording' });
  store.upsertItem({ ...base, text: 'edited wording' });
  assert.equal(store.searchItems('original').length, 0);
  assert.equal(store.searchItems('edited').length, 1);
  store.close();
});

// ── Reads an app tool needs ──────────────────────────────────────────────────────

/** A store holding two adapters' items, some threaded and some not. */
function twoAdapters(): SqliteStore {
  const store = new SqliteStore(':memory:');
  const item = (id: string, containerId: string, adapterId: string, ts: number, threadId?: string) => ({
    id, containerId, workspaceId: 'W1', adapterId, kind: 'message' as const, ts, text: `item ${id}`,
    ...(threadId === undefined ? {} : { threadId }),
  });
  store.upsertItem(item('t1', '^i', 'gmail', 5_000));
  store.upsertItem(item('t2', '^i', 'gmail', 4_000));
  store.upsertItem(item('t3', '^f', 'gmail', 3_000));
  store.upsertItem(item('m1', 'thread-f:1', 'gmail', 2_000, 'thread-f:1'));
  store.upsertItem(item('s1', 'C1', 'slack', 9_000));
  return store;
}

test('queryItems spans containers, which listItems cannot', () => {
  // "Every thread in this mailbox" is one container per label, so looping
  // listItems over each spends the limit per-container and then has to merge —
  // which returns the wrong page as soon as there is more than one page.
  const store = twoAdapters();
  const gmail = store.queryItems({ adapterId: 'gmail' });
  assert.deepEqual(gmail.map((i) => i.id), ['t1', 't2', 't3', 'm1'], 'newest first, no Slack');
  assert.deepEqual(store.queryItems({ containerId: '^i' }).map((i) => i.id), ['t1', 't2']);
  store.close();
});

test('threaded tells a thread row from a message inside one', () => {
  // Gmail's batch view emits one item per THREAD and sets no threadId; its thread
  // fetcher emits one per MESSAGE and sets it. Counting them together reports a
  // mailbox with more conversations than it has.
  const store = twoAdapters();
  assert.equal(store.countItems({ adapterId: 'gmail', threaded: false }), 3);
  assert.equal(store.countItems({ adapterId: 'gmail', threaded: true }), 1);
  assert.equal(store.countItems({ adapterId: 'gmail' }), 4, 'omitted matches both');
  store.close();
});

test('offset walks past the first page, for items and for search alike', () => {
  const store = twoAdapters();
  assert.deepEqual(store.queryItems({ adapterId: 'gmail', limit: 2 }).map((i) => i.id), ['t1', 't2']);
  assert.deepEqual(
    store.queryItems({ adapterId: 'gmail', limit: 2, offset: 2 }).map((i) => i.id),
    ['t3', 'm1'],
  );
  assert.deepEqual(
    store.searchItems('item', { adapterId: 'gmail', limit: 2, offset: 1 }).map((i) => i.id),
    ['t2', 't3'],
  );
  store.close();
});

test('an item id is a filter, not a key — the same id can sit under two containers', () => {
  const store = twoAdapters();
  store.upsertItem({
    id: 't1', containerId: '^f', workspaceId: 'W1', adapterId: 'gmail', kind: 'message', ts: 5_000,
    text: 'item t1',
  });
  assert.equal(store.queryItems({ id: 't1' }).length, 2, 'items are keyed by (container, id)');
  assert.equal(store.queryItems({ id: 't1', containerId: '^i' }).length, 1);
  store.close();
});

test('captures can be counted and dated by the same query that lists them', () => {
  const store = new SqliteStore(':memory:');
  assert.equal(store.newestCaptureTs(), null, 'an empty store has no newest capture');
  store.insertCapture(capture({ id: 'a', adapterId: 'gmail', ts: 1_000 }));
  store.insertCapture(capture({ id: 'b', adapterId: 'gmail', ts: 3_000 }));
  store.insertCapture(capture({ id: 'c', adapterId: 'slack', ts: 9_000 }));
  assert.equal(store.countCaptures(), 3);
  assert.equal(store.countCaptures({ adapterId: 'gmail' }), 2);
  assert.equal(store.newestCaptureTs({ adapterId: 'gmail' }), 3_000, 'not the Slack one');
  store.close();
});

test('readOnlyStore hands over the reads and nothing else', () => {
  // Narrowing by TYPE alone is a promise the receiver can walk straight through
  // with a cast, since SqliteStore satisfies ReadOnlyStore structurally.
  const store = twoAdapters();
  const view = readOnlyStore(store);
  assert.equal(view.countItems({ adapterId: 'gmail' }), 4, 'the reads work');
  const reachable = view as unknown as Record<string, unknown>;
  for (const forbidden of ['db', 'insertCapture', 'upsertItem', 'applyParseResult', 'pruneCaptures', 'listSessions', 'close']) {
    assert.equal(reachable[forbidden], undefined, `${forbidden} must not be reachable`);
  }
  store.close();
});
