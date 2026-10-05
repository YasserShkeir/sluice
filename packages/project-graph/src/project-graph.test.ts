// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildProjectGraph, scanRepository } from './indexer.js';
import { impactAnalysis, searchProjectGraph } from './retrieval.js';
import {
  buildProjectGraphServer,
  PROJECT_GRAPH_INSTRUCTIONS,
  type ProjectGraphRuntime,
} from './server.js';
import { ProjectGraphStore } from './store.js';
import { GRAPH_NODE_KINDS, type GraphSnapshot, type GraphStatus } from './types.js';

function temporaryRepository(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'sluice-project-graph-'));
  const write = (path: string, body: string | Buffer): void => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  };
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  write(
    'package.json',
    JSON.stringify({
      name: '@fixture/root',
      bin: { fixture: './dist/cli.js' },
      scripts: { check: 'node check.js' },
      dependencies: { zod: '^3.0.0' },
    }),
  );
  write(
    '.gitignore',
    'node_modules/\n.env\n*.sqlite\ncaptures/\nca/\n*.log\nprivate-notes/\ndocs/*\n!docs/public/\n',
  );
  write('src/dep.ts', 'export function target(): string { return "ok"; }\n');
  write(
    'src/main.ts',
    [
      "import { target } from './dep.js';",
      "import { z } from 'zod';",
      'export function run(): string { return target(); }',
      'const schema = `CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY)`;',
      "const endpoint = '/api/widgets';",
      "server.registerTool('fixture_tool', {}, handler);",
      'void schema; void endpoint;',
    ].join('\n'),
  );
  write(
    'src/cli.ts',
    "switch (command) { case 'refresh': run(); break; default: break; }\nconst COMMANDS = new Map([['build-db', cmdBuildDb]]);\n",
  );
  write('public/logo.png', Buffer.from([0, 1, 2, 3]));
  write('docs/public/guide.md', '# Guide\n\nA public reader guide.\n');
  write('packages/demo/fixtures/sample.ndjson', '{"kind":"synthetic-fixture"}\n');
  write('id_ecdsa.pub', 'ssh-ed25519 AAAAsynthetic fixture@example.test\n');

  // These are force-tracked to prove the indexer has a safety boundary beyond
  // .gitignore. None may appear even as metadata nodes.
  write('.env', 'TOKEN=do-not-index\n');
  write('local.sqlite', 'not really sqlite, still excluded');
  write('trace.sqlite-wal', 'also excluded');
  write('nested/node_modules/evil.ts', 'export const stolen = "secret";');
  write('captures/private.ndjson', '{"token":"secret"}\n');
  write('ca/local.crt', 'secret certificate');
  write('docs/private.md', 'private working note');
  write('private-notes/plan.md', 'ignored only by .gitignore');
  write('app.log', 'log line');
  write('.claude/settings.local.json', '{"permissions":{}}');
  // Not ignored at all: only the hard exclusions keep these out.
  write('.envrc', 'export TOKEN=synthetic\n');
  write('.netrc', 'machine example.test login fixture password synthetic\n');
  write('.git-credentials', 'https://fixture:synthetic@example.test\n');
  write('.yarnrc.yml', 'npmAuthToken: synthetic\n');
  write('id_ecdsa', 'synthetic private key\n');
  write('.docker/config.json', '{"auths":{}}');
  write('CLAUDE.local.md', 'per-user instructions');
  write('keys/signing.p8', 'synthetic');
  write('backup/graph.db.bak', 'synthetic');
  write('profile/Cookies', 'synthetic');
  write('exports/slack.json', '{"messages":[]}');
  write('slack.ndjson', '{"text":"synthetic"}\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      'add',
      '-f',
      '.env',
      'local.sqlite',
      'trace.sqlite-wal',
      'nested/node_modules/evil.ts',
      'captures/private.ndjson',
      'ca/local.crt',
      'docs/private.md',
      'private-notes/plan.md',
      'app.log',
      '.claude/settings.local.json',
    ],
    { cwd: root },
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function tinySnapshot(fingerprint: string, description = 'alpha implementation'): GraphSnapshot {
  return {
    fingerprint,
    nodes: [
      {
        id: 'repository:test',
        kind: 'repository',
        name: 'Test',
        description: 'test repository',
        source: 'indexer',
      },
      {
        id: 'file:src/a.ts',
        kind: 'file',
        name: 'a.ts',
        description,
        path: 'src/a.ts',
        source: 'indexer',
      },
    ],
    edges: [
      {
        from: 'repository:test',
        to: 'file:src/a.ts',
        kind: 'contains',
        source: 'indexer',
      },
    ],
    chunks: [
      {
        id: 'chunk:file:src/a.ts',
        nodeId: 'file:src/a.ts',
        path: 'src/a.ts',
        title: 'a.ts',
        text: description,
        startLine: 1,
        endLine: 1,
        source: 'indexer',
      },
    ],
    files: [{ path: 'src/a.ts', hash: fingerprint, size: description.length, binary: false }],
    diagnostics: { unresolvedImports: [], skippedContent: [] },
  };
}

interface RegisteredTool {
  handler?: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
}

function registeredMap(server: unknown, property: string): Map<string, unknown> {
  const holder = server as Record<string, Record<string, unknown> | undefined>;
  return new Map(Object.entries(holder[property] ?? {}));
}

test('indexes packages, code relationships, routes, tables, commands, tools, and binary assets', () => {
  const fixture = temporaryRepository();
  try {
    const first = buildProjectGraph(fixture.root, { curatedPath: null });
    const ids = new Set(first.nodes.map((node) => node.id));
    assert.ok(ids.has('package:@fixture/root'));
    assert.ok(ids.has('entrypoint:@fixture/root:fixture'));
    assert.ok(ids.has('file:src/main.ts'));
    assert.ok(ids.has('file:public/logo.png'));
    assert.ok(ids.has('symbol:src/main.ts#run:function'));
    assert.ok(ids.has('database-table:widgets'));
    assert.ok(ids.has('http-endpoint:/api/widgets'));
    assert.ok(ids.has('mcp-tool:fixture_tool'));
    assert.ok(ids.has('cli-command:refresh'));
    assert.ok(ids.has('cli-command:build-db'), 'table-dispatched command');

    const main = first.nodes.find((node) => node.id === 'file:src/main.ts');
    const logo = first.nodes.find((node) => node.id === 'file:public/logo.png');
    assert.equal(main?.metadata?.contentIndexed, true);
    assert.equal(logo?.metadata?.binary, true);
    assert.equal(logo?.metadata?.contentIndexed, false);
    assert.ok(
      first.edges.some(
        (edge) =>
          edge.from === 'file:src/main.ts' &&
          edge.to === 'file:src/dep.ts' &&
          edge.kind === 'imports',
      ),
    );
    assert.ok(
      first.edges.some(
        (edge) =>
          edge.from === 'symbol:src/main.ts#run:function' &&
          edge.to === 'symbol:src/dep.ts#target:function' &&
          edge.kind === 'calls',
      ),
    );

    for (const forbidden of [
      '.env',
      'local.sqlite',
      'trace.sqlite-wal',
      'nested/node_modules/evil.ts',
      'captures/private.ndjson',
      'ca/local.crt',
      'docs/private.md',
      'private-notes/plan.md',
      'app.log',
      '.claude/settings.local.json',
      '.envrc',
      '.netrc',
      '.git-credentials',
      '.yarnrc.yml',
      'id_ecdsa',
      '.docker/config.json',
      'CLAUDE.local.md',
      'keys/signing.p8',
      'backup/graph.db.bak',
      'profile/Cookies',
      'exports/slack.json',
      'slack.ndjson',
    ]) {
      assert.equal(ids.has(`file:${forbidden}`), false, `${forbidden} must be hard-excluded`);
      assert.equal(
        first.files.some((file) => file.path === forbidden),
        false,
        `${forbidden} must not be fingerprinted`,
      );
      assert.equal(
        first.chunks.some((chunk) => chunk.path === forbidden),
        false,
        `${forbidden} must not reach FTS`,
      );
    }
    for (const allowed of ['docs/public/guide.md', 'packages/demo/fixtures/sample.ndjson', 'id_ecdsa.pub']) {
      assert.ok(ids.has(`file:${allowed}`), `${allowed} must stay indexed`);
    }

    const originalSymbol = first.nodes.find((node) => node.id === 'symbol:src/main.ts#run:function');
    const mainPath = join(fixture.root, 'src/main.ts');
    const originalSource = first.chunks.find((chunk) => chunk.nodeId === 'file:src/main.ts')?.text;
    assert.ok(originalSource);
    writeFileSync(mainPath, `\n\n${originalSource}`);
    const shifted = buildProjectGraph(fixture.root, { curatedPath: null });
    const shiftedSymbol = shifted.nodes.find((node) => node.id === originalSymbol?.id);
    assert.equal(shiftedSymbol?.id, originalSymbol?.id, 'line movement must not change symbol ids');
    assert.equal(shiftedSymbol?.startLine, (originalSymbol?.startLine ?? 0) + 2);
  } finally {
    fixture.cleanup();
  }
});

test('store refresh is atomic, FTS is safe, and manual notes survive generated refreshes', () => {
  const fixture = temporaryRepository();
  const sourcePath = join(fixture.root, 'src/a.ts');
  writeFileSync(sourcePath, 'export const alpha = true;\n');
  const store = new ProjectGraphStore(':memory:');
  try {
    store.replaceGenerated(tinySnapshot('one'), {
      repositoryRoot: fixture.root,
      indexedHead: null,
    });
    assert.equal(store.searchChunks('alpha')[0]?.node.id, 'file:src/a.ts');
    assert.doesNotThrow(() => store.searchChunks('" OR 1=1 --'));

    const note = store.upsertNote({
      id: 'decision',
      title: 'Keep the boundary',
      body: 'The source graph remains separate from captured runtime data.',
      relatedNodeIds: ['file:src/a.ts'],
      evidencePaths: ['src/a.ts'],
      tags: ['architecture'],
    });
    assert.equal(store.edgesFor(note.id, { direction: 'out' }).length, 1);

    store.replaceGenerated(tinySnapshot('two', 'beta implementation'), {
      repositoryRoot: fixture.root,
      indexedHead: null,
    });
    assert.equal(store.getNode(note.id)?.source, 'manual');
    assert.equal(store.searchChunks('boundary')[0]?.node.id, note.id);

    const updated = store.upsertNote({
      id: 'decision',
      title: 'Keep the boundary',
      body: 'Updated decision with evidence.',
      evidencePaths: ['src/a.ts'],
      expectedUpdatedAt: note.updatedAt,
    });
    assert.ok((updated.updatedAt ?? 0) > (note.updatedAt ?? 0));
    assert.throws(
      () =>
        store.upsertNote({
          id: 'decision',
          title: 'Conflicting update',
          body: 'Must not win.',
          expectedUpdatedAt: note.updatedAt,
        }),
      /conflict/,
    );
    assert.throws(() => store.deleteNote('decision', note.updatedAt), /conflict/);
    assert.equal(store.deleteNote('decision', updated.updatedAt), true);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('retrieval combines lexical matches with bounded graph context and reports freshness', () => {
  const fixture = temporaryRepository();
  const store = new ProjectGraphStore(':memory:');
  try {
    const snapshot = buildProjectGraph(fixture.root, { curatedPath: null });
    store.replaceGenerated(snapshot, { repositoryRoot: fixture.root, indexedHead: null });
    const result = searchProjectGraph(store, fixture.root, 'fixture_tool', {
      limit: 5,
      hops: 1,
    });
    assert.equal(result.stale, false);
    assert.ok(result.hits.length > 0);
    assert.ok(result.hits.some((hit) => hit.node.id === 'mcp-tool:fixture_tool'));
    assert.ok(result.context.length <= 60);
    assert.ok(result.relationships.length <= 100);

    writeFileSync(join(fixture.root, 'src/dep.ts'), 'export const changed = true;\n');
    assert.notEqual(scanRepository(fixture.root).fingerprint, snapshot.fingerprint);
    assert.equal(searchProjectGraph(store, fixture.root, 'widgets').stale, true);
    assert.equal(
      store.validate({
        repositoryRoot: fixture.root,
        currentFingerprint: scanRepository(fixture.root).fingerprint,
      }).ok,
      false,
    );
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('MCP advertises the complete graph workflow, resources, prompt, and safe tool annotations', async () => {
  const fixture = temporaryRepository();
  const store = new ProjectGraphStore(':memory:');
  try {
    const snapshot = buildProjectGraph(fixture.root, { curatedPath: null });
    store.replaceGenerated(snapshot, { repositoryRoot: fixture.root, indexedHead: null });
    const status = (): GraphStatus =>
      store.status({
        repositoryRoot: fixture.root,
        currentFingerprint: scanRepository(fixture.root).fingerprint,
      });
    const runtime: ProjectGraphRuntime = {
      root: fixture.root,
      store,
      refresh: status,
      status,
    };
    const server = buildProjectGraphServer(runtime);
    const tools = registeredMap(server, '_registeredTools');
    for (const name of [
      'project_graph_status',
      'project_graph_query',
      'project_graph_get',
      'project_graph_neighbors',
      'project_graph_trace',
      'project_graph_impact',
      'project_graph_refresh',
      'project_graph_note_upsert',
      'project_graph_note_delete',
      'project_graph_validate',
    ]) {
      assert.ok(tools.has(name), `${name} must be registered`);
    }
    assert.ok(registeredMap(server, '_registeredResources').size >= 3);
    assert.ok(registeredMap(server, '_registeredPrompts').has('project_graph_orient'));
    assert.match(PROJECT_GRAPH_INSTRUCTIONS, /At task start call project_graph_status/);
    assert.match(PROJECT_GRAPH_INSTRUCTIONS, /graph is an index, not authority/);

    const registeredStatus = tools.get('project_graph_status') as RegisteredTool | undefined;
    assert.ok(registeredStatus?.handler);
    const output = await registeredStatus.handler({}, {});
    const value = JSON.parse(output.content[0]?.text ?? 'null') as GraphStatus;
    assert.equal(value.stale, false);

    const raw = tools.get('project_graph_status') as
      | { annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }
      | undefined;
    assert.equal(raw?.annotations?.readOnlyHint, true);
    assert.equal(raw?.annotations?.openWorldHint, false);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('impact analysis follows the edges that define tables, tools, commands, and symbols', () => {
  const fixture = temporaryRepository();
  const store = new ProjectGraphStore(':memory:');
  try {
    const snapshot = buildProjectGraph(fixture.root, { curatedPath: null });
    store.replaceGenerated(snapshot, { repositoryRoot: fixture.root, indexedHead: null });
    const impacted = (idOrPath: string): string[] =>
      impactAnalysis(store, idOrPath).impactedNodes.map((node) => node.id);

    assert.ok(impacted('database-table:widgets').includes('file:src/main.ts'), 'defines_table');
    assert.ok(impacted('mcp-tool:fixture_tool').includes('file:src/main.ts'), 'registers_tool');
    assert.ok(impacted('cli-command:refresh').includes('file:src/cli.ts'), 'implements_command');
    assert.ok(impacted('dependency:zod').includes('file:src/main.ts'), 'imports_external');
    const target = store.getNode('symbol:src/dep.ts#target:function');
    assert.ok(target);
    const symbolImpact = impacted(target.id);
    assert.ok(symbolImpact.includes('file:src/dep.ts'), 'exports');
    assert.ok(symbolImpact.includes('file:src/main.ts'));
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test('the indexer never reads through a symlinked parent directory', () => {
  const fixture = temporaryRepository();
  const outside = mkdtempSync(join(tmpdir(), 'sluice-project-graph-outside-'));
  try {
    mkdirSync(join(fixture.root, 'sub'));
    writeFileSync(join(fixture.root, 'sub/a.txt'), 'tracked text\n');
    execFileSync('git', ['add', 'sub/a.txt'], { cwd: fixture.root });
    // Git keeps listing sub/a.txt from the index after sub becomes a symlink.
    rmSync(join(fixture.root, 'sub'), { recursive: true });
    writeFileSync(join(outside, 'a.txt'), 'outside-only marker\n');
    symlinkSync(outside, join(fixture.root, 'sub'));

    const snapshot = buildProjectGraph(fixture.root, { curatedPath: null });
    assert.equal(snapshot.files.some((file) => file.path === 'sub/a.txt'), false);
    assert.equal(snapshot.chunks.some((chunk) => chunk.text.includes('outside-only marker')), false);
    const link = snapshot.nodes.find((node) => node.id === 'file:sub');
    assert.equal(link?.metadata?.symlink, true);
    assert.equal(link?.metadata?.contentIndexed, false);
    assert.equal(snapshot.chunks.some((chunk) => chunk.nodeId === 'file:sub'), false);
  } finally {
    fixture.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('files over the text limit are fingerprinted without being read whole', () => {
  const fixture = temporaryRepository();
  try {
    // A sparse file past the 2 GiB readFileSync limit, with a text prefix so it
    // is classified as oversized text rather than binary.
    const big = join(fixture.root, 'big.txt');
    writeFileSync(big, `${'x'.repeat(8_192)}\n`);
    truncateSync(big, 2 ** 31 + 1);

    const fingerprint = scanRepository(fixture.root).fingerprint;
    const snapshot = buildProjectGraph(fixture.root, { curatedPath: null });
    assert.equal(snapshot.fingerprint, fingerprint);
    assert.match(
      snapshot.diagnostics.skippedContent.find((entry) => entry.path === 'big.txt')?.reason ?? '',
      /larger than/,
    );
    assert.equal(snapshot.files.find((file) => file.path === 'big.txt')?.size, 2 ** 31 + 1);
    assert.equal(snapshot.chunks.some((chunk) => chunk.path === 'big.txt'), false);
  } finally {
    fixture.cleanup();
  }
});

test(
  'store files are private from creation and an existing parent directory keeps its mode',
  { skip: process.platform === 'win32' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'sluice-project-graph-db-'));
    const mode = (path: string): number => statSync(path).mode & 0o777;
    const assertPrivate = (path: string): void => {
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        assert.equal(mode(file).toString(8), '600', file);
      }
    };
    try {
      chmodSync(directory, 0o755);
      const fresh = join(directory, 'graph.sqlite');
      const store = new ProjectGraphStore(fresh);
      try {
        assertPrivate(fresh);
      } finally {
        store.close();
      }
      assert.equal(mode(directory).toString(8), '755');

      // A database left world-readable by an older build still gets private sidecars.
      const legacy = join(directory, 'legacy.sqlite');
      writeFileSync(legacy, '');
      chmodSync(legacy, 0o644);
      const reopened = new ProjectGraphStore(legacy);
      try {
        assertPrivate(legacy);
      } finally {
        reopened.close();
      }

      const created = new ProjectGraphStore(join(directory, 'fresh', 'graph.sqlite'));
      created.close();
      assert.equal(mode(join(directory, 'fresh')).toString(8), '700');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('name search treats backslash, percent, and underscore literally', () => {
  const store = new ProjectGraphStore(':memory:');
  try {
    const snapshot = tinySnapshot('like');
    for (const name of ['xa\\by', 'xaby', '50%', '500']) {
      snapshot.nodes.push({ id: `file:${name}`, kind: 'file', name, description: 'like', source: 'indexer' });
    }
    store.replaceGenerated(snapshot, { repositoryRoot: tmpdir(), indexedHead: null });
    const names = (query: string, options?: { kinds?: string[]; limit?: number }): string[] =>
      store.searchNames(query, options).map((node) => node.name);

    assert.deepEqual(names('a\\b'), ['xa\\by']);
    assert.deepEqual(names('50%'), ['50%']);
    assert.doesNotThrow(() => names('abc\\'));
    // With kinds bound, the exact-name ordering and limit parameters still line up.
    assert.deepEqual(names('xa', { kinds: ['file'] }), ['xaby', 'xa\\by']);
    assert.deepEqual(names('xa\\by', { kinds: ['file'], limit: 1 }), ['xa\\by']);
  } finally {
    store.close();
  }
});

test('notes carrying credential-shaped values are rejected and flagged by validation', () => {
  const store = new ProjectGraphStore(':memory:');
  // Synthetic, but shaped like a Slack client token.
  const token = 'xoxc-111-222-333-abcdef';
  const rejects = (fields: Partial<Parameters<ProjectGraphStore['upsertNote']>[0]>): void => {
    assert.throws(
      () => store.upsertNote({ title: 'x', body: 'runtime fact', ...fields }),
      (error: unknown) =>
        error instanceof Error &&
        /credential \(pattern: slack-token\)/.test(error.message) &&
        !error.message.includes(token),
    );
  };
  try {
    store.replaceGenerated(tinySnapshot('notes'), { repositoryRoot: tmpdir(), indexedHead: null });
    rejects({ body: `token ${token}` });
    rejects({ title: `seen ${token}` });
    rejects({ tags: [token] });
    rejects({ evidencePaths: [`src/${token}.ts`] });
    rejects({ relatedNodeIds: [`file:${token}`] });
    rejects({ id: token });
    // Underscores slip past the title screen but slug into a token-shaped id.
    rejects({ title: token.replaceAll('-', '_') });
    assert.equal(store.listNodes('note').length, 0);

    const prose = store.upsertNote({
      id: 'prose',
      title: 'Slack token handling',
      body: "Slack's xoxc-/xoxd- tokens are masked by the app redaction.",
    });
    // A note stored before the screen existed survives refresh; validation must flag it.
    store.db
      .prepare(
        `INSERT INTO graph_nodes (id, kind, name, description, metadata, source, updated_at)
         VALUES ('note:legacy', 'note', 'legacy', ?, '{}', 'manual', 1)`,
      )
      .run(`d=${token}`);
    store.db
      .prepare(
        `INSERT INTO graph_nodes (id, kind, name, description, metadata, source, updated_at)
         VALUES (?, 'note', 'clean', 'clean', '{}', 'manual', 1)`,
      )
      .run(`note:${token}`);
    const validation = store.validate({ repositoryRoot: tmpdir(), currentFingerprint: 'notes' });
    assert.deepEqual(validation.invalidManualNotes.sort(), ['note:legacy', `note:${token}`].sort());
    assert.equal(validation.ok, false);
    assert.equal(store.getNode(prose.id)?.source, 'manual');
  } finally {
    store.close();
  }
});

test('MCP tool failures surface as isError results and the schema lists every node kind', async () => {
  const fixture = temporaryRepository();
  const store = new ProjectGraphStore(':memory:');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  try {
    const snapshot = buildProjectGraph(fixture.root, { curatedPath: null });
    store.replaceGenerated(snapshot, { repositoryRoot: fixture.root, indexedHead: null });
    const status = (): GraphStatus =>
      store.status({ repositoryRoot: fixture.root, currentFingerprint: snapshot.fingerprint });
    const server = buildProjectGraphServer({ root: fixture.root, store, refresh: status, status });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text?: string }>;
      return { isError: result.isError, text: content[0]?.text ?? '' };
    };
    for (const name of ['project_graph_get', 'project_graph_impact', 'project_graph_neighbors']) {
      const result = await call(name, { idOrPath: 'nope:missing' });
      assert.equal(result.isError, true, name);
      assert.equal(result.text, 'No graph node matched nope:missing', name);
    }
    assert.deepEqual(await call('project_graph_trace', { from: 'a', to: 'b' }), {
      isError: true,
      text: 'Could not resolve from=a and to=b',
    });
    assert.deepEqual(await call('project_graph_trace', { from: 'file:src/main.ts', to: 'b' }), {
      isError: true,
      text: 'Could not resolve to=b',
    });

    const schema = await client.readResource({ uri: 'sluice-graph://project/schema' });
    const first = schema.contents[0];
    const parsed = JSON.parse(first && 'text' in first ? first.text : 'null') as {
      nodeKinds: string[];
      edgeKinds: Record<string, number>;
    };
    assert.deepEqual(parsed.nodeKinds, [...GRAPH_NODE_KINDS]);
    assert.ok((parsed.edgeKinds.imports ?? 0) > 0);

    const { tools } = await client.listTools();
    const hints = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
    assert.equal(hints('project_graph_refresh')?.readOnlyHint, false);
    assert.equal(hints('project_graph_refresh')?.idempotentHint, true);
    assert.equal(hints('project_graph_note_upsert')?.idempotentHint, false);
    assert.equal(hints('project_graph_note_delete')?.destructiveHint, true);
  } finally {
    await client.close();
    store.close();
    fixture.cleanup();
  }
});
