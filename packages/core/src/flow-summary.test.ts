// SPDX-License-Identifier: Apache-2.0
/**
 * Flow/template summary projections. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  flowStepSummary,
  flowSummary,
  paramSourceSummary,
  paramSourcesSummary,
  primaryOperation,
  templateStepSummary,
  templateSummary,
} from './flow-summary.js';
import type { FlowTemplate, FlowTemplateStep, InteractionFlow } from './types.js';

const step: FlowTemplateStep = {
  seq: 0,
  role: 'primary',
  method: 'POST',
  path: '/api/conversations.history',
  operation: 'conversations.history',
  required: true,
  support: 1,
  delayMsP50: 0,
  offsetFromPrimaryMsP50: -5,
  offsetSpreadMs: 3,
  request: {
    headers: { 'x-h': 'HEADERVAL' },
    bodyParams: { token: 'BODYVAL' },
    volatileParams: ['ts'],
  },
  params: {
    lit: { kind: 'literal', value: 'LITERALSECRET' },
    sess: { kind: 'session' },
    fp: { kind: 'flowParam', name: 'channel' },
    b: { kind: 'bind', fromStep: 0, jsonPath: 'a.b' },
    u: { kind: 'unreproducible', reason: 'r' },
  },
};

test('a template step summary carries neither the request fingerprint nor a literal value', () => {
  const out = JSON.stringify({ ...templateStepSummary(step), params: paramSourcesSummary(step.params) });
  for (const secret of ['LITERALSECRET', 'HEADERVAL', 'BODYVAL']) {
    assert.ok(!out.includes(secret), `${secret} must not leave through the summary`);
  }
  assert.equal(templateStepSummary(step).offsetFromPrimaryMsP50, -5);
  assert.ok(!('request' in templateStepSummary(step)));
  assert.ok(!('params' in templateStepSummary(step)));
});

test('each param kind maps to exactly its listed keys', () => {
  const keys = (v: object) => Object.keys(v).sort();
  const p = step.params ?? {};
  assert.deepEqual(keys(paramSourceSummary(p.lit!)), ['kind']);
  assert.deepEqual(keys(paramSourceSummary(p.sess!)), ['kind']);
  assert.deepEqual(paramSourceSummary(p.fp!), { kind: 'flowParam', name: 'channel' });
  assert.deepEqual(paramSourceSummary(p.b!), { kind: 'bind', fromStep: 0, jsonPath: 'a.b' });
  assert.deepEqual(paramSourceSummary(p.u!), { kind: 'unreproducible', reason: 'r' });
  assert.equal(paramSourcesSummary(undefined), undefined);
});

test('unreproducible is set only when true', () => {
  assert.equal(templateStepSummary(step).unreproducible, undefined);
  assert.equal(templateStepSummary({ ...step, unreproducible: false }).unreproducible, undefined);
  assert.equal(templateStepSummary({ ...step, unreproducible: true }).unreproducible, true);
});

test('primaryOperation falls back on the operation, not just on the step', () => {
  // The primary-capture step exists but has no operation; the role-primary step has one.
  const flow: InteractionFlow = {
    id: 'f',
    adapterId: 'slack',
    primaryCaptureId: 'p',
    startedAt: 1,
    endedAt: 2,
    source: 'observed',
    steps: [
      { captureId: 'p', seq: 0, role: 'companion', required: true },
      { captureId: 'q', seq: 1, role: 'primary', operation: 'conversations.history', required: true },
    ],
  };
  assert.equal(primaryOperation(flow), 'conversations.history');
  assert.equal(
    primaryOperation({ ...flow, steps: [{ ...flow.steps[0]!, operation: 'users.info' }, flow.steps[1]!] }),
    'users.info',
  );
  assert.equal(primaryOperation({ ...flow, steps: [flow.steps[0]!] }), undefined);

  const s = flowSummary(flow);
  assert.equal(s.primaryOp, 'conversations.history');
  assert.equal(s.stepCount, 2);
  assert.ok(!('steps' in s));
  assert.deepEqual(flowStepSummary(flow.steps[1]!), {
    seq: 1,
    role: 'primary',
    operation: 'conversations.history',
    required: true,
    captureId: 'q',
  });
});

test('a template summary counts steps and does not embed them', () => {
  const t: FlowTemplate = {
    id: 't',
    adapterId: 'slack',
    primaryKey: 'conversations.history',
    sampleCount: 3,
    version: 1,
    learnedAt: 1_000,
    steps: [step, { ...step, seq: 1, role: 'companion' }],
    flowParams: [{ name: 'channel', required: true }],
  };
  const s = templateSummary(t);
  assert.equal(s.stepCount, 2);
  assert.deepEqual(s.flowParams, [{ name: 'channel', required: true }]);
  assert.ok(!JSON.stringify(s).includes('LITERALSECRET'));
  assert.ok(!('steps' in s));
});
