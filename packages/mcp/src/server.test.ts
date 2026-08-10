// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MCP server tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * These drive the registered tools against a seeded in-memory store. The point
 * is the contract an MCP client sees — that a tool exists, advertises the
 * parameters it actually accepts, and returns the store's data — since a client
 * has nothing else to go on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readOnlyStore, SqliteStore } from '@sluice/core';
import { apps } from '@sluice/apps';
import type { ReplayAction } from '@sluice/core';
import { buildServer, workspaceOfParams } from './server.js';

function seeded(): SqliteStore {
  const store = new SqliteStore(':memory:');
  store.applyParseResult(
    {
      workspaces: [{ id: 'W1', adapterId: 'slack', name: 'Acme', domain: 'acme' }],
      containers: [
        { id: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'channel', name: 'general' },
        { id: 'C2', workspaceId: 'W1', adapterId: 'slack', kind: 'channel', name: 'random' },
      ],
      actors: [{ id: 'U1', workspaceId: 'W1', adapterId: 'slack', handle: 'ada' }],
      items: [
        { id: 'M1', containerId: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'message', ts: 2, text: 'second' },
        { id: 'M2', containerId: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'message', ts: 1, text: 'first' },
      ],
    },
    Date.now(),
  );
  return store;
}

/** One registered tool, as the SDK stores it: the advertised schema and the handler. */
interface RegisteredTool {
  inputSchema?: unknown;
  handler?: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

/** The MCP SDK keeps registered tools on the server instance; read them back. */
function registeredTools(server: unknown): Map<string, RegisteredTool> {
  const holder = server as { _registeredTools?: Record<string, RegisteredTool> };
  return new Map(Object.entries(holder._registeredTools ?? {}));
}

/**
 * The parameter names a client is actually shown.
 *
 * NOT `Object.keys(reg.inputSchema)`: `registerTool` converts a raw shape into a
 * ZodObject on the way in, so reading keys off the stored value returns
 * ZodObject's own members and never the tool's parameters — an assertion that
 * passes for the wrong reason, or fails for one.
 */
function advertisedParams(reg: RegisteredTool | undefined): string[] {
  const shape = (reg?.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return Object.keys(shape ?? {}).sort();
}

/**
 * Call a tool the way the server would and parse what it answered.
 *
 * Asserting a tool is REGISTERED says nothing about whether it returns the right
 * rows — the two failures look identical to a client, which only ever sees the
 * result. This drives the handler directly (skipping the transport, not the
 * handler), so the assertions below are about data and not about wiring.
 */
async function callTool(server: unknown, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const reg = registeredTools(server).get(name);
  assert.ok(reg?.handler, `${name} must be registered`);
  const out = await reg.handler(args, {});
  return JSON.parse(out.content[0]?.text ?? 'null') as unknown;
}

test('the core store-backed tools are registered', () => {
  const store = seeded();
  const tools = registeredTools(buildServer(store));
  for (const name of [
    'list_workspaces',
    'list_channels',
    'get_messages',
    'sluice_list_flows',
    'sluice_describe_flow',
    'sluice_replay_flow',
  ]) {
    assert.ok(tools.has(name), `${name} must be registered`);
  }
  store.close();
});

test('flow tools advertise non-empty parameter schemas', () => {
  const store = seeded();
  const tools = registeredTools(buildServer(store));
  assert.ok(advertisedParams(tools.get('sluice_list_flows')).includes('adapterId'));
  assert.ok(advertisedParams(tools.get('sluice_describe_flow')).includes('id'));
  assert.deepEqual(
    advertisedParams(tools.get('sluice_replay_flow')).sort(),
    ['adapterId', 'params', 'primaryKey', 'templateId', 'workspaceId'].sort(),
  );
  store.close();
});

test('sluice_list_flows and sluice_describe_flow read the store without secrets', async () => {
  const store = seeded();
  store.upsertFlow({
    id: 'flow-1',
    adapterId: 'slack',
    label: 'open channel',
    primaryCaptureId: 'cap-p',
    startedAt: 1_000,
    endedAt: 1_100,
    source: 'observed',
    steps: [
      {
        captureId: 'cap-p',
        seq: 0,
        role: 'primary',
        operation: 'conversations.history',
        required: true,
      },
      { captureId: 'cap-c', seq: 1, role: 'companion', operation: 'emoji.list', required: false },
    ],
  });
  store.upsertFlowTemplate({
    id: 'tmpl-1',
    adapterId: 'slack',
    primaryKey: 'conversations.history',
    sampleCount: 2,
    version: 1,
    learnedAt: 2_000,
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
        params: {
          channel: { kind: 'flowParam', name: 'channel' },
          token: { kind: 'session' },
        },
        request: {
          headers: { 'user-agent': 'RealClient/1.0' },
          bodyParams: {},
          volatileParams: [],
        },
      },
    ],
  });

  const server = buildServer(store);
  const listed = (await callTool(server, 'sluice_list_flows', { adapterId: 'slack' })) as {
    flows: Array<{ id: string; primaryOp?: string; stepCount: number }>;
    templates: Array<{ id: string; primaryKey: string; flowParams: unknown }>;
  };
  assert.equal(listed.flows.length, 1);
  assert.equal(listed.flows[0]?.id, 'flow-1');
  assert.equal(listed.flows[0]?.primaryOp, 'conversations.history');
  assert.equal(listed.flows[0]?.stepCount, 2);
  assert.equal(listed.templates.length, 1);
  assert.equal(listed.templates[0]?.primaryKey, 'conversations.history');
  // Agent contract: guidance + qualityNotes so clients need not re-derive heuristics.
  const listedFull = listed as typeof listed & {
    guidance?: { prefer?: string; next?: string };
    templates: Array<{ qualityNotes?: string[]; apiStepCount?: number; sampleCount?: number }>;
  };
  assert.ok(listedFull.guidance?.prefer);
  assert.ok(listedFull.guidance?.next?.includes('describe'));
  assert.equal(listedFull.templates[0]?.sampleCount, 2);
  assert.ok(Array.isArray(listedFull.templates[0]?.qualityNotes));

  const described = (await callTool(server, 'sluice_describe_flow', { id: 'tmpl-1' })) as {
    kind: string;
    primaryKey: string;
    qualityNotes?: string[];
    apiStepCount?: number;
    steps: Array<{ params?: Record<string, { kind: string }> }>;
  };
  assert.equal(described.kind, 'template');
  assert.equal(described.primaryKey, 'conversations.history');
  assert.ok(Array.isArray(described.qualityNotes));
  assert.ok(typeof described.apiStepCount === 'number');
  assert.equal(described.steps[0]?.params?.channel?.kind, 'flowParam');
  assert.equal(described.steps[0]?.params?.token?.kind, 'session');
  // No literal token values in the payload.
  assert.equal(JSON.stringify(described).includes('xox'), false);

  const reg = registeredTools(server).get('sluice_describe_flow');
  assert.ok(reg?.handler);
  const errOut = await reg.handler({ id: 'nope' }, {});
  assert.equal((errOut as { isError?: boolean }).isError, true);

  store.close();
});

test('every app-contributed tool is registered under its own name', () => {
  const store = seeded();
  const tools = registeredTools(buildServer(store));
  const expected = apps.flatMap((a) => (a.mcpTools?.() ?? []).map((t) => t.name));
  assert.ok(expected.length > 0, 'precondition: some app contributes a tool');
  for (const name of expected) assert.ok(tools.has(name), `${name} must be registered`);
  store.close();
});

test('app tool names are prefixed with their app id', () => {
  // They all land in one flat namespace on a single server, so an unprefixed
  // name is a collision waiting to happen.
  for (const app of apps) {
    for (const t of app.mcpTools?.() ?? []) {
      assert.ok(
        t.name.startsWith(`${app.id}_`),
        `${t.name} should start with "${app.id}_" to stay collision-free`,
      );
    }
  }
});

test('a tool that declares parameters advertises them', () => {
  // The regression this guards: app tools were registered with an empty schema,
  // so a client was told they took no arguments and `run(args)` always got {}.
  const store = seeded();
  const tools = registeredTools(buildServer(store));
  for (const app of apps) {
    for (const t of app.mcpTools?.() ?? []) {
      if (!t.inputSchema || Object.keys(t.inputSchema).length === 0) continue;
      const reg = tools.get(t.name);
      assert.ok(reg?.inputSchema, `${t.name} declares parameters, so they must reach the client`);
      assert.deepEqual(advertisedParams(reg), Object.keys(t.inputSchema).sort());
    }
  }
  store.close();
});

test('the store reads the tools wrap return what was seeded', () => {
  const store = seeded();
  assert.equal(store.listWorkspaces().length, 1);
  assert.equal(store.listContainers('W1').length, 2);

  const items = store.listItems('C1', { limit: 200 });
  assert.equal(items.length, 2);
  assert.equal(items[0]?.text, 'second', 'items come back newest-first');
  store.close();
});

// ── The store seam handed to app tools ────────────────────────────────────────

test('an app tool is handed a working read of the store', async () => {
  // The wiring this file exists to pin. `AppToolContext` used to carry nothing
  // but `replay`, so a store-backed app tool could not be written at all and
  // Gmail's were compiled into this package's own spine instead. A registered
  // name proves nothing here: the failure mode is a tool that IS registered and
  // answers "the host gave me no store".
  const store = seeded();
  store.applyParseResult(
    {
      workspaces: [{ id: 'gmail:u0', adapterId: 'gmail', name: 'Gmail (u0)' }],
      containers: [
        { id: '^i', workspaceId: 'gmail:u0', adapterId: 'gmail', kind: 'other', name: 'Inbox' },
      ],
    },
    Date.now(),
  );
  const status = (await callTool(buildServer(store), 'gmail_sync_status')) as {
    accounts: Array<{ id: string }>;
    labels: number;
  };
  assert.deepEqual(
    status.accounts.map((a) => a.id),
    ['gmail:u0'],
    'the tool read the store this server was built on',
  );
  assert.equal(status.labels, 1, 'the Slack channel seeded above is not a Gmail label');
  store.close();
});

test('the read-only view exposes no way to write', () => {
  // The whole point of the seam: an app tool can read what was captured without
  // being able to mutate it or reach a credential. `SqliteStore` satisfies the
  // interface structurally, so this is a check on the VALUE handed over, not on
  // the type — the type would be satisfied by passing the store itself.
  const store = seeded();
  const view = readOnlyStore(store) as unknown as Record<string, unknown>;
  for (const forbidden of [
    'db',
    'insertCapture',
    'applyParseResult',
    'upsertItem',
    'upsertSession',
    'listSessions',
    'pruneCaptures',
    'close',
  ]) {
    assert.equal(view[forbidden], undefined, `${forbidden} must not be reachable from a tool`);
  }
  store.close();
});

test('building the server twice does not throw on duplicate registration', () => {
  // buildServer is called per process today, but a duplicate-name collision
  // between two apps would surface here rather than at a user's first tool call.
  const a = seeded();
  const b = seeded();
  assert.doesNotThrow(() => {
    buildServer(a);
    buildServer(b);
  });
  a.close();
  b.close();
});

// ── Which workspace a replay is for ──────────────────────────────────────────────

test('a replay infers its workspace from the container its arguments name', () => {
  // The trap this closes: with four Slack workspaces signed in, falling through
  // to `sessions[0]` sends a GreenTomato channel's history request out on
  // Atlagene's session. Slack answers HTTP 200 with
  // `{"ok":false,"error":"channel_not_found"}` — which reads as "that channel
  // does not exist" and actually means "you asked the wrong workspace".
  const store = new SqliteStore(':memory:');
  store.applyParseResult(
    {
      workspaces: [{ id: 'W-green', adapterId: 'slack', name: 'GreenTomato' }],
      containers: [
        { id: 'C-general', workspaceId: 'W-green', adapterId: 'slack', kind: 'channel', name: 'general' },
      ],
    },
    Date.now(),
  );

  const action: ReplayAction = {
    id: 'slack.conversations.history',
    adapterId: 'slack',
    label: 'Channel history',
    method: 'POST',
    urlTemplate: 'https://slack.com/api/conversations.history',
    params: [
      { name: 'channel', label: 'Channel', kind: 'containerId', required: true },
      { name: 'limit', label: 'Limit', kind: 'number' },
    ],
  };

  assert.equal(workspaceOfParams(store, action, { channel: 'C-general' }), 'W-green');
  // Read off the action's DECLARED param kinds, not off key names — an adapter
  // that calls its container param `board` must work without a rule per name.
  assert.equal(workspaceOfParams(store, action, { limit: '5' }), undefined);
  assert.equal(workspaceOfParams(store, action, { channel: 'C-unknown' }), undefined);
  assert.equal(workspaceOfParams(store, action, undefined), undefined);
  assert.equal(workspaceOfParams(store, action, { channel: '' }), undefined);
  store.close();
});
