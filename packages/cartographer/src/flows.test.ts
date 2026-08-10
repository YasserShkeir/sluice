// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Flow-clustering tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@sluice/core';
import type { Capture } from '@sluice/core';
import {
  clusterCaptureList,
  clusterCapturesIntoFlows,
  DEFAULT_FLOW_WINDOW_MS,
} from './flows.js';

const T0 = 1_700_000_000_000;

function capture(over: Partial<Capture> = {}): Capture {
  return {
    id: 'cap',
    ts: T0,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/api.test',
    host: 'slack.com',
    path: '/api/api.test',
    status: 200,
    durationMs: 10,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: null,
    ...over,
  };
}

test('DEFAULT_FLOW_WINDOW_MS is in the planned 300–1500ms band', () => {
  assert.ok(DEFAULT_FLOW_WINDOW_MS >= 300 && DEFAULT_FLOW_WINDOW_MS <= 1500);
});

test('captures within the window become one flow with companions', () => {
  const flows = clusterCaptureList([
    capture({
      id: 'hist',
      ts: T0,
      path: '/api/conversations.history',
      url: 'https://slack.com/api/conversations.history',
      classification: 'conversations.history',
    }),
    capture({
      id: 'members',
      ts: T0 + 40,
      path: '/api/conversations.members',
      url: 'https://slack.com/api/conversations.members',
      classification: 'conversations.members',
    }),
    capture({
      id: 'emoji',
      ts: T0 + 80,
      path: '/api/emoji.list',
      url: 'https://slack.com/api/emoji.list',
      classification: 'emoji.list',
    }),
  ]);

  assert.equal(flows.length, 1);
  const f = flows[0]!;
  assert.equal(f.source, 'observed');
  assert.equal(f.adapterId, 'slack');
  assert.equal(f.primaryCaptureId, 'hist');
  assert.equal(f.label, 'conversations.history');
  assert.equal(f.steps.length, 3);
  assert.equal(f.startedAt, T0);
  assert.equal(f.endedAt, T0 + 80);

  const primary = f.steps.find((s) => s.role === 'primary');
  assert.equal(primary?.captureId, 'hist');
  assert.equal(primary?.required, true);
  assert.ok(f.steps.every((s) => (s.role === 'primary' ? s.required : !s.required)));
});

test('a gap larger than the window splits into separate bursts', () => {
  const flows = clusterCaptureList(
    [
      capture({
        id: 'a1',
        ts: T0,
        classification: 'conversations.history',
        path: '/api/conversations.history',
      }),
      capture({
        id: 'a2',
        ts: T0 + 50,
        classification: 'users.info',
        path: '/api/users.info',
      }),
      // Gap of 5s — new burst.
      capture({
        id: 'b1',
        ts: T0 + 5_000,
        classification: 'conversations.list',
        path: '/api/conversations.list',
      }),
      capture({
        id: 'b2',
        ts: T0 + 5_100,
        classification: 'users.list',
        path: '/api/users.list',
      }),
    ],
    { windowMs: 1000 },
  );

  assert.equal(flows.length, 2);
  const ids = flows.map((f) => f.primaryCaptureId).sort();
  // Newest first overall; primaries should be the classified API ops.
  assert.ok(ids.includes('a1'));
  assert.ok(ids.includes('b1'));
});

test('same tab groups together; different tabs stay separate even if simultaneous', () => {
  const flows = clusterCaptureList([
    capture({
      id: 't1-p',
      ts: T0,
      tabId: 'tab-1',
      classification: 'conversations.history',
      path: '/api/conversations.history',
    }),
    capture({
      id: 't1-c',
      ts: T0 + 20,
      tabId: 'tab-1',
      classification: 'users.info',
      path: '/api/users.info',
    }),
    capture({
      id: 't2-p',
      ts: T0 + 10,
      tabId: 'tab-2',
      classification: 'conversations.list',
      path: '/api/conversations.list',
    }),
    capture({
      id: 't2-c',
      ts: T0 + 30,
      tabId: 'tab-2',
      classification: 'emoji.list',
      path: '/api/emoji.list',
    }),
  ]);

  assert.equal(flows.length, 2);
  const byPrimary = new Map(flows.map((f) => [f.primaryCaptureId, f]));
  assert.deepEqual(
    byPrimary.get('t1-p')?.steps.map((s) => s.captureId).sort(),
    ['t1-c', 't1-p'],
  );
  assert.deepEqual(
    byPrimary.get('t2-p')?.steps.map((s) => s.captureId).sort(),
    ['t2-c', 't2-p'],
  );
});

test('replay and import sources are ignored; only observed traffic clusters', () => {
  const flows = clusterCaptureList([
    capture({
      id: 'live-p',
      ts: T0,
      source: 'mitm',
      classification: 'conversations.history',
      path: '/api/conversations.history',
    }),
    capture({
      id: 'live-c',
      ts: T0 + 30,
      source: 'cdp',
      classification: 'users.info',
      path: '/api/users.info',
    }),
    capture({
      id: 'replayed',
      ts: T0 + 40,
      source: 'replay',
      classification: 'conversations.history',
      path: '/api/conversations.history',
    }),
    capture({
      id: 'imported',
      ts: T0 + 50,
      source: 'import',
      classification: 'emoji.list',
      path: '/api/emoji.list',
    }),
  ]);

  assert.equal(flows.length, 1);
  assert.deepEqual(
    flows[0]!.steps.map((s) => s.captureId).sort(),
    ['live-c', 'live-p'],
  );
});

test('auth-shaped companions get role auth', () => {
  const flows = clusterCaptureList([
    capture({
      id: 'p',
      ts: T0,
      classification: 'conversations.history',
      path: '/api/conversations.history',
    }),
    capture({
      id: 'tok',
      ts: T0 + 10,
      classification: 'auth.test',
      path: '/api/auth.test',
    }),
  ]);

  assert.equal(flows.length, 1);
  const auth = flows[0]!.steps.find((s) => s.captureId === 'tok');
  assert.equal(auth?.role, 'auth');
  assert.equal(auth?.required, false);
  assert.equal(flows[0]!.primaryCaptureId, 'p');
});

test('singleton bursts are dropped by default and kept when minSteps is 1', () => {
  const alone = [
    capture({
      id: 'solo',
      ts: T0,
      classification: 'api.test',
      path: '/api/api.test',
    }),
  ];
  assert.equal(clusterCaptureList(alone).length, 0);
  assert.equal(clusterCaptureList(alone, { minSteps: 1 }).length, 1);
});

test('clusterCapturesIntoFlows reads the store and can be persisted', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'p',
      ts: T0,
      classification: 'conversations.history',
      path: '/api/conversations.history',
      url: 'https://slack.com/api/conversations.history',
    }),
  );
  store.insertCapture(
    capture({
      id: 'c',
      ts: T0 + 25,
      classification: 'users.info',
      path: '/api/users.info',
      url: 'https://slack.com/api/users.info',
    }),
  );
  // Different adapter — must not join the slack burst.
  store.insertCapture(
    capture({
      id: 'g1',
      ts: T0 + 30,
      adapterId: 'gmail',
      host: 'gmail.google.com',
      path: '/sync',
      url: 'https://gmail.google.com/sync',
      classification: 'sync',
    }),
  );
  store.insertCapture(
    capture({
      id: 'g2',
      ts: T0 + 40,
      adapterId: 'gmail',
      host: 'gmail.google.com',
      path: '/thread',
      url: 'https://gmail.google.com/thread',
      classification: 'thread',
    }),
  );

  const proposed = clusterCapturesIntoFlows(store, { adapterId: 'slack' });
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]!.adapterId, 'slack');

  const saved = store.upsertFlow(proposed[0]!);
  assert.equal(store.listFlows({ adapterId: 'slack' }).length, 1);
  assert.equal(store.getFlow(saved.id)?.steps.length, 2);

  const all = clusterCapturesIntoFlows(store);
  assert.equal(all.length, 2, 'slack + gmail bursts');
  store.close();
});

test('unclassified traffic without adapterId is skipped', () => {
  const flows = clusterCaptureList([
    capture({ id: 'x', adapterId: null, ts: T0 }),
    capture({ id: 'y', adapterId: null, ts: T0 + 10 }),
  ]);
  assert.equal(flows.length, 0);
});

test('static assets never seed the primary when an API call is in the burst', () => {
  const flows = clusterCaptureList([
    capture({
      id: 'js',
      ts: T0,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/assets/app-abc123.js',
      url: 'https://trello.com/assets/app-abc123.js',
      method: 'GET',
      classification: 'asset',
    }),
    capture({
      id: 'card',
      ts: T0 + 30,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/1/cards/c1',
      url: 'https://trello.com/1/cards/c1',
      method: 'GET',
      classification: 'cards/:id',
    }),
  ]);
  assert.equal(flows.length, 1);
  assert.equal(flows[0]!.primaryCaptureId, 'card');
  assert.equal(flows[0]!.label, 'cards/:id');
});

test('REST /1/ resource beats gateway GraphQL when both are in the burst', () => {
  // Live Trello board open: gateway storms + board GET. Prefer the resource.
  const flows = clusterCaptureList([
    capture({
      id: 'gql',
      ts: T0,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/gateway/api/graphql',
      url: 'https://trello.com/gateway/api/graphql',
      method: 'POST',
      classification: 'gateway/api/graphql',
    }),
    capture({
      id: 'board',
      ts: T0 + 20,
      adapterId: 'trello',
      host: 'trello.com',
      path: `/1/boards/${'5f3a91c8e4b0a2d1f9c37e5b'}`,
      url: `https://trello.com/1/boards/${'5f3a91c8e4b0a2d1f9c37e5b'}`,
      method: 'GET',
      classification: 'boards/:id',
    }),
  ]);
  assert.equal(flows.length, 1);
  assert.equal(flows[0]!.primaryCaptureId, 'board');
});
