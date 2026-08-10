// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Gmail MCP tool tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * These drive the tools the way `sluice-mcp` does — through an `AppToolContext`
 * carrying a real `readOnlyStore` — against a store filled by replaying the
 * SCRUBBED recording through the real parser. That chain is the claim: captured
 * traffic → adapter → normalized store → MCP answer. A hand-seeded store would
 * only prove this file agrees with itself, and the tools read `Item.raw`, which
 * is precisely the part a hand-written fixture gets wrong.
 *
 * Every string of mail content in `fixtures/gmail.ndjson` is synthetic; see the
 * header of gmail.test.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeCapture, parseNdjson } from '@sluice/adapter-sdk';
import { readOnlyStore, SqliteStore } from '@sluice/core';
import type { AppMcpTool, AppToolContext, Capture } from '@sluice/core';
import {
  accountWorkspaceId,
  containerKind,
  gmailApp,
  parseGmailCapture,
  reconcileGmailAccounts,
} from './index.js';

// ── The store under test ─────────────────────────────────────────────────────────

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/gmail.ndjson', import.meta.url));

/** The one Slack timestamp that must never come back from a Gmail tool. */
const SLACK_TS = 9_000_000_000_000;

/**
 * The recording, attributed the way the ingest funnel attributes it.
 *
 * A recorded capture carries `adapterId: null` — attribution is a step in the
 * pipeline, not a property of the wire — and every Gmail tool scopes itself by
 * adapter id, so a store filled from the raw lines answers zero to all of them.
 */
function recorded(): Capture[] {
  const { captures } = parseNdjson(readFileSync(FIXTURE_PATH, 'utf8'));
  for (const capture of captures) {
    if (gmailApp.matchRequest(capture)) capture.adapterId = gmailApp.id;
  }
  return captures;
}

/**
 * A store holding the recorded mailbox AND a Slack workspace.
 *
 * Both, deliberately. Every Gmail tool scopes itself by adapter id, and a store
 * with only Gmail in it cannot tell a working filter from an absent one — the
 * Slack rows here are the ones that must NOT come back. The Slack item is also
 * the NEWEST thing in the store, so a filter applied after the query rather than
 * inside it sorts it to the top of every list.
 */
function seeded(): SqliteStore {
  const store = new SqliteStore(':memory:');
  for (const capture of recorded()) {
    store.insertCapture(capture);
    store.applyParseResult(parseGmailCapture(capture), capture.ts);
  }
  // What the runner does after a capture session, and what every read below
  // therefore sees: the `bv` responses moved off their slot placeholder and onto
  // the mailbox the neighbouring `fd` responses proved they belonged to.
  reconcileGmailAccounts(store);
  store.applyParseResult(
    {
      workspaces: [{ id: 'W1', adapterId: 'slack', name: 'Acme', domain: 'acme' }],
      containers: [
        { id: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'channel', name: 'general' },
      ],
      items: [
        {
          id: 'M1',
          containerId: 'C1',
          workspaceId: 'W1',
          adapterId: 'slack',
          kind: 'message',
          ts: SLACK_TS,
          text: 'a slack message that mentions mail and threads',
        },
      ],
    },
    Date.now(),
  );
  store.insertCapture(makeCapture({ adapterId: 'slack', ts: SLACK_TS, host: 'slack.com' }));
  return store;
}

// ── A second signed-in account ───────────────────────────────────────────────────

/** The derived account's address. Synthetic, like every other string in here. */
const SECOND_ADDRESS = 'second@example.test';

/**
 * The recorded mailbox, as the scrubber renamed it, and the two workspace ids
 * the seeded stores end up holding.
 *
 * Literals rather than values read back out of the parser: an expectation
 * derived from the thing under test agrees with it no matter what it does.
 */
const FIRST_ADDRESS = 'user5857x@example.test';
const FIRST_WS = `gmail:${FIRST_ADDRESS}`;
const SECOND_WS = `gmail:${SECOND_ADDRESS}`;

/** The account address the recording was made from — the only place it is named. */
function firstAddress(captures: Capture[]): string {
  for (const capture of captures) {
    const domain = parseGmailCapture(capture).workspaces?.[0]?.domain;
    if (domain !== undefined) return domain;
  }
  assert.fail('precondition: an fd capture in the recording names the account address');
}

/**
 * Every id two mailboxes must not share: the items, and the thread Containers
 * they live in.
 *
 * Read back out of the PARSER rather than matched in the body text. Some of the
 * recording's thread ids are `thread-a:r-<digits>`, which the scrubber does not
 * recognise as an id — its rule is `<short name>:<digits>` — so those came out as
 * prose and no id-shaped pattern finds them. Missing one is not cosmetic: a
 * message's container IS its thread id, so a shared one merges two accounts'
 * messages onto the same `(container_id, id)` rows and the fixture would be one
 * mailbox stored twice.
 */
function mintedIds(captures: Capture[]): string[] {
  const ids = new Set<string>();
  for (const capture of captures) {
    const parsed = parseGmailCapture(capture);
    for (const item of parsed.items ?? []) ids.add(item.id);
    for (const container of parsed.containers ?? []) {
      if (containerKind(container.id) === 'thread') ids.add(container.id);
    }
  }
  return [...ids];
}

/** The scrubber's own id rule, so a reminted id keeps the shape it had. */
const PREFIXED_ID = /^([a-z][a-z0-9_-]{0,15}:)(\d+)$/;

/** The same conversation as ANOTHER mailbox would have minted it. */
function reminted(id: string): string {
  const [, prefix, digits] = PREFIXED_ID.exec(id) ?? [];
  return prefix === undefined || digits === undefined ? `${id}-u1` : `${prefix}7${digits}`;
}

/**
 * One capture's bodies, rewritten as the second account would have sent them.
 *
 * Replacement is on the QUOTED form, so it matches a whole JSON string and not a
 * prefix of a longer id.
 */
function asSecondAccount(body: string | null, address: string, ids: string[]): string | null {
  if (body === null) return null;
  let out = body.split(`"${address}"`).join(`"${SECOND_ADDRESS}"`);
  for (const id of ids) out = out.split(`"${id}"`).join(`"${reminted(id)}"`);
  return out;
}

/**
 * The recorded mailbox again, as a SECOND signed-in account.
 *
 * Synthetic on purpose — the alternative is a second real mailbox in the repo.
 * Gmail serves accounts by URL slot, so `/u/0/` → `/u/1/` is exactly what the
 * wire differs by, and everything two accounts do NOT share is rewritten with it:
 *
 *   - the account address at `record[11]`, the only place a mailbox is named;
 *   - every thread and message id, because Gmail mints those per mailbox and two
 *     accounts never hold the same one. Left alone the derived captures would
 *     upsert straight onto the first account's rows — items are keyed
 *     `(container_id, id)` and a thread container is the bare thread id — and
 *     every test below would be asserting about one mailbox stored twice;
 *   - the capture ids, which are the store's key for the traffic itself.
 *
 * What is deliberately NOT rewritten is the label vocabulary: `^i`, `^all` and
 * the `^smartlabel_*` set are identical in every account, and that is the whole
 * collision under test.
 */
function secondAccount(captures: Capture[]): Capture[] {
  const address = firstAddress(captures);
  const ids = mintedIds(captures);
  return captures.map((capture) => ({
    ...capture,
    id: `${capture.id}_u1`,
    path: capture.path.replace('/u/0/', '/u/1/'),
    url: capture.url.replace('/u/0/', '/u/1/'),
    reqBody: asSecondAccount(capture.reqBody, address, ids),
    resBody: asSecondAccount(capture.resBody, address, ids),
  }));
}

/**
 * The recorded `bv` request with a readable query put back.
 *
 * The scrubber replaces any string not starting with `^`, so the recording's
 * search query — the ONLY place a batch view says which label it answered — comes
 * back as prose and every recorded thread lands in the "label not recovered"
 * bucket. A real capture of the inbox carries `in:^i` at `body[0][3]`; putting it
 * back is what makes the label-scoped reads below about labels rather than about
 * the placeholder.
 */
function withReadableView(capture: Capture): Capture {
  if (!capture.path.endsWith('/i/bv')) return capture;
  const body = JSON.parse(capture.reqBody ?? 'null') as unknown[];
  const frame = body[0] as unknown[];
  frame[3] = 'in:^i';
  return { ...capture, reqBody: JSON.stringify(body) };
}

/** A store holding the recorded mailbox as TWO signed-in accounts. */
function seededTwoAccounts(): SqliteStore {
  const store = new SqliteStore(':memory:');
  const first = recorded().map(withReadableView);
  for (const capture of [...first, ...secondAccount(first)]) {
    store.insertCapture(capture);
    store.applyParseResult(parseGmailCapture(capture), capture.ts);
  }
  reconcileGmailAccounts(store);
  return store;
}

const tools = new Map<string, AppMcpTool>(
  (gmailApp.mcpTools?.() ?? []).map((t) => [t.name, t] as const),
);

/** Run a tool the way the MCP server would, against a read-only view of `store`. */
async function call(
  store: SqliteStore,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `${name} must be contributed by the app`);
  const ctx: AppToolContext = {
    store: readOnlyStore(store),
    replay: () => assert.fail(`${name} must not touch the network`),
  };
  return (await tool.run(args, ctx)) as Record<string, unknown>;
}

interface ThreadRow {
  threadId: string;
  workspaceId: string;
  subject: string;
  from: { address: string; name?: string } | null;
  snippet: string;
  ts: number;
  date: string | null;
  messageCount: number;
  messagesHeld: number;
  labelId?: string;
}

interface MessageRow {
  id: string;
  subject: string;
  body: string;
  from: { address: string } | null;
  to: Array<{ address: string }>;
  cc: Array<{ address: string }>;
  ts: number;
  date: string | null;
  labels: string[];
}

/**
 * The most widespread word in the captured mail.
 *
 * Picked from the store rather than hardcoded: the recording is scrubbed, so
 * every word in it is synthetic and none is stable enough to name in a test.
 */
function commonWord(store: SqliteStore): string {
  const counts = new Map<string, number>();
  for (const item of store.queryItems({ adapterId: 'gmail', limit: 10_000 })) {
    for (const word of new Set(item.text.toLowerCase().match(/[a-z]{5,}/g) ?? [])) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  assert.ok(common, 'precondition: the mailbox has words in it');
  return common;
}

interface LabelRow {
  id: string;
  containerId: string;
  name: string;
  workspaceId: string;
  account: string | null;
}

interface AccountRow {
  id: string;
  name: string;
  address: string | null;
  labels: number;
  threads: number;
  fetchedThreads: number;
  messages: number;
  bodiesPresent: boolean;
}

// ── Contract ─────────────────────────────────────────────────────────────────────

test('the app contributes the five gmail tools, each with a declared schema', () => {
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['gmail_get_thread', 'gmail_list_labels', 'gmail_list_threads', 'gmail_search', 'gmail_sync_status'],
  );
  // A tool registered with no schema is advertised as taking no parameters, so
  // `run` would never receive any however it is typed.
  assert.deepEqual(Object.keys(tools.get('gmail_list_threads')?.inputSchema ?? {}).sort(), [
    'account',
    'labelId',
    'limit',
    'offset',
  ]);
  assert.deepEqual(Object.keys(tools.get('gmail_search')?.inputSchema ?? {}).sort(), [
    'account',
    'limit',
    'offset',
    'query',
  ]);
  assert.deepEqual(Object.keys(tools.get('gmail_list_labels')?.inputSchema ?? {}).sort(), [
    'account',
    'limit',
    'offset',
  ]);
  // No `account` on gmail_get_thread, and that is the id's doing rather than an
  // omission: a thread id names one account's conversation on its own.
  assert.deepEqual(Object.keys(tools.get('gmail_get_thread')?.inputSchema ?? {}), ['threadId']);
});

test('a tool refuses by name when the host gave it no store', async () => {
  // `AppToolContext.store` is optional so that adding it broke no existing app or
  // host. That makes "the host did not provide one" a real state, and it has to
  // be distinguishable from "the mailbox is empty".
  for (const name of tools.keys()) {
    const tool = tools.get(name);
    assert.ok(tool);
    await assert.rejects(
      () => tool.run({ threadId: 'x', query: 'x' }, { replay: () => assert.fail('no network') }),
      /capture store/,
      `${name} must say what is missing`,
    );
  }
});

test('the tools answer an empty store with empty results, not an error', async () => {
  // A Sluice-backed MCP is queried before anything has been captured — on a fresh
  // install that is the FIRST thing that happens. Returning nothing is an answer;
  // throwing is a bug report the user cannot act on.
  const store = new SqliteStore(':memory:');
  assert.deepEqual(await call(store, 'gmail_list_labels'), {
    account: null,
    total: 0,
    offset: 0,
    limit: 50,
    labels: [],
  });
  const threads = await call(store, 'gmail_list_threads');
  assert.deepEqual(threads.threads, []);
  assert.equal(threads.hasMore, false);
  const hits = await call(store, 'gmail_search', { query: 'anything' });
  assert.deepEqual(hits.hits, []);
  const thread = await call(store, 'gmail_get_thread', { threadId: 'thread-f:404' });
  assert.deepEqual(thread.messages, []);
  assert.match(String(thread.note), /has not captured/);
  assert.deepEqual(await call(store, 'gmail_sync_status'), {
    adapterId: 'gmail',
    accounts: [],
    labels: 0,
    threads: 0,
    fetchedThreads: 0,
    messages: 0,
    bodiesPresent: false,
    captures: 0,
    newestCaptureTs: null,
    newestCaptureAt: null,
  });
  store.close();
});

// ── gmail_sync_status ────────────────────────────────────────────────────────────

test('gmail_sync_status reports coverage and stays inside the mailbox', async () => {
  const store = seeded();
  const status = await call(store, 'gmail_sync_status');
  const accounts = status.accounts as AccountRow[];
  assert.equal(accounts.length, 1, 'no Slack workspace');
  assert.equal(accounts[0]?.id, FIRST_WS);
  assert.equal(accounts[0]?.name, FIRST_ADDRESS);
  assert.ok((status.labels as number) > 0, 'the recorded bv page names labels');
  assert.ok((status.threads as number) > 0, 'and lists threads');
  assert.ok((status.fetchedThreads as number) > 0, 'and four fd exchanges fetched threads');
  assert.equal(status.captures, 8, 'the eight Gmail captures, not the Slack one');
  assert.notEqual(status.newestCaptureTs, SLACK_TS, 'staleness is measured on Gmail traffic');
  store.close();
});

test('gmail_sync_status tells a snippet-only store from a parsed one', async () => {
  // The question is "can I actually read a message from this store, or only a
  // preview of one?" — and a message item exists only because the thread fetcher
  // parsed one, which is the only place a body comes from.
  const store = seeded();
  const full = await call(store, 'gmail_sync_status');
  assert.ok((full.messages as number) > 0);
  assert.equal(full.bodiesPresent, true);

  const listOnly = new SqliteStore(':memory:');
  for (const capture of recorded().filter((c) => !c.path.includes('/i/fd'))) {
    listOnly.insertCapture(capture);
    listOnly.applyParseResult(parseGmailCapture(capture), capture.ts);
  }
  const snippets = await call(listOnly, 'gmail_sync_status');
  assert.ok((snippets.threads as number) > 0, 'it holds threads');
  assert.equal(snippets.messages, 0);
  assert.equal(snippets.bodiesPresent, false, 'and says it cannot show you one');
  listOnly.close();
  store.close();
});

// ── Two signed-in accounts ───────────────────────────────────────────────────────

test('the derived account is a second mailbox, not the first one stored twice', async () => {
  // The precondition every other two-account test rests on. Two accounts share
  // their whole LABEL vocabulary and share none of their thread or message ids,
  // so a fixture that got either half wrong would pass these tests for the wrong
  // reason — a shared thread id would upsert one mailbox's messages onto the
  // other's and the merge would look like correct filtering.
  const first = recorded().map(withReadableView);
  const second = secondAccount(first);
  const a = new Set(mintedIds(first));
  const b = new Set(mintedIds(second));
  assert.ok(a.size > 50, 'precondition: the recording names plenty of threads and messages');
  assert.equal(a.size, b.size, 'the same mailbox, id for id');
  assert.equal([...a].filter((id) => b.has(id)).length, 0, 'no thread or message id is shared');
  assert.equal(new Set([...first, ...second].map((c) => c.id)).size, first.length + second.length);
  for (const capture of second) assert.match(capture.path, /\/u\/1\/|\/_\/scs\//);
});

test('gmail_sync_status reports each account separately, not one merged total', async () => {
  // How a caller DISCOVERS which mailboxes are in the store — there is no other
  // tool that lists them — and the reason the counts are not merged: "1,400
  // threads" across two accounts says nothing about whether the one being asked
  // about was captured at all.
  const store = seededTwoAccounts();
  const status = await call(store, 'gmail_sync_status');
  const accounts = status.accounts as AccountRow[];
  // Sorted, because the listing order is `ORDER BY name` and both names are now
  // addresses — which mailbox sorts first is not something this test is about.
  assert.deepEqual(accounts.map((a) => a.id).sort(), [FIRST_WS, SECOND_WS].sort());
  // The id IS the address, and `name`/`address` repeat it rather than adding
  // anything — which is the point: there is no second spelling to disagree with.
  for (const account of accounts) {
    assert.equal(account.id, accountWorkspaceId(account.address ?? ''));
    assert.equal(account.name, account.address);
  }
  assert.notEqual(accounts[0]?.address, accounts[1]?.address);
  for (const account of accounts) {
    assert.ok(account.labels > 0, `${account.id} has its own labels`);
    assert.ok(account.threads > 0, `${account.id} has its own threads`);
    assert.ok(account.messages > 0, `${account.id} has its own messages`);
    assert.equal(account.bodiesPresent, true);
  }
  // …and the totals are the two added up, so nothing was double-counted away.
  assert.equal(status.threads, (accounts[0]?.threads ?? 0) + (accounts[1]?.threads ?? 0));
  assert.equal(status.messages, (accounts[0]?.messages ?? 0) + (accounts[1]?.messages ?? 0));
  assert.equal(status.labels, (accounts[0]?.labels ?? 0) + (accounts[1]?.labels ?? 0));
  store.close();
});

test('an account whose address was never captured says so rather than guessing', async () => {
  // `bv` carries no message records, so a store filled from thread LISTS alone
  // knows the slot and nothing else. Reporting the slot as though it were an
  // identity is what makes a mailbox that changed hands invisible — see
  // accountWorkspaceId — so the unknown address is reported as unknown.
  const store = new SqliteStore(':memory:');
  for (const capture of recorded().filter((c) => !c.path.includes('/i/fd'))) {
    store.insertCapture(capture);
    store.applyParseResult(parseGmailCapture(capture), capture.ts);
  }
  const accounts = (await call(store, 'gmail_sync_status')).accounts as AccountRow[];
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.address, null);
  assert.equal(accounts[0]?.name, 'Gmail (u0 — mailbox not identified)',
    'the slot is all that is known, and the name says so');
  store.close();
});

test("both accounts' inboxes survive as separate containers", async () => {
  // The data-corruption defect: `containers.id` is a PRIMARY KEY and `^i` is
  // every account's inbox, so the second account's Inbox used to overwrite the
  // first's row and take its workspace_id with it.
  const store = seededTwoAccounts();
  const labels = (await call(store, 'gmail_list_labels', { limit: 500 })).labels as LabelRow[];
  const inboxes = labels.filter((l) => l.id === '^i');
  assert.equal(inboxes.length, 2, 'one Inbox per account');
  // Order is not part of the contract — only that both account inboxes exist.
  assert.deepEqual(
    inboxes.map((l) => l.containerId).sort(),
    [`${FIRST_WS}/^i`, `${SECOND_WS}/^i`].sort(),
  );
  assert.deepEqual(inboxes.map((l) => l.workspaceId).sort(), [FIRST_WS, SECOND_WS].sort());
  assert.deepEqual(inboxes.map((l) => l.name), ['Inbox', 'Inbox']);
  // Every label in the recording repeats, and none of them lost a row.
  assert.equal(new Set(labels.map((l) => l.containerId)).size, labels.length);
  assert.equal(new Set(labels.map((l) => l.id)).size * 2, labels.length);
  store.close();
});

test('a thread from account 0 never appears under account 1', async () => {
  const store = seededTwoAccounts();
  const u0 = (await call(store, 'gmail_list_threads', { account: FIRST_WS, limit: 500 }))
    .threads as ThreadRow[];
  const u1 = (await call(store, 'gmail_list_threads', { account: SECOND_WS, limit: 500 }))
    .threads as ThreadRow[];
  assert.ok(u0.length > 0 && u1.length > 0);
  assert.equal(u0.length, u1.length, 'the same recording, twice over');
  for (const row of u0) assert.equal(row.workspaceId, FIRST_WS);
  for (const row of u1) assert.equal(row.workspaceId, SECOND_WS);
  const inU1 = new Set(u1.map((t) => t.threadId));
  assert.equal(u0.filter((t) => inU1.has(t.threadId)).length, 0, 'and no thread is in both');

  // Unscoped is still the whole store — the account filter is a filter, not a
  // default that hides mail.
  const both = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  assert.equal(both.length, u0.length + u1.length);
  store.close();
});

test("a label view lists only its own account's threads", async () => {
  // The `^i` a caller types is one view PER ACCOUNT. Scoped, it is exactly one.
  const store = seededTwoAccounts();
  const bare = (await call(store, 'gmail_list_threads', { labelId: '^i', limit: 500 }))
    .threads as ThreadRow[];
  assert.ok(bare.length > 0, 'the bare Gmail id is accepted — it is what a human types');
  assert.equal(new Set(bare.map((t) => t.workspaceId)).size, 2, 'and it fans out over accounts');

  const scoped = (await call(store, 'gmail_list_threads', { labelId: `${SECOND_WS}/^i`, limit: 500 }))
    .threads as ThreadRow[];
  assert.ok(scoped.length > 0);
  assert.equal(scoped.length * 2, bare.length);
  for (const row of scoped) {
    assert.equal(row.workspaceId, SECOND_WS);
    assert.equal(row.labelId, `${SECOND_WS}/^i`, 'the labelId comes back in a form it takes back');
  }

  // The bare form plus an account is the same view as the scoped id.
  const narrowed = (await call(store, 'gmail_list_threads', {
    labelId: '^i',
    account: SECOND_WS,
    limit: 500,
  })).threads as ThreadRow[];
  assert.deepEqual(narrowed.map((t) => t.threadId), scoped.map((t) => t.threadId));
  store.close();
});

test('a label id and an account that contradict each other are refused, not silently empty', async () => {
  const store = seededTwoAccounts();
  await assert.rejects(
    () => call(store, 'gmail_list_threads', { labelId: `${FIRST_WS}/^i`, account: SECOND_WS }),
    new RegExp(`${FIRST_WS}.*${SECOND_WS}`),
    'an empty list would read as "this label is empty"',
  );
  store.close();
});

test('gmail_list_labels and gmail_search filter by account too', async () => {
  const store = seededTwoAccounts();
  const scoped = (await call(store, 'gmail_list_labels', { account: SECOND_WS, limit: 500 }))
    .labels as LabelRow[];
  assert.ok(scoped.length > 0);
  for (const label of scoped) {
    assert.equal(label.workspaceId, SECOND_WS);
    assert.equal(label.account, SECOND_ADDRESS, 'a label row says whose mailbox it is');
  }
  assert.equal(scoped.filter((l) => l.id === '^i').length, 1);

  // A word from the mailbox itself: the recording is scrubbed, so every word in
  // it is synthetic and none is stable enough to hardcode here.
  const word = commonWord(store);
  const both = (await call(store, 'gmail_search', { query: word, limit: 500 })).hits as Array<{
    id: string;
  }>;
  const one = (await call(store, 'gmail_search', { query: word, account: SECOND_WS, limit: 500 }))
    .hits as Array<{ id: string }>;
  assert.ok(one.length > 0 && one.length < both.length, 'one account is a subset of the store');
  for (const hit of one) {
    const held = store.queryItems({ adapterId: 'gmail', id: hit.id, limit: 10 });
    assert.ok(held.every((i) => i.workspaceId === SECOND_WS), `${hit.id} is not account 1's`);
  }
  store.close();
});

test('an account can be named by its address, not only by its slot id', async () => {
  // Nobody knows their own mailbox by its browser sign-in index. The address is
  // the only spelling a human has, and the store keeps it on `Workspace.domain`.
  const store = seededTwoAccounts();
  const byId = (await call(store, 'gmail_list_threads', { account: SECOND_WS, limit: 500 }))
    .threads as ThreadRow[];
  const byAddress = (await call(store, 'gmail_list_threads', { account: SECOND_ADDRESS, limit: 500 }))
    .threads as ThreadRow[];
  assert.ok(byId.length > 0);
  assert.deepEqual(byAddress.map((t) => t.threadId), byId.map((t) => t.threadId));
  store.close();
});

test('an account nobody captured is refused by name, with the ones that exist', async () => {
  // An empty list reads as "this mailbox is empty". It does not read as "you
  // typed an address that was never captured", and the difference decides
  // whether the caller retries or reports.
  const store = seededTwoAccounts();
  for (const name of ['gmail:u9', 'nobody@example.test']) {
    await assert.rejects(
      () => call(store, 'gmail_list_threads', { account: name }),
      new RegExp(`Captured accounts: (?=.*${FIRST_ADDRESS})(?=.*${SECOND_ADDRESS})`, 's'),
      name,
    );
  }
  store.close();
});

test('gmail_get_thread needs no account because a thread id names one mailbox', async () => {
  // Verified rather than assumed: thread ids are minted per mailbox, so the
  // containers the two accounts' messages live in are disjoint — which is why
  // this tool is keyed by the id alone while every label id had to be scoped.
  const store = seededTwoAccounts();
  const rows = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  const readable = rows.filter((t) => t.messagesHeld > 0);
  assert.ok(readable.length > 1, 'precondition: both accounts fetched threads');
  assert.equal(new Set(readable.map((t) => t.threadId)).size, readable.length);

  for (const row of readable) {
    const thread = await call(store, 'gmail_get_thread', { threadId: row.threadId });
    assert.equal(thread.workspaceId, row.workspaceId, 'one account, and it says which');
    assert.equal((thread.messages as MessageRow[]).length, row.messagesHeld);
    for (const message of thread.messages as MessageRow[]) {
      for (const label of message.labels) {
        assert.ok(
          label.startsWith(`${String(row.workspaceId)}/`),
          `${label} is not ${String(row.workspaceId)}'s label`,
        );
      }
    }
  }
  store.close();
});

// ── gmail_list_labels ────────────────────────────────────────────────────────────

test('gmail_list_labels returns labels only, and paginates', async () => {
  const store = seeded();
  const all = await call(store, 'gmail_list_labels', { limit: 500 });
  const labels = all.labels as Array<{ id: string }>;
  assert.ok(labels.length > 1);
  // A thread is a Container too. Counting one as a label turns one mailbox into
  // thousands of them, and the Slack channel is not a Gmail label either.
  for (const label of labels) assert.ok(label.id.startsWith('^'), `${label.id} is a label id`);
  assert.equal(all.total, labels.length);

  const second = await call(store, 'gmail_list_labels', { limit: 1, offset: 1 });
  assert.deepEqual(second.labels, [labels[1]], 'offset walks the same order');
  store.close();
});

// ── gmail_list_threads ───────────────────────────────────────────────────────────

test('gmail_list_threads carries the subject and the sender, not just a preview', async () => {
  // The headline gap: asking to read the latest email returned a 201-character
  // snippet with no subject and no sender on it.
  const store = seeded();
  const rows = (await call(store, 'gmail_list_threads', { limit: 200 })).threads as ThreadRow[];
  assert.ok(rows.length > 0);

  const withSubject = rows.filter((t) => t.subject.length > 0);
  const withSender = rows.filter((t) => t.from !== null);
  assert.ok(withSubject.length > 0, 'threads come back with their subject');
  assert.ok(withSender.length > 0, 'and with who they are from');
  for (const row of withSender) {
    assert.ok(row.from?.address.includes('@'), 'the sender is an address');
  }
  for (const row of rows) {
    assert.ok(row.threadId.length > 0);
    assert.equal(row.date, new Date(row.ts).toISOString());
    assert.notEqual(row.ts, SLACK_TS, 'no Slack item leaked in');
  }
  store.close();
});

test('gmail_list_threads is newest-first and offset walks past the first page', async () => {
  const store = seeded();
  const all = (await call(store, 'gmail_list_threads', { limit: 200 })).threads as ThreadRow[];
  assert.ok(all.length > 3, 'precondition: more than one page at limit 2');
  for (let i = 1; i < all.length; i++) {
    assert.ok((all[i - 1]?.ts ?? 0) >= (all[i]?.ts ?? 0), 'newest first');
  }

  const first = await call(store, 'gmail_list_threads', { limit: 2 });
  const next = await call(store, 'gmail_list_threads', { limit: 2, offset: 2 });
  assert.deepEqual(
    (first.threads as ThreadRow[]).map((t) => t.threadId),
    all.slice(0, 2).map((t) => t.threadId),
  );
  assert.deepEqual(
    (next.threads as ThreadRow[]).map((t) => t.threadId),
    all.slice(2, 4).map((t) => t.threadId),
    'the second page is the next two, not the first two again',
  );
  assert.equal(first.hasMore, true);
  store.close();
});

test('paging through every thread repeats none and drops none', async () => {
  // The regression: the two sources were read as a window of ROWS, and one thread
  // contributes a row per message it holds and a row per label view that listed
  // it — so the newest 5 rows named fewer than 5 threads, and the ones they
  // missed reappeared on the next page. `limit 5` and `limit 5, offset 5` shared
  // a thread against the Gmail recording.
  const store = seeded();
  const all = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  assert.ok(all.length > 20, 'precondition: enough threads to page through several times');

  const seen: string[] = [];
  for (let offset = 0; ; offset += 5) {
    const p = await call(store, 'gmail_list_threads', { limit: 5, offset });
    seen.push(...(p.threads as ThreadRow[]).map((t) => t.threadId));
    if (p.hasMore !== true) break;
    assert.ok(offset < 5_000, 'hasMore must eventually go false');
  }
  assert.equal(new Set(seen).size, seen.length, 'no thread came back twice');
  assert.deepEqual(seen, all.map((t) => t.threadId), 'and the pages are the whole list, in order');
  store.close();
});

test('gmail_list_threads surfaces threads that only a fetch ever named', async () => {
  // 73 of the 84 threads in the source recording were opened directly, from label
  // views that were never captured. They exist only as messages — and they are
  // the ones that actually have a body to read, so a list that showed only what a
  // batch view listed would hide exactly the readable mail.
  const store = seeded();
  const rows = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  const readable = rows.filter((t) => t.messagesHeld > 0);
  assert.ok(readable.length > 0, 'and they come back with their messages counted');
  for (const row of readable) {
    const thread = await call(store, 'gmail_get_thread', { threadId: row.threadId });
    assert.equal((thread.messages as MessageRow[]).length, row.messagesHeld);
  }
  store.close();
});

test('gmail_list_threads scopes to one label view', async () => {
  const store = seeded();
  const all = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  const labelId = all.find((t) => t.labelId !== undefined)?.labelId;
  assert.ok(labelId, 'precondition: the recorded page filed its threads somewhere');

  const scoped = (await call(store, 'gmail_list_threads', { labelId, limit: 500 }))
    .threads as ThreadRow[];
  assert.ok(scoped.length > 0);
  assert.ok(scoped.length < all.length, 'a label is a subset of the mailbox');
  for (const row of scoped) assert.equal(row.labelId, labelId);
});

// ── gmail_get_thread ─────────────────────────────────────────────────────────────

test('gmail_get_thread returns whole messages, oldest first', async () => {
  const store = seeded();
  const rows = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  const target = rows.find((t) => t.messagesHeld > 1) ?? rows.find((t) => t.messagesHeld > 0);
  assert.ok(target, 'precondition: the recording fetched at least one thread');

  const thread = await call(store, 'gmail_get_thread', { threadId: target.threadId });
  const messages = thread.messages as MessageRow[];
  assert.equal(messages.length, target.messagesHeld);
  assert.equal(thread.note, undefined, 'a fetched thread carries no "not captured" note');
  for (let i = 1; i < messages.length; i++) {
    assert.ok((messages[i - 1]?.ts ?? 0) <= (messages[i]?.ts ?? 0), 'a conversation reads forward');
  }
  for (const m of messages) {
    assert.ok(m.id.length > 0);
    assert.ok(m.body.length > 0, 'a message comes back with its body');
    assert.equal(m.date, new Date(m.ts).toISOString());
    assert.ok(Array.isArray(m.to));
    assert.ok(Array.isArray(m.cc));
    assert.ok(Array.isArray(m.labels));
  }
  assert.ok(messages.some((m) => m.from !== null), 'and with who sent it');
  assert.ok(messages.some((m) => m.subject.length > 0), 'and with its subject, kept apart from the body');
  store.close();
});

test('a message body is not the flattened item text', async () => {
  // `Item.text` is `subject\n\nbody`. Handing that back as the body would repeat
  // the subject inside every message a client renders.
  const store = seeded();
  const rows = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  const target = rows.find((t) => t.messagesHeld > 0);
  assert.ok(target);
  const messages = (await call(store, 'gmail_get_thread', { threadId: target.threadId }))
    .messages as MessageRow[];
  const titled = messages.find((m) => m.subject.length > 0);
  assert.ok(titled, 'precondition: this thread has a subject somewhere');
  assert.ok(!titled.body.startsWith(titled.subject), 'the body starts at the body');
  store.close();
});

test('gmail_get_thread says so when the thread was listed but never fetched', async () => {
  const store = seeded();
  const rows = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  const unfetched = rows.find((t) => t.messagesHeld === 0);
  assert.ok(unfetched, 'precondition: the recorded page listed threads it never opened');

  const thread = await call(store, 'gmail_get_thread', { threadId: unfetched.threadId });
  assert.deepEqual(thread.messages, []);
  assert.equal(thread.messagesHeld, 0);
  assert.match(String(thread.note), /has not captured/);
  // Still useful: what the batch view DID say survives, so the answer is "here is
  // what is known and how to get the rest" rather than a bare empty list.
  assert.equal(thread.subject, unfetched.subject);
  assert.ok(String(thread.snippet).length > 0);
  store.close();
});

// ── gmail_search ─────────────────────────────────────────────────────────────────

test('gmail_search reaches into message bodies', async () => {
  // The store used to index snippets alone, so a search could not find a word
  // that appeared only in the text of a message.
  const store = seeded();
  const rows = (await call(store, 'gmail_list_threads', { limit: 500 })).threads as ThreadRow[];
  const target = rows.find((t) => t.messagesHeld > 0);
  assert.ok(target);
  const message = ((await call(store, 'gmail_get_thread', { threadId: target.threadId }))
    .messages as MessageRow[])[0];
  assert.ok(message);

  // A word from deep inside the body, past anything a 201-character snippet or a
  // subject line would have held.
  const words = message.body.split(/\s+/).filter((w) => /^[a-z]{6,}$/i.test(w));
  const deep = words[words.length - 1];
  assert.ok(deep, 'precondition: this body has a long word in it');
  assert.ok(message.body.indexOf(deep) > 200, 'precondition: and it is past the snippet cap');

  const hits = (await call(store, 'gmail_search', { query: deep })).hits as Array<{
    id: string;
    kind: string;
    threadId: string;
    subject: string;
    from: { address: string } | null;
    snippet: string;
  }>;
  assert.ok(
    hits.some((h) => h.id === message.id),
    'the message whose body holds the word comes back',
  );
  const hit = hits.find((h) => h.id === message.id);
  assert.equal(hit?.kind, 'message');
  assert.equal(hit?.threadId, target.threadId);
  assert.ok(hit?.snippet && hit.snippet.length > 0);
  store.close();
});

test('gmail_search stays inside the mailbox and paginates', async () => {
  const store = seeded();
  // The Slack item says "mail" and is the NEWEST row in the store, so it sorts
  // first if the adapter scope is applied after the query instead of inside it.
  const hits = (await call(store, 'gmail_search', { query: 'mail', limit: 500 })).hits as Array<{
    ts: number;
  }>;
  for (const hit of hits) assert.notEqual(hit.ts, SLACK_TS);

  // The most common word across the mailbox, so the page-through has something to
  // page through.
  const common = commonWord(store);

  const all = (await call(store, 'gmail_search', { query: common, limit: 10 })).hits as Array<{
    id: string;
  }>;
  assert.ok(all.length > 3, 'precondition: enough hits to page through');
  const second = (await call(store, 'gmail_search', { query: common, limit: 2, offset: 2 }))
    .hits as Array<{ id: string }>;
  assert.deepEqual(
    second.map((h) => h.id),
    all.slice(2, 4).map((h) => h.id),
  );

  const none = await call(store, 'gmail_search', { query: 'nothingmatchesthisatall' });
  assert.deepEqual(none.hits, []);
  store.close();
});
