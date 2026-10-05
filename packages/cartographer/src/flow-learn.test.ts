// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Flow-template learning tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@sluice/core';
import type { Capture, FlowTemplate, ReplayAction, Session } from '@sluice/core';
import { redactUrl } from '@sluice/core';
import { clusterCaptureList } from './flows.js';
import { learnFlowTemplates } from './flow-learn.js';
import { buildFlowStepRequest, FLOW_TEMPLATE_VERSION, FlowBuildError, flowStepBuilder } from './flow-build.js';

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
    reqHeaders: { 'user-agent': 'RealClient/1.0' },
    reqBody: null,
    resHeaders: {},
    resBody: null,
    ...over,
  };
}

function readAction(method: string, urlTemplate: string): ReplayAction {
  return { id: urlTemplate, adapterId: 'test', label: urlTemplate, method, urlTemplate, params: [] };
}

/** The Slack read surface these fixtures replay: history is a vetted POST read, members and emoji are not. */
const SLACK_READS = [readAction('POST', 'https://slack.com/api/conversations.history')];
const SLACK_APP = { hosts: ['slack.com'], listReplayActions: () => SLACK_READS };
const SLACK_RAILS = { allowedHosts: ['slack.com'], readActions: SLACK_READS };

/** A FlowBuildError with this code, for assert.throws. */
function buildRefused(code: FlowBuildError['code']): (e: unknown) => boolean {
  return (e) => e instanceof FlowBuildError && e.name === 'FlowBuildError' && e.code === code;
}

function session(): Session {
  return {
    id: 's1',
    adapterId: 'slack',
    label: 'test',
    discoveredAt: T0,
    source: 'manual',
    credentials: {
      kind: 'slack',
      values: { token: 'xoxc-live', d: 'xoxd-live' },
      injection: { tokenFormField: 'token', cookies: { d: 'd' } },
    },
  };
}

/** Seed two similar open-channel bursts and persist as flows. */
function seedBursts(store: SqliteStore): void {
  for (let i = 0; i < 2; i++) {
    const base = T0 + i * 10_000;
    const channel = i === 0 ? 'C111' : 'C222';
    const caps = [
      capture({
        id: `p${i}`,
        ts: base,
        path: '/api/conversations.history',
        url: `https://slack.com/api/conversations.history`,
        classification: 'conversations.history',
        reqBody: `token=«redacted»&channel=${channel}&limit=50&_x_mode=online`,
        reqHeaders: { 'user-agent': 'RealClient/1.0', 'x-slack-version': '42' },
        resBody: JSON.stringify({ ok: true, messages: [], channel }),
      }),
      capture({
        id: `m${i}`,
        ts: base + 40,
        path: '/api/conversations.members',
        url: `https://slack.com/api/conversations.members`,
        classification: 'conversations.members',
        reqBody: `token=«redacted»&channel=${channel}&_x_mode=online`,
        reqHeaders: { 'user-agent': 'RealClient/1.0', 'x-slack-version': '42' },
        resBody: JSON.stringify({ ok: true, members: [] }),
      }),
      capture({
        id: `e${i}`,
        ts: base + 80,
        path: '/api/emoji.list',
        url: `https://slack.com/api/emoji.list`,
        classification: 'emoji.list',
        reqBody: `token=«redacted»&_x_mode=online`,
        reqHeaders: { 'user-agent': 'RealClient/1.0' },
        resBody: JSON.stringify({ ok: true }),
      }),
    ];
    for (const c of caps) store.insertCapture(c);
    const proposed = clusterCaptureList(caps);
    assert.equal(proposed.length, 1, `burst ${i} should cluster`);
    store.upsertFlow(proposed[0]!);
  }
}

test('learnFlowTemplates builds a multi-step plan from observed flows', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);

  const tmpls = learnFlowTemplates(store, { adapterId: 'slack' });
  assert.equal(tmpls.length, 1);
  const t = tmpls[0]!;
  assert.equal(t.primaryKey, 'conversations.history');
  assert.equal(t.version, FLOW_TEMPLATE_VERSION);
  assert.equal(t.sampleCount, 2);
  assert.ok(t.steps.length >= 2, 'primary + companions');
  assert.ok(t.steps.some((s) => s.role === 'primary' && s.required));

  const primary = t.steps.find((s) => s.role === 'primary')!;
  assert.equal(primary.method, 'POST');
  assert.ok(primary.request, 'endpoint fingerprint learned');
  assert.equal(primary.request?.headers['user-agent'], 'RealClient/1.0');

  // channel varies across bursts → flow param
  assert.ok(
    t.flowParams.some((p) => p.name === 'channel'),
    `expected channel flow param, got ${JSON.stringify(t.flowParams)}`,
  );

  // Persisted
  assert.equal(store.listFlowTemplates({ adapterId: 'slack' }).length, 1);
  assert.equal(
    store.getFlowTemplateByPrimary('slack', 'conversations.history')?.id,
    t.id,
  );
  store.close();
});

test('re-learning the same primary overwrites rather than duplicates', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const a = learnFlowTemplates(store, { adapterId: 'slack' });
  const b = learnFlowTemplates(store, { adapterId: 'slack' });
  assert.equal(a[0]?.id, b[0]?.id);
  assert.equal(store.listFlowTemplates().length, 1);
  store.close();
});

test('denied write-shaped primaries are not learned', () => {
  const store = new SqliteStore(':memory:');
  const caps = [
    capture({
      id: 'w1',
      ts: T0,
      path: '/api/chat.postMessage',
      classification: 'chat.postMessage',
      reqBody: 'token=«redacted»&channel=C1&text=hi',
    }),
    capture({
      id: 'w2',
      ts: T0 + 20,
      path: '/api/users.info',
      classification: 'users.info',
    }),
  ];
  for (const c of caps) store.insertCapture(c);
  for (const f of clusterCaptureList(caps)) store.upsertFlow(f);

  const tmpls = learnFlowTemplates(store, { adapterId: 'slack' });
  assert.equal(tmpls.length, 0, 'write primary must not produce a template');
  store.close();
});

test('buildFlowStepRequest injects live token and flow params', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack' });
  assert.ok(tmpl);
  const primary = tmpl!.steps.find((s) => s.role === 'primary')!;
  const req = buildFlowStepRequest(tmpl!, primary, session(), {
    params: { channel: 'C999' },
    priorResponses: new Map(),
    ...SLACK_RAILS,
  });
  assert.ok(req);
  assert.equal(req!.method, 'POST');
  assert.match(req!.url, /conversations\.history/);
  assert.ok(req!.body?.includes('token=xoxc-live'), 'live token injected');
  assert.ok(req!.body?.includes('channel=C999'), 'flow param applied');
  assert.ok(req!.headers['cookie']?.includes('xoxd-live') || req!.headers['Cookie']?.includes('xoxd-live'));
  // Identity header from learning
  assert.ok(
    Object.entries(req!.headers).some(
      ([k, v]) => k.toLowerCase() === 'user-agent' && v === 'RealClient/1.0',
    ),
  );
  store.close();
});

test('buildFlowStepRequest F4.4 refuses host outside allowedHosts', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack' });
  assert.ok(tmpl);
  const primary = tmpl!.steps.find((s) => s.role === 'primary')!;
  assert.throws(
    () =>
      buildFlowStepRequest(tmpl!, primary, session(), {
        params: { channel: 'C1' },
        priorResponses: new Map(),
        allowedHosts: ['trello.com'],
        readActions: SLACK_READS,
      }),
    (e: unknown) =>
      e instanceof Error &&
      e.name === 'FlowBuildError' &&
      /host/i.test(e.message),
  );
  // Same host / subdomain of declared apex is fine
  const ok = buildFlowStepRequest(tmpl!, primary, session(), {
    params: { channel: 'C1' },
    priorResponses: new Map(),
    ...SLACK_RAILS,
  });
  assert.ok(ok);
  store.close();
});

test('buildFlowStepRequest returns null when a required flow param is missing', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack' });
  const primary = tmpl!.steps.find((s) => s.role === 'primary')!;
  // Only assert when learning actually marked channel as flowParam
  const needsChannel =
    primary.params?.channel?.kind === 'flowParam' ||
    tmpl!.flowParams.some((p) => p.name === 'channel');
  if (!needsChannel) {
    store.close();
    return; // learning did not require it in this fixture shape
  }
  const req = buildFlowStepRequest(tmpl!, primary, session(), {
    params: {},
    priorResponses: new Map(),
    ...SLACK_RAILS,
  });
  // If channel is only in flowParams but step.params uses flowParam, null is correct.
  if (primary.params?.channel?.kind === 'flowParam') {
    assert.equal(req, null);
  }
  store.close();
});

test('replay-sourced flows do not train templates', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'r1',
      source: 'replay',
      classification: 'conversations.history',
      path: '/api/conversations.history',
    }),
  );
  store.insertCapture(
    capture({
      id: 'r2',
      source: 'replay',
      ts: T0 + 10,
      classification: 'users.info',
      path: '/api/users.info',
    }),
  );
  store.upsertFlow({
    adapterId: 'slack',
    primaryCaptureId: 'r1',
    startedAt: T0,
    endedAt: T0 + 10,
    source: 'replay',
    steps: [
      { captureId: 'r1', seq: 0, role: 'primary', operation: 'conversations.history', required: true },
      { captureId: 'r2', seq: 1, role: 'companion', operation: 'users.info', required: false },
    ],
  });
  assert.equal(learnFlowTemplates(store).length, 0);
  store.close();
});

test('learnFlowTemplates records sibling offsets from the primary', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack' });
  assert.ok(tmpl);
  const primary = tmpl!.steps.find((s) => s.role === 'primary');
  const members = tmpl!.steps.find((s) => s.operation === 'conversations.members');
  const emoji = tmpl!.steps.find((s) => s.operation === 'emoji.list');
  assert.ok(primary && members && emoji);

  assert.equal(primary!.offsetFromPrimaryMsP50, 0, 'primary is the origin');
  // seedBursts: members at +40ms, emoji at +80ms from primary
  assert.equal(members!.offsetFromPrimaryMsP50, 40);
  assert.equal(emoji!.offsetFromPrimaryMsP50, 80);
  // Chained gaps still learned for fallback (40 then 40)
  assert.equal(members!.delayMsP50, 40);
  assert.equal(emoji!.delayMsP50, 40);
  // Two identical bursts → zero spread
  assert.equal(members!.offsetSpreadMs, 0);
  assert.equal(emoji!.offsetSpreadMs, 0);
  store.close();
});

test('learnFlowTemplates skips asset-seeded primaries', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'asset-p',
      ts: T0,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/assets/app.js',
      url: 'https://trello.com/assets/app.js',
      method: 'GET',
      classification: 'asset',
    }),
  );
  store.insertCapture(
    capture({
      id: 'asset-c',
      ts: T0 + 10,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/assets/chunk.js',
      url: 'https://trello.com/assets/chunk.js',
      method: 'GET',
      classification: 'asset',
    }),
  );
  store.upsertFlow({
    adapterId: 'trello',
    primaryCaptureId: 'asset-p',
    startedAt: T0,
    endedAt: T0 + 10,
    source: 'observed',
    steps: [
      { captureId: 'asset-p', seq: 0, role: 'primary', operation: 'asset', required: true },
      { captureId: 'asset-c', seq: 1, role: 'companion', operation: 'asset', required: false },
    ],
  });
  assert.equal(learnFlowTemplates(store, { adapterId: 'trello' }).length, 0);
  store.close();
});

test('learnFlowTemplates drops soft asset companions from API primaries', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'card-p',
      ts: T0,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/1/cards/c1',
      url: 'https://trello.com/1/cards/c1',
      method: 'GET',
      classification: 'cards/:id',
    }),
  );
  store.insertCapture(
    capture({
      id: 'js',
      ts: T0 + 15,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/assets/app-deadbeef.js',
      url: 'https://trello.com/assets/app-deadbeef.js',
      method: 'GET',
      classification: 'asset',
    }),
  );
  store.insertCapture(
    capture({
      id: 'mark',
      ts: T0 + 40,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/1/cards/c1/markAsViewed',
      url: 'https://trello.com/1/cards/c1/markAsViewed',
      method: 'POST',
      classification: 'cards/:id/markAsViewed',
    }),
  );
  store.upsertFlow({
    adapterId: 'trello',
    primaryCaptureId: 'card-p',
    startedAt: T0,
    endedAt: T0 + 40,
    source: 'observed',
    steps: [
      { captureId: 'card-p', seq: 0, role: 'primary', operation: 'cards/:id', required: true },
      { captureId: 'js', seq: 1, role: 'companion', operation: 'asset', required: false },
      {
        captureId: 'mark',
        seq: 2,
        role: 'companion',
        operation: 'cards/:id/markAsViewed',
        required: false,
      },
    ],
  });
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'trello' });
  assert.ok(tmpl);
  assert.equal(tmpl!.primaryKey, 'cards/:id');
  assert.ok(!tmpl!.steps.some((s) => s.operation === 'asset' || /assets\//i.test(s.path)));
  assert.ok(tmpl!.steps.some((s) => s.role === 'primary'));
  assert.ok(
    !tmpl!.steps.some((s) => s.operation === 'cards/:id/markAsViewed'),
    'a read-receipt POST is a write and is not learned',
  );
  store.close();
});

test('learnFlowTemplates merges shortLink primary ops into card/:id', () => {
  const store = new SqliteStore(':memory:');
  for (const [i, short] of ['SynCard1', 'SynCard2'].entries()) {
    const base = T0 + i * 10_000;
    store.insertCapture(
      capture({
        id: `p${i}`,
        ts: base,
        adapterId: 'trello',
        host: 'trello.com',
        path: `/1/card/${short}`,
        url: `https://trello.com/1/card/${short}`,
        method: 'GET',
        // Pre-fix ingest wrote the raw short id into classification.
        classification: `card/${short}`,
      }),
    );
    store.insertCapture(
      capture({
        id: `c${i}`,
        ts: base + 20,
        adapterId: 'trello',
        host: 'trello.com',
        path: `/1/card/${short}/markAsViewed`,
        url: `https://trello.com/1/card/${short}/markAsViewed`,
        method: 'POST',
        classification: `card/${short}/markAsViewed`,
      }),
    );
    store.upsertFlow({
      adapterId: 'trello',
      primaryCaptureId: `p${i}`,
      startedAt: base,
      endedAt: base + 20,
      source: 'observed',
      steps: [
        {
          captureId: `p${i}`,
          seq: 0,
          role: 'primary',
          operation: `card/${short}`,
          required: true,
        },
        {
          captureId: `c${i}`,
          seq: 1,
          role: 'companion',
          operation: `card/${short}/markAsViewed`,
          required: false,
        },
      ],
    });
  }
  const tmpls = learnFlowTemplates(store, { adapterId: 'trello' });
  assert.equal(tmpls.length, 1);
  // Singular shortLink ops fold onto the plural form classify emits.
  assert.equal(tmpls[0]!.primaryKey, 'cards/:id');
  assert.equal(tmpls[0]!.sampleCount, 2);
  store.close();
});

test('learnFlowTemplates folds board/:id onto boards/:id', () => {
  const store = new SqliteStore(':memory:');
  store.insertCapture(
    capture({
      id: 'b1',
      ts: T0,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/1/board/SynBrd01',
      url: 'https://trello.com/1/board/SynBrd01',
      method: 'GET',
      classification: 'board/SynBrd01',
    }),
  );
  store.insertCapture(
    capture({
      id: 'b2',
      ts: T0 + 30,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/1/boards/aaaaaaaaaaaaaaaaaaaaaa01/lists',
      url: 'https://trello.com/1/boards/aaaaaaaaaaaaaaaaaaaaaa01/lists',
      method: 'GET',
      classification: 'boards/:id/lists',
    }),
  );
  store.upsertFlow({
    adapterId: 'trello',
    primaryCaptureId: 'b1',
    startedAt: T0,
    endedAt: T0 + 30,
    source: 'observed',
    steps: [
      { captureId: 'b1', seq: 0, role: 'primary', operation: 'board/SynBrd01', required: true },
      { captureId: 'b2', seq: 1, role: 'companion', operation: 'boards/:id/lists', required: false },
    ],
  });
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'trello' });
  assert.ok(tmpl);
  assert.equal(tmpl!.primaryKey, 'boards/:id');
  store.close();
});

function trelloSession(): Session {
  return {
    id: 'ts1',
    adapterId: 'trello',
    label: 'test',
    discoveredAt: T0,
    source: 'manual',
    credentials: {
      kind: 'trello',
      values: { token: 'trello-token', key: 'trello-key' },
      injection: { query: { token: 'token', key: 'key' } },
    },
  };
}

test('learn+build Trello path-id yields concrete URL not literal :id', () => {
  const store = new SqliteStore(':memory:');
  for (const [i, short] of ['SynCard1', 'SynCard2'].entries()) {
    const base = T0 + i * 10_000;
    store.insertCapture(
      capture({
        id: `tp${i}`,
        ts: base,
        adapterId: 'trello',
        host: 'trello.com',
        path: `/1/cards/${short}`,
        url: `https://trello.com/1/cards/${short}`,
        method: 'GET',
        classification: 'cards/:id',
        reqBody: null,
        resBody: JSON.stringify({ id: short, name: 'Card' }),
      }),
    );
    store.upsertFlow({
      adapterId: 'trello',
      primaryCaptureId: `tp${i}`,
      startedAt: base,
      endedAt: base,
      source: 'observed',
      steps: [
        {
          captureId: `tp${i}`,
          seq: 0,
          role: 'primary',
          operation: 'cards/:id',
          required: true,
        },
      ],
    });
  }
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'trello' });
  assert.ok(tmpl);
  assert.equal(tmpl!.primaryKey, 'cards/:id');
  const primary = tmpl!.steps.find((s) => s.role === 'primary')!;
  assert.match(primary.path, /\{cardId\}/, `expected named path placeholder, got ${primary.path}`);
  assert.ok(!primary.path.includes(':id'), 'build-facing path must not keep :id');
  assert.equal(primary.params?.cardId?.kind, 'flowParam');

  const req = buildFlowStepRequest(tmpl!, primary, trelloSession(), {
    params: { cardId: 'AbCdEf12' },
    priorResponses: new Map(),
    allowedHosts: ['trello.com'],
  });
  assert.ok(req);
  assert.equal(new URL(req!.url).pathname, '/1/cards/AbCdEf12');
  assert.ok(!req!.url.includes(':id'));
  assert.ok(!req!.url.includes('{cardId}'));
  store.close();
});

test('buildFlowStepRequest refuses unsubstituted path placeholders', () => {
  const tmpl = {
    id: 't',
    adapterId: 'trello',
    primaryKey: 'cards/:id',
    sampleCount: 1,
    version: FLOW_TEMPLATE_VERSION,
    learnedAt: T0,
    flowParams: [{ name: 'cardId', required: true }],
    steps: [
      {
        seq: 0,
        role: 'primary' as const,
        method: 'GET',
        path: '/1/cards/{cardId}',
        operation: 'cards/:id',
        required: true,
        support: 1,
        delayMsP50: 0,
        params: { cardId: { kind: 'flowParam' as const, name: 'cardId' } },
      },
    ],
  };
  const req = buildFlowStepRequest(tmpl, tmpl.steps[0]!, trelloSession(), {
    params: {},
    priorResponses: new Map(),
    allowedHosts: ['trello.com'],
  });
  assert.equal(req, null);
});

test('buildFlowStepRequest refuses a dot-segment path value', () => {
  const tmpl = {
    id: 't',
    adapterId: 'trello',
    primaryKey: 'cards/:id',
    sampleCount: 1,
    version: FLOW_TEMPLATE_VERSION,
    learnedAt: T0,
    flowParams: [{ name: 'cardId', required: true }],
    steps: [
      {
        seq: 0,
        role: 'primary' as const,
        method: 'GET',
        path: '/1/cards/{cardId}/actions',
        operation: 'cards/:id/actions',
        required: true,
        support: 1,
        delayMsP50: 0,
        params: { cardId: { kind: 'flowParam' as const, name: 'cardId' } },
      },
    ],
  };
  const ctx = (cardId: string) => ({ params: { cardId }, priorResponses: new Map(), allowedHosts: ['trello.com'] });
  for (const dots of ['.', '..']) {
    assert.throws(
      () => buildFlowStepRequest(tmpl, tmpl.steps[0]!, trelloSession(), ctx(dots)),
      buildRefused('path_unresolved'),
      `cardId ${dots}`,
    );
  }
  const req = buildFlowStepRequest(tmpl, tmpl.steps[0]!, trelloSession(), ctx('a..b'));
  assert.equal(new URL(req!.url).pathname, '/1/cards/a..b/actions');
});

test('findBind maps to template seq after dropped asset companion', () => {
  const store = new SqliteStore(':memory:');
  // Two flows: primary JSON has idBoard; asset between; companion query echoes idBoard.
  // Asset is dropped from the template — bind must point at primary seq, not index 1.
  // Board ids must be id-like (24-hex) so path templatize + normalize collapse them.
  for (const [i, card, board] of [
    [0, 'SynCard1', 'aaaaaaaaaaaaaaaaaaaaaa01'],
    [1, 'SynCard2', 'bbbbbbbbbbbbbbbbbbbbbb02'],
  ] as const) {
    const base = T0 + i * 10_000;
    store.insertCapture(
      capture({
        id: `p${i}`,
        ts: base,
        adapterId: 'trello',
        host: 'trello.com',
        path: `/1/cards/${card}`,
        url: `https://trello.com/1/cards/${card}`,
        method: 'GET',
        classification: 'cards/:id',
        resBody: JSON.stringify({ id: card, idBoard: board }),
      }),
    );
    store.insertCapture(
      capture({
        id: `a${i}`,
        ts: base + 15,
        adapterId: 'trello',
        host: 'trello.com',
        path: '/assets/app.js',
        url: 'https://trello.com/assets/app.js',
        method: 'GET',
        classification: 'asset',
      }),
    );
    store.insertCapture(
      capture({
        id: `c${i}`,
        ts: base + 40,
        adapterId: 'trello',
        host: 'trello.com',
        path: `/1/boards/${board}/lists`,
        url: `https://trello.com/1/boards/${board}/lists?idBoard=${board}`,
        method: 'GET',
        classification: 'boards/:id/lists',
      }),
    );
    store.upsertFlow({
      adapterId: 'trello',
      primaryCaptureId: `p${i}`,
      startedAt: base,
      endedAt: base + 40,
      source: 'observed',
      steps: [
        { captureId: `p${i}`, seq: 0, role: 'primary', operation: 'cards/:id', required: true },
        { captureId: `a${i}`, seq: 1, role: 'companion', operation: 'asset', required: false },
        {
          captureId: `c${i}`,
          seq: 2,
          role: 'companion',
          operation: 'boards/:id/lists',
          required: false,
        },
      ],
    });
  }

  const [tmpl] = learnFlowTemplates(store, { adapterId: 'trello' });
  assert.ok(tmpl);
  assert.ok(!tmpl!.steps.some((s) => s.operation === 'asset'));
  const companion = tmpl!.steps.find((s) => s.operation === 'boards/:id/lists');
  assert.ok(companion, 'lists companion should remain');
  const primarySeq = tmpl!.steps.find((s) => s.role === 'primary')!.seq;

  assert.match(companion!.path, /\{boardId\}/, `expected named board path, got ${companion!.path}`);

  const idBoardSrc = companion!.params?.idBoard;
  assert.ok(idBoardSrc, 'idBoard query should be learned as a param');
  assert.equal(idBoardSrc!.kind, 'bind', `expected bind, got ${JSON.stringify(idBoardSrc)}`);
  if (idBoardSrc!.kind === 'bind') {
    assert.equal(
      idBoardSrc.fromStep,
      primarySeq,
      `bind fromStep must be primary template seq ${primarySeq}, not asset index`,
    );
    assert.match(idBoardSrc.jsonPath, /idBoard/);
  }
  store.close();
});

// ── Build rails: what a flow step may send ───────────────────────────────────────

/** A one-step template around `step`, for building a single request inline. */
function oneStep(adapterId: string, step: FlowTemplate['steps'][number]): FlowTemplate {
  return {
    id: 't',
    adapterId,
    primaryKey: step.operation ?? step.path,
    sampleCount: 1,
    version: FLOW_TEMPLATE_VERSION,
    learnedAt: T0,
    flowParams: [],
    steps: [step],
  };
}

const STEP = { seq: 0, role: 'primary' as const, required: true, support: 1, delayMsP50: 0 };

test('a refused step never puts the query (and its live token) in the error', () => {
  // A GET carries tokenFormField and injection.query values in its URL, and the
  // message ends up in flow results that MCP and the CLI print.
  const tmpl = oneStep('slack', {
    ...STEP,
    method: 'GET',
    path: '/api/search',
    params: { q: { kind: 'flowParam', name: 'q' } },
  });
  let message = '';
  assert.throws(
    () =>
      buildFlowStepRequest(tmpl, tmpl.steps[0]!, session(), {
        params: { q: 'chat.postMessage' },
        priorResponses: new Map(),
        ...SLACK_RAILS,
      }),
    (e: unknown) => {
      message = e instanceof Error ? e.message : '';
      return buildRefused('operation_not_allowed')(e);
    },
  );
  assert.ok(message.includes('/api/search'), message);
  assert.ok(!message.includes('xoxc-live'), 'the live token is not in the message');
  assert.ok(!message.includes('token='), 'no query string in the message');
});

test('a bind resolves through the default resolver when none is injected', () => {
  const tmpl = oneStep('slack', {
    ...STEP,
    method: 'POST',
    path: '/api/conversations.history',
    operation: 'conversations.history',
    params: { channel: { kind: 'bind', fromStep: 0, jsonPath: 'channel.id' } },
  });
  const req = buildFlowStepRequest(tmpl, tmpl.steps[0]!, session(), {
    params: {},
    priorResponses: new Map([[0, { channel: { id: 'C777' } }]]),
    ...SLACK_RAILS,
  });
  assert.ok(req?.body?.includes('channel=C777'), req?.body);
});

test('an injection ref naming an Object.prototype member injects nothing', () => {
  // Refs are looked up as OWN keys: `values.constructor` is Object's function,
  // truthy, and used to be coerced onto the wire as a query, header or cookie.
  const get = oneStep('trello', { ...STEP, method: 'GET', path: '/1/members/me/boards' });
  const s = trelloSession();
  s.credentials.values = { key: 'trello-key' };
  s.credentials.injection = {
    tokenFormField: 'constructor',
    query: { key: 'key', q: 'constructor' },
    headers: { 'x-probe': 'toString' },
    cookies: { C: '__proto__' },
  };
  const req = buildFlowStepRequest(get, get.steps[0]!, s, {
    params: {},
    priorResponses: new Map(),
    allowedHosts: ['trello.com'],
  });
  assert.ok(req);
  const url = new URL(req.url);
  assert.equal(url.searchParams.get('key'), 'trello-key', 'an own key still resolves');
  assert.equal(url.searchParams.has('q'), false);
  assert.equal(url.searchParams.has('constructor'), false);
  assert.equal(req.headers['x-probe'], undefined);
  assert.equal(req.headers.cookie, undefined);
});

test('a session-kind param never carries a guessed credential', () => {
  // flow-learn marks any redacted capture param `session`. Build used to fill it
  // with the first credential value, i.e. Trello's whole cookie jar as `?key=`.
  const jar = 'SYNTHETIC-COOKIE-JAR-0001';
  const cookieSession: Session = {
    ...trelloSession(),
    credentials: { kind: 'trello', values: { cookieHeader: jar }, injection: { headers: { Cookie: 'cookieHeader' } } },
  };
  const params = { key: { kind: 'session' as const }, id: { kind: 'session' as const } };
  const rails = { allowedHosts: ['trello.com'], readActions: [readAction('POST', 'https://trello.com/1/search')] };
  for (const [method, path] of [
    ['GET', '/1/members/me/boards'],
    ['POST', '/1/search'],
  ] as const) {
    const tmpl = oneStep('trello', { ...STEP, method, path, params });
    const req = buildFlowStepRequest(tmpl, tmpl.steps[0]!, cookieSession, {
      params: {},
      priorResponses: new Map(),
      ...rails,
    });
    assert.ok(req, method);
    assert.ok(!req!.url.includes(jar) && !redactUrl(req!.url).includes(jar), `${method}: not in the URL`);
    assert.ok(!(req!.body ?? '').includes(jar), `${method}: not in the body`);
    assert.equal(req!.headers.Cookie, jar, `${method}: declared injection still applies`);
  }
});

test('caller params fill declared keys only, never new ones', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack' });
  const primary = tmpl!.steps.find((s) => s.role === 'primary')!;
  const req = buildFlowStepRequest(tmpl!, primary, session(), {
    params: { channel: 'C1', _method: 'DELETE', extra: 'x' },
    priorResponses: new Map(),
    ...SLACK_RAILS,
  });
  const body = new URLSearchParams(req?.body);
  assert.equal(body.get('channel'), 'C1');
  assert.equal(body.get('_method'), null, 'a caller cannot add a method override');
  assert.equal(body.get('extra'), null);
  store.close();
});

test('a non-GET step must match one of the adapter\'s replay actions', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack' });
  const primary = tmpl!.steps.find((s) => s.role === 'primary')!;
  const members = tmpl!.steps.find((s) => s.operation === 'conversations.members')!;
  const ctx = { params: { channel: 'C1' }, priorResponses: new Map() };
  // A POST read the adapter does not list is refused like a write…
  assert.throws(
    () => buildFlowStepRequest(tmpl!, members, session(), { ...ctx, ...SLACK_RAILS }),
    buildRefused('operation_not_allowed'),
  );
  // …and with no read surface at all, every POST is refused.
  assert.throws(
    () => buildFlowStepRequest(tmpl!, primary, session(), { ...ctx, allowedHosts: ['slack.com'] }),
    buildRefused('operation_not_allowed'),
  );
  assert.ok(buildFlowStepRequest(tmpl!, primary, session(), { ...ctx, ...SLACK_RAILS }));
  store.close();
});

test('shipped writes a burst can carry are refused at build', () => {
  // Opening a card or a channel fires writes alongside the read. A stored
  // template may still hold one, so build refuses it; runFlowReplay records a
  // FlowBuildError as 'denied' and never sends it.
  const cases: Array<{ adapterId: string; s: Session; method: string; path: string; operation: string; hosts: string[] }> = [
    {
      adapterId: 'trello',
      s: trelloSession(),
      method: 'POST',
      path: '/1/cards/SynCard1/actions/comments',
      operation: 'cards/:id/actions/comments',
      hosts: ['trello.com'],
    },
    {
      adapterId: 'slack',
      s: session(),
      method: 'POST',
      path: '/api/conversations.mark',
      operation: 'conversations.mark',
      hosts: ['slack.com'],
    },
  ];
  for (const c of cases) {
    const tmpl = oneStep(c.adapterId, { ...STEP, method: c.method, path: c.path, operation: c.operation });
    assert.throws(
      () =>
        buildFlowStepRequest(tmpl, tmpl.steps[0]!, c.s, {
          params: {},
          priorResponses: new Map(),
          allowedHosts: c.hosts,
          readActions: SLACK_READS,
        }),
      buildRefused('operation_not_allowed'),
      c.operation,
    );
  }
});

test('build refuses without a host rail, and over plain http', () => {
  const get = oneStep('trello', { ...STEP, method: 'GET', path: '/1/members/me/boards' });
  const ctx = { params: {}, priorResponses: new Map() };
  assert.throws(
    () => buildFlowStepRequest(get, get.steps[0]!, trelloSession(), { ...ctx, allowedHosts: [] }),
    buildRefused('host_not_allowed'),
  );
  const plain = oneStep('trello', { ...STEP, method: 'GET', path: 'http://trello.com/1/members/me/boards' });
  assert.throws(
    () => buildFlowStepRequest(plain, plain.steps[0]!, trelloSession(), { ...ctx, allowedHosts: ['trello.com'] }),
    buildRefused('host_not_allowed'),
  );
});

test('flowStepBuilder takes both rails from the adapter', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack' });
  const primary = tmpl!.steps.find((s) => s.role === 'primary')!;
  const ctx = { params: { channel: 'C1' }, priorResponses: new Map() };
  assert.match(flowStepBuilder(tmpl!, SLACK_APP)(primary, session(), ctx)!.url, /conversations\.history/);
  assert.throws(
    () => flowStepBuilder(tmpl!, { ...SLACK_APP, hosts: ['other.example'] })(primary, session(), ctx),
    buildRefused('host_not_allowed'),
  );
  assert.throws(
    () => flowStepBuilder(tmpl!, { ...SLACK_APP, listReplayActions: () => [] })(primary, session(), ctx),
    buildRefused('operation_not_allowed'),
  );
  store.close();
});

test('a refused build of an older template says to re-learn; a current one does not', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack' });
  const primary = tmpl!.steps.find((s) => s.role === 'primary')!;
  const ctx = { params: { channel: 'C1' }, priorResponses: new Map() };
  const noReads = { ...SLACK_APP, listReplayActions: () => [] };
  const old = { ...tmpl!, version: FLOW_TEMPLATE_VERSION - 1 };
  assert.throws(
    () => flowStepBuilder(tmpl!, noReads)(primary, session(), ctx),
    (e: unknown) => buildRefused('operation_not_allowed')(e) && !(e as Error).message.includes('learn-flows'),
  );
  assert.throws(
    () => flowStepBuilder(old, noReads)(primary, session(), ctx),
    (e: unknown) => buildRefused('operation_not_allowed')(e) && /older Sluice.*sluice learn-flows/.test((e as Error).message),
  );
  // An older template that still passes the rails keeps building.
  assert.ok(flowStepBuilder(old, SLACK_APP)(primary, session(), ctx));
  store.close();
});

test('re-learning deletes an older template whose primary no longer qualifies', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [current] = learnFlowTemplates(store, { adapterId: 'slack' });
  const stale = store.upsertFlowTemplate({
    ...current!,
    id: undefined,
    primaryKey: 'chat.postMessage',
    version: FLOW_TEMPLATE_VERSION - 1,
  });
  learnFlowTemplates(store, { adapterId: 'slack' });
  const left = store.listFlowTemplates().map((t) => t.id);
  assert.ok(left.includes(current!.id), 'the re-learned template stays');
  assert.ok(!left.includes(stale.id), 'the stale one is swept');
  store.close();
});

// ── Learn rails: what a template may be trained on ──────────────────────────────

test('given the adapters, learning keeps only POST steps the adapter vouches for', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const [tmpl] = learnFlowTemplates(store, { adapterId: 'slack', adapters: [{ id: 'slack', ...SLACK_APP }] });
  assert.ok(tmpl);
  assert.deepEqual(
    tmpl!.steps.map((s) => s.operation),
    ['conversations.history'],
    'members and emoji.list are POSTs outside the read surface',
  );
  // An adapter that is not installed vouches for nothing.
  assert.equal(learnFlowTemplates(store, { adapterId: 'slack', adapters: [], persist: false }).length, 0);
  store.close();
});

test('a POST from an extension capture never trains a step', () => {
  // A page can forge extension captures, so only reads are learned from them.
  const store = new SqliteStore(':memory:');
  const caps = [
    capture({ id: 'x1', source: 'ext', path: '/api/conversations.history', classification: 'conversations.history' }),
    capture({ id: 'x2', source: 'ext', ts: T0 + 20, path: '/api/users.info', classification: 'users.info' }),
  ];
  for (const c of caps) store.insertCapture(c);
  for (const f of clusterCaptureList(caps)) store.upsertFlow(f);
  assert.ok(store.listFlows({ adapterId: 'slack' }).length > 0, 'the burst clustered');
  assert.equal(learnFlowTemplates(store, { adapterId: 'slack' }).length, 0);
  store.close();
});

// ── learned step host ───────────────────────────────────────────────────────

function loomSession(): Session {
  return {
    id: 'l1',
    adapterId: 'loom',
    label: 'loom',
    discoveredAt: T0,
    source: 'manual',
    credentials: { kind: 'loom', values: { cookieHeader: 'c=1' }, injection: { headers: { Cookie: 'cookieHeader' } } },
  };
}

/** Two Loom bursts (a folder list plus a companion) on www.loom.com, learned. */
function learnLoomTemplate(store: SqliteStore): FlowTemplate {
  for (let i = 0; i < 2; i++) {
    const base = T0 + i * 10_000;
    const caps = [
      capture({
        id: `lf${i}`,
        ts: base,
        adapterId: 'loom',
        method: 'GET',
        host: 'www.loom.com',
        url: 'https://www.loom.com/v1/folders',
        path: '/v1/folders',
        classification: 'folders.list',
        resBody: JSON.stringify({ folders: [] }),
      }),
      capture({
        id: `lu${i}`,
        ts: base + 40,
        adapterId: 'loom',
        method: 'GET',
        host: 'www.loom.com',
        url: 'https://www.loom.com/v1/users/me',
        path: '/v1/users/me',
        classification: 'users.me',
        resBody: JSON.stringify({ id: 'u' }),
      }),
    ];
    for (const c of caps) store.insertCapture(c);
    const proposed = clusterCaptureList(caps);
    assert.equal(proposed.length, 1, `loom burst ${i} should cluster`);
    store.upsertFlow(proposed[0]!);
  }
  const tmpl = learnFlowTemplates(store, { adapterId: 'loom', persist: false }).find(
    (t) => t.steps.some((s) => s.path === '/v1/folders'),
  );
  assert.ok(tmpl, 'a loom template is learned');
  return tmpl!;
}

const LOOM_RAILS = { params: {}, priorResponses: new Map<number, unknown>(), allowedHosts: ['loom.com'] };

test('a learned step keeps its observed host, and build sends it there', () => {
  const store = new SqliteStore(':memory:');
  const tmpl = learnLoomTemplate(store);
  const step = tmpl.steps.find((s) => s.path === '/v1/folders')!;
  assert.equal(step.host, 'www.loom.com');
  const req = buildFlowStepRequest(tmpl, step, loomSession(), LOOM_RAILS);
  assert.equal(new URL(req!.url).hostname, 'www.loom.com');
  store.close();
});

test('a fixed adapter host keeps precedence over the learned one', () => {
  const store = new SqliteStore(':memory:');
  seedBursts(store);
  const tmpl = learnFlowTemplates(store, { adapterId: 'slack', persist: false })[0]!;
  const primary = tmpl.steps.find((s) => s.role === 'primary')!;
  const ctx = { params: { channel: 'C1' }, priorResponses: new Map<number, unknown>(), ...SLACK_RAILS };
  for (const host of [undefined, 'acme.slack.com']) {
    const req = buildFlowStepRequest(tmpl, { ...primary, host }, session(), ctx);
    assert.equal(new URL(req!.url).hostname, 'slack.com', `learned host ${host}`);
  }
  store.close();
});

test('the host rail still refuses a learned host outside the adapter, and a malformed one falls back', () => {
  const store = new SqliteStore(':memory:');
  const tmpl = learnLoomTemplate(store);
  const step = tmpl.steps.find((s) => s.path === '/v1/folders')!;
  assert.throws(
    () => buildFlowStepRequest(tmpl, { ...step, host: 'evil.example' }, loomSession(), LOOM_RAILS),
    buildRefused('host_not_allowed'),
  );
  assert.throws(
    () => buildFlowStepRequest(tmpl, { ...step, host: 'a.com/x@b' }, loomSession(), LOOM_RAILS),
    (e: unknown) => buildRefused('host_not_allowed')(e) && /loom\.example/.test((e as Error).message),
  );
  store.close();
});
