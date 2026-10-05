// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@sluice/core';
import type { Adapter, ReplayAction, Session } from '@sluice/core';
import { replayBudget } from '@sluice/interceptor';
import {
  anonymousSession,
  defaultParams,
  findReplayAction,
  pickSession,
  runReplayAction,
  sessionForItem,
  structureActions,
} from './replay-actions.js';

function session(id: string, workspaceId?: string): Session {
  return {
    id,
    adapterId: 'slack',
    label: `WS ${id}`,
    workspaceId,
    credentials: { kind: 'none', values: {}, injection: {} },
    discoveredAt: 0,
    source: 'manual',
  };
}

const A = session('sA', 'T_A');
const B = session('sB', 'T_B');

test('an explicit session id is honoured exactly, never substituted', () => {
  assert.deepEqual(pickSession([A, B], { sessionId: 'sB' }, 'Slack'), { ok: true, session: B });
  const miss = pickSession([A, B], { sessionId: 'gone' }, 'Slack');
  assert.equal(miss.ok, false);
  assert.match(miss.ok ? '' : miss.error, /"gone"/);
});

test('several sessions and nothing to choose between them is an error, not sessions[0]', () => {
  const r = pickSession([A, B], {}, 'Slack');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /2 Slack workspaces/);
});

test('the workspace a request names picks its session', () => {
  assert.deepEqual(pickSession([A, B], { workspaceId: 'T_B' }, 'Slack'), { ok: true, session: B });
});

test('a lone session is used even when the workspace is one no session owns', () => {
  // A synthetic or unreconciled workspace id (`slack:<host>`) says nothing about
  // which account to use; stranding a single-workspace user's work would be a
  // regression with no safety gained.
  assert.deepEqual(pickSession([A], { workspaceId: 'slack:app.slack.com' }, 'Slack'), { ok: true, session: A });
  assert.equal(pickSession([A, B], { workspaceId: 'slack:app.slack.com' }, 'Slack').ok, false);
});

test('a drained page goes out as the workspace that owns it, or not at all', () => {
  assert.deepEqual(sessionForItem([A, B], [A, B], 'T_A', 'Slack'), { ok: true, session: A });
  // Owner signed in but outside --workspace B: never sent with B's token.
  const outside = sessionForItem([A, B], [B], 'T_A', 'Slack');
  assert.equal(outside.ok, false);
  assert.match(outside.ok ? '' : outside.error, /WS sA/);
});

test('a drained page no session owns needs the scope to leave exactly one', () => {
  assert.equal(sessionForItem([A, B], [A, B], undefined, 'Slack').ok, false);
  assert.equal(sessionForItem([A, B], [A, B], 'slack:app.slack.com', 'Slack').ok, false);
  assert.deepEqual(sessionForItem([A, B], [B], undefined, 'Slack'), { ok: true, session: B });
});

test('the anonymous session carries no credential', () => {
  const s = anonymousSession('fast');
  assert.equal(s.adapterId, 'fast');
  assert.deepEqual(s.credentials.values, {});
});

// ── the request side ─────────────────────────────────────────────────────────

function action(id: string, params: ReplayAction['params'] = []): ReplayAction {
  return { id, adapterId: 'stub', label: id, method: 'GET', urlTemplate: 'https://stub.example/x', params };
}

function adapter(id: string, actions: ReplayAction[], build?: Adapter['buildReplayRequest']): Adapter {
  return {
    id,
    displayName: id,
    hosts: ['stub.example'],
    matchRequest: () => false,
    parse: () => ({}),
    listReplayActions: () => actions,
    buildReplayRequest: build ?? ((a) => ({ method: a.method, url: a.urlTemplate, headers: {} })),
  };
}

test('defaultParams keeps declared defaults, including empty ones, and skips missing ones', () => {
  const a = action('a', [
    { name: 'limit', label: 'Limit', kind: 'number', default: '0' },
    { name: 'q', label: 'Query', kind: 'string', default: '' },
    { name: 'cursor', label: 'Cursor', kind: 'cursor' },
    // A JS adapter can hand over a null default; it is not a value either.
    { name: 'x', label: 'X', kind: 'string', default: null as unknown as string },
  ]);
  assert.deepEqual(defaultParams(a), { limit: '0', q: '' });
});

test('structureActions keeps only the actions that need no argument', () => {
  const list = action('list', [{ name: 'limit', label: 'Limit', kind: 'number', required: false }]);
  const history = action('history', [{ name: 'channel', label: 'Channel', kind: 'containerId', required: true }]);
  assert.deepEqual(
    structureActions(adapter('a', [list, history])).map((a) => a.id),
    ['list'],
  );
});

test('findReplayAction returns the first adapter declaring the id, or nothing', () => {
  const first = adapter('first', [action('shared')]);
  const second = adapter('second', [action('shared'), action('own')]);
  assert.equal(findReplayAction([first, second], 'shared')?.adapter, first);
  assert.equal(findReplayAction([first, second], 'own')?.adapter, second);
  assert.equal(findReplayAction([first, second], 'missing'), undefined);
});

test('runReplayAction rejects a builder that throws, and sends nothing', async () => {
  const store = new SqliteStore(':memory:');
  const before = replayBudget.snapshot().tokens;
  const broken = adapter('broken', [action('boom')], () => {
    throw new Error('builder failed');
  });
  try {
    await assert.rejects(
      runReplayAction(store, broken, action('boom'), {}, anonymousSession('broken')),
      /builder failed/,
    );
    // No request reached runReplay, so none spent the budget.
    assert.equal(replayBudget.snapshot().tokens, before);
  } finally {
    store.close();
  }
});
