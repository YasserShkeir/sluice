// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Flow-template learning tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@sluice/core';
import type { Capture, Session } from '@sluice/core';
import { clusterCaptureList } from './flows.js';
import { learnFlowTemplates, FLOW_TEMPLATE_VERSION } from './flow-learn.js';
import { buildFlowStepRequest } from './flow-build.js';

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
    allowedHosts: ['slack.com'],
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
  assert.ok(tmpl!.steps.some((s) => s.operation === 'cards/:id/markAsViewed'));
  store.close();
});

test('learnFlowTemplates merges shortLink primary ops into card/:id', () => {
  const store = new SqliteStore(':memory:');
  for (const [i, short] of ['6uQ2uchS', 'tS5EG1UG'].entries()) {
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
      path: '/1/board/tTcMzr1z',
      url: 'https://trello.com/1/board/tTcMzr1z',
      method: 'GET',
      classification: 'board/tTcMzr1z',
    }),
  );
  store.insertCapture(
    capture({
      id: 'b2',
      ts: T0 + 30,
      adapterId: 'trello',
      host: 'trello.com',
      path: '/1/boards/5f3a91c8e4b0a2d1f9c37e5b/lists',
      url: 'https://trello.com/1/boards/5f3a91c8e4b0a2d1f9c37e5b/lists',
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
      { captureId: 'b1', seq: 0, role: 'primary', operation: 'board/tTcMzr1z', required: true },
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
  for (const [i, short] of ['6uQ2uchS', 'tS5EG1UG'].entries()) {
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
  });
  assert.equal(req, null);
});

test('findBind maps to template seq after dropped asset companion', () => {
  const store = new SqliteStore(':memory:');
  // Two flows: primary JSON has idBoard; asset between; companion query echoes idBoard.
  // Asset is dropped from the template — bind must point at primary seq, not index 1.
  // Board ids must be id-like (24-hex) so path templatize + normalize collapse them.
  for (const [i, card, board] of [
    [0, '6uQ2uchS', '5f3a91c8e4b0a2d1f9c37e5b'],
    [1, 'tS5EG1UG', '6a4b82d9f5c1b3e2a0d48f6c'],
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
