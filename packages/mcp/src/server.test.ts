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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { readOnlyStore, SqliteStore } from '@sluice/core';
import { apps } from '@sluice/apps';
import { flowStepBuilder } from '@sluice/cartographer';
import { runFlowReplay } from '@sluice/interceptor';
import type { App, FlowTemplate, FlowTemplateStep, ReplayAction, Session } from '@sluice/core';
import { acquireSession, appToolContext, buildServer, replayActionFor } from './server.js';

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

test('list and describe report the same quality for one template', async () => {
  // They used to count API steps by different rules (list skipped `/assets/`,
  // describe skipped `.js`/`.css`), so this template read 3 in one view and 2 in
  // the other. Under the one rule it is 1 of 4 in both, and both carry the
  // low-API-ratio note.
  const store = seeded();
  const step = (seq: number, role: FlowTemplateStep['role'], path: string, operation: string): FlowTemplateStep => ({
    seq,
    role,
    method: 'GET',
    path,
    operation,
    required: role === 'primary',
    support: 1,
    delayMsP50: 0,
  });
  const literal = 'SYNTHETIC-LITERAL-VALUE';
  store.upsertFlowTemplate({
    id: 'tmpl-q',
    adapterId: 'slack',
    primaryKey: 'conversations.history',
    sampleCount: 1,
    version: 1,
    learnedAt: 1,
    flowParams: [],
    steps: [
      { ...step(0, 'primary', '/api/conversations.history', 'conversations.history'), params: { mode: { kind: 'literal', value: literal } } },
      step(1, 'companion', '/assets/x', 'thing'),
      step(2, 'companion', '/static/app.js', 'bundle'),
      step(3, 'companion', '/static/b.css', 'style'),
    ],
  });

  const server = buildServer(store);
  const listed = (await callTool(server, 'sluice_list_flows', { adapterId: 'slack' })) as {
    templates: Array<{ id: string; apiStepCount: number; qualityNotes: string[] }>;
  };
  const fromList = listed.templates.find((t) => t.id === 'tmpl-q');
  const described = (await callTool(server, 'sluice_describe_flow', { id: 'tmpl-q' })) as {
    apiStepCount: number;
    qualityNotes: string[];
    steps: Array<{ params?: Record<string, { kind: string }> }>;
  };
  assert.equal(fromList?.apiStepCount, 1);
  assert.equal(described.apiStepCount, 1);
  assert.deepEqual(fromList?.qualityNotes, described.qualityNotes);
  assert.ok(described.qualityNotes.some((n) => n.includes('non-API')));
  // A literal's captured text never leaves; its kind does.
  assert.equal(described.steps[0]?.params?.mode?.kind, 'literal');
  assert.equal(JSON.stringify(described).includes(literal), false);
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

// ── Sessions and flow results ────────────────────────────────────────────────────

/** A secret-free stand-in for a signed-in session. */
function syntheticSession(adapterId: string, workspaceId?: string, values: Record<string, string> = {}): Session {
  return {
    id: `s-${workspaceId ?? 'none'}`,
    adapterId,
    workspaceId,
    label: workspaceId ?? 'none',
    credentials: { kind: 'synthetic', values, injection: values.token ? { tokenFormField: 'token' } : {} },
    discoveredAt: 0,
    source: 'manual',
  };
}

test('acquireSession picks exactly one session and redacts an extractor failure', async () => {
  // Stub apps only: a real credential provider would read the Keychain.
  const bare = await acquireSession({ id: 'stub', displayName: 'Stub', hosts: [] } as unknown as App, {});
  assert.ok(bare.ok);
  assert.equal(bare.session.adapterId, 'stub');
  assert.deepEqual(bare.session.credentials.values, {});

  const twoSignedIn = {
    id: 'stub',
    displayName: 'Stub',
    hosts: [],
    credentials: { extractSessions: async () => [syntheticSession('stub', 'W-a'), syntheticSession('stub', 'W-b')] },
  } as unknown as App;
  const ambiguous = await acquireSession(twoSignedIn, {});
  assert.ok(!ambiguous.ok);
  assert.match(ambiguous.error, /Pass workspaceId/);
  const pinned = await acquireSession(twoSignedIn, { workspaceId: 'W-b' });
  assert.ok(pinned.ok);
  assert.equal(pinned.session.workspaceId, 'W-b');
  const inferred = await acquireSession(twoSignedIn, { inferred: 'W-a' });
  assert.ok(inferred.ok);
  assert.equal(inferred.session.workspaceId, 'W-a');
  // A workspace nobody owns is a hint, not a choice: with two sessions it decides nothing.
  assert.ok(!(await acquireSession(twoSignedIn, { inferred: 'slack:app.slack.com' })).ok);

  // One signed-in session whose extractor names no workspace (Trello, Notion):
  // a container filed under a synthetic workspace must not strand the replay,
  // but an agent's explicit workspaceId is still never substituted.
  const one = {
    id: 'stub',
    displayName: 'Stub',
    hosts: [],
    credentials: { extractSessions: async () => [syntheticSession('stub')] },
  } as unknown as App;
  assert.ok((await acquireSession(one, { inferred: 'stub' })).ok);
  const explicit = await acquireSession(one, { workspaceId: 'W-other' });
  assert.ok(!explicit.ok);
  assert.match(explicit.error, /No signed-in workspace matched "W-other"/);

  const secret = 'abcd1234efgh';
  const failing = await acquireSession(
    {
      id: 'stub',
      displayName: 'Stub',
      hosts: [],
      credentials: {
        extractSessions: async () => {
          throw new Error(`token=${secret}`);
        },
      },
    } as unknown as App,
    {},
  );
  assert.ok(!failing.ok);
  assert.ok(failing.error.startsWith('Could not acquire a session:'));
  assert.equal(failing.error.includes(secret), false);
});

test('a refused flow step never carries the session token into the result', async () => {
  // The trigger: a GET step with no operation, where the caller's params trip
  // the write-shaped check. By then the builder has put the token into the query
  // string, and the refusal used to quote that whole query back to the agent.
  const slack = apps.find((a) => a.id === 'slack');
  assert.ok(slack, 'precondition: the Slack app is installed');
  // Token-shaped but synthetic, assembled at runtime so no scanner-shaped literal
  // sits in source.
  const token = ['xoxc', '000000000000', '000000000000', '000000000000', 'f'.repeat(64)].join('-');
  const session = syntheticSession('slack', 'W-synthetic', { token });
  const tmpl: FlowTemplate = {
    id: 'tmpl-deny',
    adapterId: 'slack',
    primaryKey: 'search.messages',
    sampleCount: 2,
    version: 1,
    learnedAt: 1,
    flowParams: [{ name: 'q', required: true }],
    steps: [
      {
        seq: 0,
        role: 'primary',
        method: 'GET',
        path: '/api/search.messages',
        required: true,
        support: 1,
        delayMsP50: 0,
        params: { q: { kind: 'flowParam', name: 'q' } },
      },
    ],
  };
  const build = flowStepBuilder(tmpl, slack);
  const step = tmpl.steps[0];
  assert.ok(step);
  assert.throws(
    () => build(step, session, { params: { q: 'mutation' }, priorResponses: new Map() }),
    (e: Error) => /write-shaped/.test(e.message) && !e.message.includes(token),
  );

  let sent = 0;
  const result = await runFlowReplay({
    template: tmpl,
    params: { q: 'mutation' },
    session,
    pace: false,
    io: {
      build,
      run: async () => {
        sent++;
        throw new Error('tests never reach the network');
      },
    },
  });
  assert.equal(sent, 0, 'a refused step is never sent');
  assert.equal(result.steps[0]?.status, 'denied');
  assert.equal(JSON.stringify(result).includes(token), false, 'the refusal names the path only');
});

test('replay and sluice_replay_flow bound their params like the dashboard frames', () => {
  const store = seeded();
  const tools = registeredTools(buildServer(store));
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'v']));
  for (const name of ['replay', 'sluice_replay_flow']) {
    const schema = tools.get(name)?.inputSchema as
      | { safeParse(v: unknown): { success: boolean } }
      | undefined;
    assert.ok(schema, `${name} must be registered`);
    const base = name === 'replay' ? { actionId: 'a' } : { templateId: 't' };
    assert.equal(schema.safeParse({ ...base, params: { channel: 'C1' } }).success, true, `${name} accepts a normal map`);
    assert.equal(schema.safeParse({ ...base, params: many }).success, false, `${name} refuses 65 params`);
    assert.equal(schema.safeParse({ ...base, params: { q: 'x'.repeat(8193) } }).success, false, `${name} long value`);
    assert.equal(schema.safeParse({ ...base, params: { ['k'.repeat(1025)]: 'v' } }).success, false, `${name} long key`);
  }
  store.close();
});

test('replayActionFor sends the app session\'s credentials and stores none of them', async () => {
  const cookie = ['FAKE', 'COOKIE', 'value', '0123456789'].join('-');
  const received: Array<string | undefined> = [];
  const http = createServer((req, res) => {
    received.push(req.headers.cookie);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  const action: ReplayAction = {
    id: 'stub.me',
    adapterId: 'stub',
    label: 'me',
    method: 'GET',
    urlTemplate: `http://127.0.0.1:${port}/me`,
    params: [],
  };
  const app = {
    id: 'stub',
    displayName: 'Stub',
    hosts: ['127.0.0.1'],
    credentials: { extractSessions: async () => [syntheticSession('stub', 'W-a', { cookieHeader: cookie })] },
    listReplayActions: () => [action],
    buildReplayRequest: (a: ReplayAction, _p: Record<string, string>, s: Session) => ({
      method: 'GET',
      url: a.urlTemplate,
      headers: { Cookie: s.credentials.values.cookieHeader ?? '' },
    }),
    parse: () => ({}),
  } as unknown as App;
  const store = new SqliteStore(':memory:');
  try {
    const out = await replayActionFor(store, app, action, {}, undefined);
    assert.ok(out.ok);
    assert.equal(out.capture.status, 200);
    assert.deepEqual(received, [cookie], 'the session cookie went out on the wire');
    const stored = store.getCapture(out.capture.id);
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes(cookie), false, 'no stored field carries it');
    assert.equal(JSON.stringify(out.capture).includes(cookie), false, 'nor does the returned capture');
  } finally {
    store.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

// ── Host and ownership rails on the app-tool seam ────────────────────────────────

/** A loopback server that counts requests: a regressed rail must never reach real DNS. */
async function countingServer(): Promise<{ origin: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const http = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

/** A stub app whose declared hosts never include loopback. */
function offHostApp(over: Record<string, unknown> = {}): App {
  return {
    id: 'stub',
    displayName: 'Stub',
    hosts: ['other.example'],
    listReplayActions: () => [],
    buildReplayRequest: (a: ReplayAction) => ({ method: 'GET', url: a.urlTemplate, headers: {} }),
    parse: () => ({}),
    ...over,
  } as unknown as App;
}

const hostNotAllowed = (e: unknown): boolean =>
  (e as Error).name === 'ReplayDeniedError' && (e as { code?: string }).code === 'host_not_allowed';

test("an app tool's ctx.replay is sent under the app's host rail", async () => {
  const srv = await countingServer();
  const store = new SqliteStore(':memory:');
  try {
    const replay = appToolContext(store, offHostApp()).replay;
    await assert.rejects(replay({ method: 'GET', url: `${srv.origin}/x`, headers: {} }), hostNotAllowed);
    assert.equal(srv.hits(), 0);
  } finally {
    store.close();
    await srv.close();
  }
});

test("ctx.replayFlow refuses another app's template before acquiring a session", async () => {
  const store = new SqliteStore(':memory:');
  store.upsertFlowTemplate({
    id: 'tmpl-slack',
    adapterId: 'slack',
    primaryKey: 'conversations.history',
    sampleCount: 2,
    version: 2,
    learnedAt: 1,
    flowParams: [],
    steps: [{ seq: 0, role: 'primary', method: 'GET', path: '/api/x', required: true, support: 1, delayMsP50: 0 }],
  });
  let extractions = 0;
  const app = offHostApp({
    credentials: {
      extractSessions: async () => {
        extractions++;
        return [];
      },
    },
  });
  try {
    const replayFlow = appToolContext(store, app).replayFlow;
    assert.ok(replayFlow);
    await assert.rejects(replayFlow('tmpl-slack', {}), /Unknown flow template/);
    assert.equal(extractions, 0, 'refused before any session was extracted');
  } finally {
    store.close();
  }
});

test("replayActionFor refuses a URL outside the app's hosts before it is sent", async () => {
  const srv = await countingServer();
  const action: ReplayAction = {
    id: 'stub.me',
    adapterId: 'stub',
    label: 'me',
    method: 'GET',
    urlTemplate: `${srv.origin}/me`,
    params: [],
  };
  const store = new SqliteStore(':memory:');
  try {
    const app = offHostApp({ listReplayActions: () => [action] });
    await assert.rejects(replayActionFor(store, app, action, {}, undefined), hostNotAllowed);
    assert.equal(srv.hits(), 0);
  } finally {
    store.close();
    await srv.close();
  }
});
