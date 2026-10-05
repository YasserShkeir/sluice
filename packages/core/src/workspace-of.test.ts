// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from './store.js';
import type { ReplayAction } from './types.js';
import { containerWorkspace, workspaceOfParams, workspaceOfValues } from './workspace-of.js';

test('workspace inference reads containerId params and known container ids', () => {
  const store = new SqliteStore(':memory:');
  store.applyParseResult(
    { containers: [{ id: 'C_B', workspaceId: 'T_B', adapterId: 'slack', kind: 'channel', name: 'b-general' }] },
    1,
  );
  const action: Pick<ReplayAction, 'params'> = {
    params: [{ name: 'channel', label: 'Channel', kind: 'containerId', required: true }],
  };
  assert.equal(workspaceOfParams(store, action, { channel: 'C_B' }), 'T_B');
  assert.equal(workspaceOfParams(store, action, { channel: 'C_unknown' }), undefined);
  assert.equal(workspaceOfParams(store, action, undefined), undefined);
  assert.equal(workspaceOfParams(store, action, { channel: '' }), undefined);
  assert.equal(workspaceOfParams(store, action, { limit: '5' }), undefined, 'only a containerId param counts');
  assert.equal(workspaceOfValues(store, ['x', 'C_B']), 'T_B');
  assert.equal(containerWorkspace(store, 'C_B'), 'T_B');
  assert.equal(containerWorkspace(store, 'C_unknown'), undefined);
  store.close();
});
