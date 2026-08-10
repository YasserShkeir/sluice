// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sequential flow-replay tests (no real network).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Capture,
  FlowTemplate,
  FlowTemplateStep,
  ReplayRequest,
  Session,
} from '@sluice/core';
import { ReplayDeniedError } from './replay-policy.js';
import { runFlowReplay, resolveJsonPath, nextPaceWaitMs, FLOW_DELAY_CAP_MS } from './flow-replay.js';

const T0 = 1_700_000_000_000;

function session(): Session {
  return {
    id: 's1',
    adapterId: 'slack',
    label: 't',
    discoveredAt: T0,
    source: 'manual',
    credentials: {
      kind: 'slack',
      values: { token: 'live' },
      injection: { tokenFormField: 'token' },
    },
  };
}

function tmpl(over: Partial<FlowTemplate> = {}): FlowTemplate {
  return {
    id: 'ft1',
    adapterId: 'slack',
    primaryKey: 'conversations.history',
    sampleCount: 2,
    version: 1,
    learnedAt: T0,
    flowParams: [{ name: 'channel', required: true }],
    steps: [
      {
        seq: 0,
        role: 'primary',
        method: 'POST',
        path: '/api/conversations.history',
        operation: 'conversations.history',
        required: true,
        support: 1,
        delayMsP50: 0,
      },
      {
        seq: 1,
        role: 'companion',
        method: 'POST',
        path: '/api/conversations.members',
        operation: 'conversations.members',
        required: false,
        support: 1,
        delayMsP50: 40,
      },
    ],
    ...over,
  };
}

function okCapture(req: ReplayRequest, over: Partial<Capture> = {}): Capture {
  return {
    id: `cap-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    source: 'replay',
    adapterId: 'slack',
    method: req.method,
    url: req.url,
    host: 'slack.com',
    path: new URL(req.url).pathname,
    status: 200,
    durationMs: 5,
    reqHeaders: req.headers,
    reqBody: req.body ?? null,
    resHeaders: {},
    resBody: '{"ok":true}',
    ...over,
  };
}

test('runFlowReplay runs steps in order through run()', async () => {
  const order: string[] = [];
  const recorded: string[] = [];
  const result = await runFlowReplay({
    template: tmpl(),
    session: session(),
    params: { channel: 'C1' },
    pace: false,
    io: {
      build: (step) => ({
        method: step.method,
        url: `https://slack.com${step.path}`,
        headers: {},
        body: 'token=live',
      }),
      run: async (req) => {
        order.push(new URL(req.url).pathname);
        return okCapture(req);
      },
      record: (c) => recorded.push(c.id),
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(order, ['/api/conversations.history', '/api/conversations.members']);
  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.every((s) => s.status === 'ok'));
  assert.equal(recorded.length, 2);
  assert.ok(result.flow);
  assert.equal(result.flow?.source, 'replay');
  assert.equal(result.flow?.steps.length, 2);
});

test('soft companion failure does not fail the flow', async () => {
  const result = await runFlowReplay({
    template: tmpl(),
    session: session(),
    pace: false,
    io: {
      build: (step) => ({
        method: step.method,
        url: `https://slack.com${step.path}`,
        headers: {},
      }),
      run: async (req) => {
        const path = new URL(req.url).pathname;
        if (path.includes('members')) {
          return okCapture(req, { status: 500, resBody: 'nope' });
        }
        return okCapture(req);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0]?.status, 'ok');
  assert.equal(result.steps[1]?.status, 'soft_fail');
});

test('required step HTTP error fails the flow', async () => {
  const result = await runFlowReplay({
    template: tmpl(),
    session: session(),
    pace: false,
    io: {
      build: (step) => ({
        method: step.method,
        url: `https://slack.com${step.path}`,
        headers: {},
      }),
      run: async (req) => okCapture(req, { status: 403, resBody: 'no' }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps[0]?.status, 'error');
  assert.match(result.error ?? '', /required step/);
});

test('ReplayDeniedError on required step stops the flow', async () => {
  const result = await runFlowReplay({
    template: tmpl(),
    session: session(),
    pace: false,
    io: {
      build: () => {
        throw new ReplayDeniedError('operation_not_allowed', 'no writes');
      },
      run: async (req) => okCapture(req),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps[0]?.status, 'denied');
});

test('FlowBuildError (cartographer name) on required step is denied', async () => {
  class FlowBuildError extends Error {
    code = 'host_not_allowed' as const;
    constructor(message: string) {
      super(message);
      this.name = 'FlowBuildError';
    }
  }
  const result = await runFlowReplay({
    template: tmpl(),
    session: session(),
    pace: false,
    io: {
      build: () => {
        throw new FlowBuildError('host outside adapter allowlist');
      },
      run: async (req) => okCapture(req),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps[0]?.status, 'denied');
  assert.match(result.error ?? '', /allowlist|host/i);
});

test('unreproducible soft step is skipped; required fails', async () => {
  const soft = tmpl({
    steps: [
      {
        seq: 0,
        role: 'primary',
        method: 'POST',
        path: '/api/conversations.history',
        required: true,
        support: 1,
        delayMsP50: 0,
      },
      {
        seq: 1,
        role: 'companion',
        method: 'POST',
        path: '/api/secret.sign',
        required: false,
        support: 0.5,
        delayMsP50: 0,
        unreproducible: true,
        unreproducibleReason: 'HMAC',
      },
    ],
  });
  const ok = await runFlowReplay({
    template: soft,
    session: session(),
    pace: false,
    io: {
      build: (step) => ({
        method: step.method,
        url: `https://slack.com${step.path}`,
        headers: {},
      }),
      run: async (req) => okCapture(req),
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.steps[1]?.status, 'skipped');

  const hard = tmpl({
    steps: [
      {
        seq: 0,
        role: 'primary',
        method: 'POST',
        path: '/api/conversations.history',
        required: true,
        support: 1,
        delayMsP50: 0,
        unreproducible: true,
        unreproducibleReason: 'HMAC',
      },
    ],
  });
  const bad = await runFlowReplay({
    template: hard,
    session: session(),
    pace: false,
    io: {
      build: () => null,
      run: async (req) => okCapture(req),
    },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /unreproducible/);
});

test('auth failure triggers one full restart when refresh succeeds', async () => {
  let builds = 0;
  let runs = 0;
  let refreshed = 0;
  const result = await runFlowReplay({
    template: tmpl({
      steps: [
        {
          seq: 0,
          role: 'primary',
          method: 'POST',
          path: '/api/conversations.history',
          required: true,
          support: 1,
          delayMsP50: 0,
        },
      ],
    }),
    session: session(),
    pace: false,
    io: {
      build: (step, sess) => {
        builds++;
        return {
          method: step.method,
          url: `https://slack.com${step.path}`,
          headers: { 'x-token': sess.credentials.values.token ?? '' },
        };
      },
      run: async (req) => {
        runs++;
        // First attempt auth-fails; after refresh token is 'fresh'.
        if (req.headers['x-token'] === 'live') {
          return okCapture(req, {
            status: 401,
            resBody: JSON.stringify({ ok: false, error: 'not_authed' }),
          });
        }
        return okCapture(req);
      },
      refresh: async () => {
        refreshed++;
        return {
          ...session(),
          credentials: {
            kind: 'slack',
            values: { token: 'fresh' },
            injection: { tokenFormField: 'token' },
          },
        };
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(refreshed, 1);
  assert.ok(runs >= 2, 'original + retry after restart');
  assert.ok(builds >= 2);
});

test('resolveJsonPath walks objects and arrays', () => {
  const data = { ok: true, channel: { id: 'C1' }, members: [{ id: 'U1' }, { id: 'U2' }] };
  assert.equal(resolveJsonPath(data, 'channel.id'), 'C1');
  assert.equal(resolveJsonPath(data, 'members[1].id'), 'U2');
  assert.equal(resolveJsonPath(data, 'missing'), undefined);
});

test('FLOW_DELAY_CAP_MS is a finite positive cap', () => {
  assert.ok(FLOW_DELAY_CAP_MS > 0 && FLOW_DELAY_CAP_MS <= 5_000);
});

test('nextPaceWaitMs anchors siblings on primary start, not chained gaps', () => {
  const primaryStart = 1_000_000;
  const cap = 2_000;
  const deadline = primaryStart + 60_000;

  // Before primary: chained delayMsP50.
  assert.equal(
    nextPaceWaitMs(
      { seq: 0, role: 'auth', method: 'GET', path: '/a', required: false, support: 1, delayMsP50: 25 },
      { primaryStartedAt: undefined, delayCapMs: cap, flowDeadlineAt: deadline, now: primaryStart },
    ),
    25,
  );

  // After primary: fire at primaryStart + 80 even if delayMsP50 says 40 (skip recovery).
  assert.equal(
    nextPaceWaitMs(
      {
        seq: 2,
        role: 'companion',
        method: 'POST',
        path: '/api/emoji.list',
        required: false,
        support: 1,
        delayMsP50: 40,
        offsetFromPrimaryMsP50: 80,
      },
      { primaryStartedAt: primaryStart, delayCapMs: cap, flowDeadlineAt: deadline, now: primaryStart + 50 },
    ),
    30,
  );

  // Already past the target → no wait.
  assert.equal(
    nextPaceWaitMs(
      {
        seq: 1,
        role: 'companion',
        method: 'POST',
        path: '/api/x',
        required: false,
        support: 1,
        delayMsP50: 100,
        offsetFromPrimaryMsP50: 40,
      },
      { primaryStartedAt: primaryStart, delayCapMs: cap, flowDeadlineAt: deadline, now: primaryStart + 100 },
    ),
    0,
  );

  // Cap still bounds a huge learned offset.
  assert.equal(
    nextPaceWaitMs(
      {
        seq: 1,
        role: 'companion',
        method: 'GET',
        path: '/slow',
        required: false,
        support: 1,
        delayMsP50: 0,
        offsetFromPrimaryMsP50: 10_000,
      },
      { primaryStartedAt: primaryStart, delayCapMs: 200, flowDeadlineAt: deadline, now: primaryStart },
    ),
    200,
  );
});

test('runFlowReplay honors offsetFromPrimaryMsP50 for companion spacing', async () => {
  const issuedAt: number[] = [];
  const steps: FlowTemplateStep[] = [
    {
      seq: 0,
      role: 'primary',
      method: 'POST',
      path: '/api/conversations.history',
      operation: 'conversations.history',
      required: true,
      support: 1,
      delayMsP50: 0,
      offsetFromPrimaryMsP50: 0,
    },
    {
      seq: 1,
      role: 'companion',
      method: 'POST',
      path: '/api/conversations.members',
      operation: 'conversations.members',
      required: false,
      support: 1,
      // Misleading chained gap — if used alone, companion would wait ~5ms only.
      delayMsP50: 5,
      offsetFromPrimaryMsP50: 60,
    },
  ];
  const t0 = Date.now();
  const result = await runFlowReplay({
    template: tmpl({ steps }),
    session: session(),
    params: { channel: 'C1' },
    pace: true,
    delayCapMs: 500,
    io: {
      build: (step) => ({
        method: step.method,
        url: `https://slack.com${step.path}`,
        headers: {},
        body: 'token=live',
      }),
      run: async (req) => {
        issuedAt.push(Date.now());
        return okCapture(req);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(issuedAt.length, 2);
  const gap = (issuedAt[1] ?? 0) - (issuedAt[0] ?? 0);
  // Primary-anchored 60ms (not chained 5ms). Loose bounds for CI load.
  assert.ok(gap >= 40, `expected ~60ms sibling offset, got ${gap}ms`);
  assert.ok(gap < 400, `pacing must stay capped, got ${gap}ms`);
  assert.ok(Date.now() - t0 < 1_000);
});
