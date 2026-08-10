// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reconciler tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The captures here are minimal by design — a `bv` needs no threads and an `fd`
 * needs one address — because what is under test is the ATTRIBUTION, not the
 * parse. gmail.test.ts covers the parse against a real scrubbed recording.
 *
 * The shape every test is built around is the one a real two-account recording
 * had: 391 captures, two mailboxes, 2.5 hours apart, and every single request
 * on `/u/0/`. That is not a corner case, it is what switching accounts in a
 * browser looks like on the wire.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture } from '@sluice/adapter-sdk';
import { SqliteStore } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { parseGmailCapture, reconcileGmailAccounts, slotLedger } from './index.js';

const HOUR = 3_600_000;

/** A thread-list response: names its slot, names no mailbox. */
function bv(slot: string, ts: number): Capture {
  const res: unknown[] = new Array(19).fill(null);
  res[1] = [[[`^x_${ts}`, 'A Label'], 7]];
  return makeCapture({
    adapterId: 'gmail',
    method: 'POST',
    ts,
    host: 'mail.google.com',
    path: `/sync/u/${slot}/i/bv`,
    url: `https://mail.google.com/sync/u/${slot}/i/bv`,
    reqBody: JSON.stringify([[9, null, null, 'in:^i'], null, [0, 5]]),
    resBody: JSON.stringify(res),
  });
}

/** A message fetch: names its slot AND its mailbox, at `record[11]`. */
function fd(slot: string, ts: number, address: string, threadId = `thread-f:${ts}`): Capture {
  const record: unknown[] = new Array(55).fill(null);
  record[4] = 'Subject';
  record[6] = 'snippet';
  record[11] = [1, address];
  record[16] = ts;
  return makeCapture({
    adapterId: 'gmail',
    method: 'POST',
    ts,
    host: 'mail.google.com',
    path: `/sync/u/${slot}/i/fd`,
    url: `https://mail.google.com/sync/u/${slot}/i/fd`,
    reqBody: JSON.stringify([[[threadId, null, [`msg-f:${ts}`]]], 2]),
    resBody: JSON.stringify([0, [[threadId, null, [[`msg-f:${ts}`, record]]]], null, null, [1]]),
  });
}

/** A store with these captures ingested and parsed, in the order given. */
function stored(captures: Capture[]): SqliteStore {
  const store = new SqliteStore(':memory:');
  for (const capture of captures) {
    store.insertCapture(capture);
    store.applyParseResult(parseGmailCapture(capture), capture.ts);
  }
  return store;
}

const ids = (store: SqliteStore): string[] =>
  store
    .listWorkspaces()
    .filter((w) => w.adapterId === 'gmail')
    .map((w) => w.id)
    .sort();

// ── The bug this exists for ──────────────────────────────────────────────────────

test('two mailboxes served from one slot stay two mailboxes', () => {
  // The recorded failure, in miniature. Both sessions are `/u/0/`, because
  // switching accounts does not move you to `/u/1/` — it leaves the slot alone
  // and changes what is behind it. A slot-keyed store answered this with ONE
  // workspace holding both people's mail.
  const morning = 1_700_000_000_000;
  const afternoon = morning + 2 * HOUR;
  const store = stored([
    fd('0', morning, 'first@example.test'),
    bv('0', morning + 1000),
    fd('0', morning + 2000, 'first@example.test'),
    fd('0', afternoon, 'second@example.test'),
    bv('0', afternoon + 1000),
    fd('0', afternoon + 2000, 'second@example.test'),
  ]);

  assert.deepEqual(ids(store), ['gmail:first@example.test', 'gmail:second@example.test', 'gmail:u0']);
  const report = reconcileGmailAccounts(store);
  assert.deepEqual(report.removed, ['gmail:u0']);
  assert.deepEqual(ids(store), ['gmail:first@example.test', 'gmail:second@example.test']);

  // And the thread lists went to the right mailboxes: one label container each,
  // not two under one of them.
  for (const workspaceId of ids(store)) {
    const labels = store.listContainers(workspaceId).filter((c) => c.id.includes('/^x_'));
    assert.equal(labels.length, 1, `${workspaceId} kept exactly its own thread list`);
  }
  store.close();
});

test('the same mailbox on two different slots is still one mailbox', () => {
  // The converse. Adding a second account shifts an existing mailbox from
  // `/u/0/` to `/u/1/`; a slot-keyed store called that a new account.
  const t = 1_700_000_000_000;
  const store = stored([fd('0', t, 'same@example.test'), fd('1', t + 1000, 'same@example.test')]);
  assert.deepEqual(ids(store), ['gmail:same@example.test']);
  store.close();
});

// ── Bracketing ───────────────────────────────────────────────────────────────────

test('a capture between two agreeing neighbours is resolved', () => {
  const t = 1_700_000_000_000;
  const store = stored([
    fd('0', t, 'a@example.test'),
    bv('0', t + 1000),
    fd('0', t + 2000, 'a@example.test'),
  ]);
  const report = reconcileGmailAccounts(store);
  assert.deepEqual(report.unresolved, []);
  // All three, not just the `bv`. The two fetches are re-parsed as well, because
  // a store written before identity moved to the address has ITS message
  // fetches filed under the slot too — and deleting the placeholder without
  // re-homing those would take most of the mail with it.
  assert.deepEqual(report.resolved, [{ workspaceId: 'gmail:a@example.test', captures: 3 }]);
  assert.deepEqual(ids(store), ['gmail:a@example.test']);
  store.close();
});

test('a store parsed before the fix is re-homed, not deleted out from under', () => {
  // The upgrade path, and the one that has to work on real data: every entity
  // in the store is filed under `gmail:u0` — messages included — because that
  // is what the old parser produced. Reconciliation has to move all of it.
  const t = 1_700_000_000_000;
  const captures = [fd('0', t, 'legacy@example.test'), bv('0', t + 1000)];
  const store = new SqliteStore(':memory:');
  for (const capture of captures) {
    store.insertCapture(capture);
    // The OLD behaviour, forced: everything under the slot, address ignored.
    store.applyParseResult(parseGmailCapture(capture, { workspaceId: 'gmail:u0' }), capture.ts);
  }
  const before = store.countItems({ adapterId: 'gmail' });
  assert.ok(before > 0);
  assert.deepEqual(ids(store), ['gmail:u0']);

  const report = reconcileGmailAccounts(store);
  assert.deepEqual(report.stranded, [], 'every item had a capture to be re-read from');
  assert.deepEqual(report.removed, ['gmail:u0']);
  assert.deepEqual(ids(store), ['gmail:legacy@example.test']);
  assert.equal(
    store.countItems({ adapterId: 'gmail', workspaceId: 'gmail:legacy@example.test' }),
    before,
    'no mail was lost on the way across',
  );
  store.close();
});

test('mail whose capture is gone keeps its placeholder rather than being deleted', () => {
  // Pruning removes captures and leaves the entities derived from them. Those
  // cannot be re-parsed, so they cannot be re-homed — and deleting the
  // placeholder would be deleting the only copy of mail Sluice still holds.
  const t = 1_700_000_000_000;
  const kept = fd('0', t, 'here@example.test');
  const pruned = fd('0', t + 1000, 'here@example.test', 'thread-f:pruned');
  const store = new SqliteStore(':memory:');
  for (const capture of [kept, pruned]) {
    store.applyParseResult(parseGmailCapture(capture, { workspaceId: 'gmail:u0' }), capture.ts);
  }
  store.insertCapture(kept); // `pruned` is deliberately never inserted

  const report = reconcileGmailAccounts(store);
  assert.deepEqual(report.removed, [], 'the placeholder stays');
  assert.deepEqual(report.stranded, [{ workspaceId: 'gmail:u0', items: 1 }]);
  assert.ok(ids(store).includes('gmail:u0'));
  assert.ok(ids(store).includes('gmail:here@example.test'), 'and what COULD be re-read moved');
  store.close();
});

test('a capture between two DISAGREEING neighbours is left alone, and says why', () => {
  // The whole reason the rule is bracketing and not nearest-in-time. A
  // nearest-in-time rule answers this one too, and its answer is a coin flip
  // between two people's mailboxes — which is the bug, not a smaller version
  // of it.
  const t = 1_700_000_000_000;
  const straddler = bv('0', t + 1000);
  const store = stored([
    fd('0', t, 'a@example.test'),
    straddler,
    fd('0', t + 2000, 'b@example.test'),
  ]);
  const report = reconcileGmailAccounts(store);
  assert.deepEqual(report.unresolved, [
    { captureId: straddler.id, slot: '0', reason: 'straddles-a-switch' },
  ]);
  assert.deepEqual(report.removed, [], 'the placeholder is still where that mail lives');
  assert.ok(ids(store).includes('gmail:u0'));
  store.close();
});

test('a slot no fetch ever named cannot be resolved at all', () => {
  const t = 1_700_000_000_000;
  const only = bv('0', t);
  const store = stored([only]);
  const report = reconcileGmailAccounts(store);
  assert.deepEqual(report.unresolved, [{ captureId: only.id, slot: '0', reason: 'no-binding' }]);
  assert.deepEqual(ids(store), ['gmail:u0']);
  assert.deepEqual(slotLedger(store), [], 'nothing proved a binding, so the ledger is empty');
  store.close();
});

test('a capture at either edge of the recording takes its one neighbour', () => {
  // A `bv` before the first fetch is at the start of a session, not at a switch;
  // discarding it would throw away every thread list from a session that ended
  // before Gmail opened a message.
  const t = 1_700_000_000_000;
  for (const [label, captures] of [
    ['before the first binding', [bv('0', t), fd('0', t + 1000, 'edge@example.test')]],
    ['after the last binding', [fd('0', t, 'edge@example.test'), bv('0', t + 1000)]],
  ] as const) {
    const store = stored([...captures]);
    const report = reconcileGmailAccounts(store);
    assert.deepEqual(report.unresolved, [], label);
    assert.deepEqual(ids(store), ['gmail:edge@example.test'], label);
    store.close();
  }
});

test('slots are reconciled independently', () => {
  const t = 1_700_000_000_000;
  const store = stored([
    fd('0', t, 'a@example.test'),
    bv('0', t + 1000),
    bv('1', t + 2000),
    fd('1', t + 3000, 'b@example.test'),
  ]);
  reconcileGmailAccounts(store);
  assert.deepEqual(ids(store), ['gmail:a@example.test', 'gmail:b@example.test']);
  // Label containers only: each mailbox also holds the thread its own fetch
  // created, and those were never in question.
  const labels = (ws: string): string[] =>
    store.listContainers(ws).map((c) => c.id).filter((id) => id.includes('/^x_'));
  const a = labels('gmail:a@example.test');
  const b = labels('gmail:b@example.test');
  assert.equal(a.length, 1, "slot 0's thread list went to slot 0's mailbox");
  assert.equal(b.length, 1, "and slot 1's to slot 1's");
  assert.equal(new Set([...a, ...b]).size, 2, 'no label container is shared');
  store.close();
});

// ── Properties ───────────────────────────────────────────────────────────────────

test('reconciling twice changes nothing the second time', () => {
  const t = 1_700_000_000_000;
  const store = stored([
    fd('0', t, 'a@example.test'),
    bv('0', t + 1000),
    fd('0', t + 2000, 'a@example.test'),
  ]);
  reconcileGmailAccounts(store);
  const after = JSON.stringify(store.listContainers().map((c) => [c.id, c.workspaceId, c.name]));

  const second = reconcileGmailAccounts(store);
  assert.deepEqual(second, { removed: [], resolved: [], unresolved: [], stranded: [] });
  assert.equal(JSON.stringify(store.listContainers().map((c) => [c.id, c.workspaceId, c.name])), after);
  store.close();
});

test('reconciling never touches the captures', () => {
  // The contract that makes this safe to run: entities are one reading of the
  // evidence, and a reading that turns out wrong is fixed by re-reading. If the
  // evidence went with it there would be nothing to re-read.
  const t = 1_700_000_000_000;
  const store = stored([
    fd('0', t, 'a@example.test'),
    bv('0', t + 1000),
    fd('0', t + 2000, 'a@example.test'),
  ]);
  const before = store.countCaptures();
  reconcileGmailAccounts(store);
  assert.equal(store.countCaptures(), before);
  store.close();
});

test('the ledger records one binding per fetch, oldest first', () => {
  const t = 1_700_000_000_000;
  const store = stored([
    fd('0', t + 2 * HOUR, 'second@example.test'),
    bv('0', t + 1000),
    fd('0', t, 'first@example.test'),
  ]);
  assert.deepEqual(
    slotLedger(store).map((b) => [b.slot, b.address]),
    [
      ['0', 'first@example.test'],
      ['0', 'second@example.test'],
    ],
  );
  store.close();
});
