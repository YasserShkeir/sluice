// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The explorer's pure parts. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * There is no component-test infrastructure here, so the rule is the same one
 * `filter.ts` follows: anything with a decision in it is a function outside the
 * component, and the component is left with nothing but rendering.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Container, Workspace } from '@sluice/core';
import { bareHandle, coverage, firstLine, treeRows } from './pages/ExplorePage.js';

const ws = (id: string, name = id): Workspace => ({ id, adapterId: 'gmail', name });
const container = (id: string, workspaceId: string, over: Partial<Container> = {}): Container => ({
  id,
  workspaceId,
  adapterId: 'gmail',
  kind: 'other',
  name: id,
  ...over,
});

test('the tree is workspaces with their own containers under them', () => {
  const rows = treeRows(
    [ws('gmail:a@x.test'), ws('gmail:b@x.test')],
    [
      container('gmail:a@x.test/^i', 'gmail:a@x.test'),
      container('gmail:b@x.test/^i', 'gmail:b@x.test'),
      container('gmail:a@x.test/^all', 'gmail:a@x.test'),
    ],
    new Set(),
  );
  assert.deepEqual(
    rows.map((r) => [r.kind, r.id]),
    [
      ['workspace', 'gmail:a@x.test'],
      ['container', 'gmail:a@x.test/^i'],
      ['container', 'gmail:a@x.test/^all'],
      ['workspace', 'gmail:b@x.test'],
      ['container', 'gmail:b@x.test/^i'],
    ],
  );
});

test('two mailboxes never share a container row', () => {
  // The rendering half of the multi-account fix: both accounts have an `^i`,
  // both are called "Inbox", and the tree must still show two of them under the
  // two mailboxes rather than one under whichever sorted first.
  const rows = treeRows(
    [ws('gmail:a@x.test'), ws('gmail:b@x.test')],
    [
      container('gmail:a@x.test/^i', 'gmail:a@x.test', { name: 'Inbox' }),
      container('gmail:b@x.test/^i', 'gmail:b@x.test', { name: 'Inbox' }),
    ],
    new Set(),
  );
  const inboxes = rows.filter((r) => r.label === 'Inbox');
  assert.equal(inboxes.length, 2);
  assert.equal(new Set(inboxes.map((r) => r.id)).size, 2, 'distinct ids, so distinct React keys');
});

test('a collapsed workspace contributes no container rows', () => {
  // Collapsing is FILTERING, not hiding: a virtualizer sizes itself from the row
  // count, so a row that renders as nothing still takes up space in the scroll.
  const rows = treeRows(
    [ws('W1')],
    [container('C1', 'W1'), container('C2', 'W1')],
    new Set(['W1']),
  );
  assert.deepEqual(rows.map((r) => r.kind), ['workspace']);
  assert.equal(rows[0]?.kind === 'workspace' && rows[0].collapsed, true);
});

test('a container whose workspace is missing is not silently dropped into another', () => {
  // Entities arrive from two sources at different times, so a container can be
  // loaded before its workspace. Attaching it to whatever is nearby would file
  // one account's mail under another — the exact bug this release fixed.
  const rows = treeRows([ws('W1')], [container('C1', 'W-unknown')], new Set());
  assert.deepEqual(rows.map((r) => r.id), ['W1']);
});

test('coverage reports the SERVICE count, and says nothing when there is none', () => {
  assert.equal(coverage(container('c', 'w', { itemCount: 14061, unreadCount: 2859 })), '2859 / 14061');
  assert.equal(coverage(container('c', 'w', { itemCount: 2289, unreadCount: 0 })), '2289');
  // Absent means unknown and must not render as zero: "0" is a claim about the
  // account, and a wrong one is worse than no number at all.
  assert.equal(coverage(container('c', 'w')), '');
});

test('the list line is the first line with something on it', () => {
  // An item's text is `subject\n\nbody` for mail, so the naive `split('\n')[0]`
  // is right until a message begins with a blank line.
  assert.equal(firstLine('\n\n  Subject here \nbody'), 'Subject here');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine('   \n \n'), '');
  assert.equal(firstLine('x'.repeat(200)).length, 161, 'clipped, with the ellipsis');
});

test('an actor id renders as the person, not as the primary key', () => {
  assert.equal(bareHandle('gmail:you@example.test/alice@example.test'), 'alice@example.test');
  // Rows written before ids were scoped keep the bare form forever.
  assert.equal(bareHandle('alice@example.test'), 'alice@example.test');
});

test('threads are not places, so the tree does not list them', () => {
  // One container exists per conversation. Listed as peers of the labels, the
  // recorded mailbox showed 24 labels among 94 threads, interleaved
  // alphabetically — the structure was there and unusable.
  const rows = treeRows(
    [ws('W1')],
    [
      container('^i', 'W1', { name: 'Inbox', kind: 'other' }),
      container('thread-f:1', 'W1', { name: 'Re: lunch', kind: 'thread' }),
      container('thread-f:2', 'W1', { name: 'Your receipt', kind: 'thread' }),
    ],
    new Set(),
  );
  assert.deepEqual(rows.map((r) => r.label), ['W1', 'Inbox']);
  assert.equal(rows[0]?.detail, '1', 'and the workspace counts places, not threads');
});
