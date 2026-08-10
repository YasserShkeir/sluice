// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Capture } from '@sluice/core';
import {
  buildFlowGroupedRows,
  indexFlowsByCapture,
  matchTemplateForFlow,
  primaryMembership,
} from './flow-ui.js';
import type { FlowSummary, FlowTemplateSummary } from './api.js';

function cap(partial: Partial<Capture> & { id: string }): Capture {
  return {
    ts: 1,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/x',
    host: 'slack.com',
    path: '/api/x',
    status: 200,
    durationMs: 10,
    reqHeaders: {},
    resHeaders: {},
    reqBody: null,
    resBody: null,
    ...partial,
  };
}

const flow: FlowSummary = {
  id: 'flow-1',
  adapterId: 'slack',
  source: 'observed',
  primaryCaptureId: 'c-primary',
  primaryOp: 'conversations.history',
  stepCount: 2,
  startedAt: 100,
  endedAt: 200,
  steps: [
    { seq: 0, role: 'primary', operation: 'conversations.history', required: true, captureId: 'c-primary' },
    { seq: 1, role: 'companion', operation: 'users.info', required: false, captureId: 'c-comp' },
  ],
};

describe('flow-ui', () => {
  it('indexes captures to flow memberships', () => {
    const map = indexFlowsByCapture([flow]);
    assert.equal(map.get('c-primary')?.[0]?.isPrimary, true);
    assert.equal(map.get('c-comp')?.[0]?.step.role, 'companion');
  });

  it('prefers pinned membership for badges', () => {
    const pinned: FlowSummary = { ...flow, id: 'flow-p', source: 'pinned' };
    const m = primaryMembership([
      {
        flow,
        step: {
          flowId: flow.id,
          seq: flow.steps![0]!.seq,
          role: flow.steps![0]!.role,
          operation: flow.steps![0]!.operation,
          required: flow.steps![0]!.required,
          captureId: flow.steps![0]!.captureId,
        },
        isPrimary: true,
      },
      {
        flow: pinned,
        step: { flowId: 'flow-p', seq: 0, role: 'primary', required: true, captureId: 'c-primary' },
        isPrimary: true,
      },
    ]);
    assert.equal(m?.flow.id, 'flow-p');
  });

  it('groups filtered captures under flows and leaves the rest ungrouped', () => {
    const captures = [
      cap({ id: 'c-primary', classification: 'conversations.history' }),
      cap({ id: 'c-comp', classification: 'users.info' }),
      cap({ id: 'c-other', classification: 'api.test' }),
    ];
    const collapsed = buildFlowGroupedRows(captures, [flow], new Set());
    assert.equal(collapsed.filter((r) => r.kind === 'flow').length, 1);
    // collapsed still peeks primary
    assert.ok(collapsed.some((r) => r.kind === 'capture' && r.capture.id === 'c-primary'));
    assert.ok(collapsed.some((r) => r.kind === 'ungrouped-header'));
    assert.ok(collapsed.some((r) => r.kind === 'capture' && r.capture.id === 'c-other' && !r.nested));

    const expanded = buildFlowGroupedRows(captures, [flow], new Set(['flow-1']));
    const nestedIds = expanded
      .filter((r): r is Extract<typeof r, { kind: 'capture' }> => r.kind === 'capture' && r.nested)
      .map((r) => r.capture.id);
    assert.deepEqual(nestedIds, ['c-primary', 'c-comp']);
  });

  it('matches a template by adapter + primaryKey', () => {
    const tmpls: FlowTemplateSummary[] = [
      {
        id: 't1',
        adapterId: 'slack',
        primaryKey: 'conversations.history',
        sampleCount: 3,
        stepCount: 2,
        flowParams: [],
        learnedAt: 1,
        version: 1,
      },
    ];
    assert.equal(matchTemplateForFlow(flow, tmpls)?.id, 't1');
  });
});
