// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CLI tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * These spawn the real CLI rather than importing its internals, because the
 * thing worth testing IS the argument handling — a flag that parses but is never
 * read looks identical to a working flag from the inside.
 *
 * Every command exercised here returns before it would touch a credential: an
 * unknown `--adapter` is rejected up front, `--list` never acquires a session,
 * and the worklist seeds fed to `replay --all` are deliberately unresolvable, so
 * the drain settles them before it would ask for one. The suite therefore runs
 * on any machine and raises no Keychain prompt.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { SqliteStore } from '@sluice/core';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      { timeout: 60_000 },
    );
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

// ── on-disk fixtures ─────────────────────────────────────────────────────────
// The CLI is spawned as a real process, so it needs a real database file; the
// store is seeded in-process here rather than through the CLI because what is
// under test is what `export` and `replay --all` DO with rows, not how rows get
// there.

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sluice-cli-'));
  scratchDirs.push(dir);
  return dir;
}

/** Two containers, three items, one named author. Returns the db path. */
function seededDb(): string {
  const dbPath = join(scratch(), 'sluice.db');
  const store = new SqliteStore(dbPath);
  store.applyParseResult(
    {
      workspaces: [{ id: 'W1', adapterId: 'slack', name: 'Acme Inc' }],
      actors: [
        { id: 'U1', workspaceId: 'W1', adapterId: 'slack', handle: 'ada', displayName: 'Ada Lovelace' },
      ],
      containers: [
        { id: 'C1', workspaceId: 'W1', adapterId: 'slack', kind: 'channel', name: 'general' },
        { id: 'C2', workspaceId: 'W1', adapterId: 'slack', kind: 'channel', name: 'random' },
      ],
      items: [
        {
          id: 'M1',
          containerId: 'C1',
          workspaceId: 'W1',
          adapterId: 'slack',
          kind: 'message',
          authorId: 'U1',
          ts: 1_700_000_000_000,
          text: 'first message',
        },
        {
          id: 'M2',
          containerId: 'C1',
          workspaceId: 'W1',
          adapterId: 'slack',
          kind: 'message',
          authorId: 'U1',
          ts: 1_700_000_060_000,
          text: 'second message',
        },
        {
          id: 'M3',
          containerId: 'C2',
          workspaceId: 'W1',
          adapterId: 'slack',
          kind: 'message',
          ts: 1_700_000_120_000,
          text: 'other channel',
        },
      ],
    },
    1_700_000_000_000,
  );
  store.close();
  return dbPath;
}

test('replay --list shows actions from every installed app', async () => {
  const { code, out } = await run('replay', '--list');
  assert.equal(code, 0);
  assert.match(out, /slack\./, 'slack actions should be listed');
  assert.match(out, /trello\./, 'trello actions should be listed');
});

test('replay --adapter scopes the listing', async () => {
  // The flag was declared and never read, so this passed vacuously before:
  // every adapter's actions came back whatever was asked for.
  const { code, out } = await run('replay', '--list', '--adapter', 'trello');
  assert.equal(code, 0);
  assert.match(out, /trello\./);
  assert.doesNotMatch(out, /slack\./, '--adapter trello must not list slack actions');
});

test('an unknown --adapter is rejected, and names what is installed', async () => {
  const { code, err } = await run('replay', '--list', '--adapter', 'notanapp');
  assert.equal(code, 1);
  assert.match(err, /Unknown adapter/);
  assert.match(err, /slack/, 'the error should say what IS installed');
});

test('extract-token rejects an unknown --adapter before touching the Keychain', async () => {
  // Ordering is the point: the guard runs before acquireSession, so a typo does
  // not raise a consent prompt for every installed app on the way to failing.
  const { code, err } = await run('extract-token', '--adapter', 'notanapp');
  assert.equal(code, 1);
  assert.match(err, /Unknown adapter/);
});

test('record and mock are registered and document themselves', async () => {
  const record = await run('record', '--help');
  assert.equal(record.code, 0);
  assert.match(record.out, /NDJSON/);

  const mock = await run('mock', '--help');
  assert.equal(mock.code, 0);
  assert.match(mock.out, /--speed/);
});

test('mock fails cleanly when the fixture does not exist', async () => {
  const { code, err } = await run('mock', '/nonexistent/fixture.ndjson');
  assert.equal(code, 1);
  assert.match(err, /not found/i);
});

test('an unknown command exits non-zero rather than doing something', async () => {
  const { code } = await run('definitely-not-a-command');
  assert.notEqual(code, 0);
});

test('start --help documents the host scoping flags', async () => {
  // These gate what the proxy is allowed to decrypt, so they have to be
  // discoverable without reading the source.
  const { code, out } = await run('start', '--help');
  assert.equal(code, 0);
  assert.match(out, /--host/);
  assert.match(out, /--all-hosts/);
});

// ── export formats ───────────────────────────────────────────────────────────

test('export still writes one JSON document to --out FILE', async () => {
  // The behaviour that predates --format. Something out there parses this shape,
  // so adding formats must not have moved a single field.
  const db = seededDb();
  const out = join(scratch(), 'general.json');
  const { code } = await run('export', 'C1', '--db', db, '--out', out);
  assert.equal(code, 0);
  const payload = JSON.parse(readFileSync(out, 'utf8')) as {
    itemCount: number;
    container: { name: string };
    items: Array<{ id: string }>;
  };
  assert.equal(payload.itemCount, 2);
  assert.equal(payload.container.name, 'general');
  assert.deepEqual(
    payload.items.map((i) => i.id).sort(),
    ['M1', 'M2'],
    'only the named container’s items',
  );
});

test('export --format ndjson writes one item per line and nothing else', async () => {
  const db = seededDb();
  const { code, out } = await run('export', 'C1', '--db', db, '--format', 'ndjson');
  assert.equal(code, 0);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2, 'two items means exactly two lines');
  for (const line of lines) {
    const item = JSON.parse(line) as { containerId: string };
    assert.equal(item.containerId, 'C1', 'every line is a whole Item, with no envelope');
  }
});

test('export --format markdown dates and attributes every entry', async () => {
  const db = seededDb();
  const { code, out } = await run('export', 'C1', '--db', db, '--format', 'markdown');
  assert.equal(code, 0);
  assert.match(out, /^# general/, 'the container title leads');
  assert.match(out, /2023-11-14T22:13:20\.000Z — Ada Lovelace/, 'dated, and the author is named');
  assert.match(out, /first message/);
  // A transcript reads forwards; the store answers newest-first.
  assert.ok(
    out.indexOf('first message') < out.indexOf('second message'),
    'markdown is oldest-first',
  );
});

test('export --format sqlite writes a standalone db of just that container', async () => {
  const db = seededDb();
  const out = join(scratch(), 'general.db');
  const { code } = await run('export', 'C1', '--db', db, '--format', 'sqlite', '--out', out);
  assert.equal(code, 0);
  assert.ok(existsSync(out), 'the database file exists on its own');
  const exported = new SqliteStore(out);
  try {
    assert.equal(exported.listItems('C1').length, 2);
    assert.equal(exported.queryItems({ limit: 100 }).length, 2, 'C2’s item is not in C1’s export');
    assert.equal(exported.listContainers().length, 1);
    assert.equal(exported.countCaptures(), 0, 'an export carries entities, never raw traffic');
  } finally {
    exported.close();
  }
});

test('export --format sqlite refuses stdout instead of emitting a broken file', async () => {
  const db = seededDb();
  const { code, err } = await run('export', 'C1', '--db', db, '--format', 'sqlite');
  assert.equal(code, 1);
  assert.match(err, /--out/);
});

test('export rejects an unknown --format and names the valid ones', async () => {
  const { code, err } = await run('export', 'C1', '--format', 'yaml');
  assert.equal(code, 1);
  assert.match(err, /ndjson/);
});

test('export --all --out DIR writes one file per container', async () => {
  const db = seededDb();
  const dir = join(scratch(), 'dump');
  const { code, err } = await run('export', '--all', '--db', db, '--out', dir, '--format', 'ndjson');
  assert.equal(code, 0);
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ['general-C1.ndjson', 'random-C2.ndjson']);
  assert.equal(readFileSync(join(dir, 'random-C2.ndjson'), 'utf8').trim().split('\n').length, 1);
  assert.match(err, /2 container\(s\), 3 item\(s\)/);
});

test('export --all without --out refuses rather than concatenating to stdout', async () => {
  const db = seededDb();
  const { code, err } = await run('export', '--all', '--db', db);
  assert.equal(code, 1);
  assert.match(err, /--out DIR/);
});

// ── replay --all: draining the cursor worklist ───────────────────────────────

test('replay --all --dry-run says an empty worklist is empty, and exits 0', async () => {
  // No adapter seeds cursors during passive capture, so this is the NORMAL
  // result — and it has to read as "drained", not as a broken command.
  const db = seededDb();
  const { code, out } = await run('replay', '--all', '--dry-run', '--db', db);
  assert.equal(code, 0);
  assert.match(out, /0 pending/);
  assert.match(out, /worklist is empty/);
});

test('replay --all --dry-run lists the work and claims nothing', async () => {
  const db = seededDb();
  const store = new SqliteStore(db);
  store.enqueueCursors([
    { adapterId: 'slack', actionId: 'slack.conversations.history', containerId: 'C1', cursor: 'page2' },
  ]);
  store.close();

  const { code, out } = await run('replay', '--all', '--dry-run', '--db', db);
  assert.equal(code, 0);
  assert.match(out, /Would replay 1 item/);
  assert.match(out, /slack\.conversations\.history/);

  const after = new SqliteStore(db);
  try {
    assert.equal(after.countCursors().pending, 1, 'a dry run must leave the item claimable');
    assert.equal(after.countCursors().running, 0);
  } finally {
    after.close();
  }
});

test('replay --all drains the worklist it is given', async () => {
  // Both seeds are deliberately unresolvable, which is what keeps this test
  // credential-free: the drain settles them before it would acquire a session.
  // What is under test is the loop — claim, resolve, settle, until empty.
  const db = seededDb();
  const store = new SqliteStore(db);
  store.enqueueCursors([
    { adapterId: 'slack', actionId: 'slack.no.such.action', containerId: 'C1' },
    { adapterId: 'not-an-app', actionId: 'whatever' },
  ]);
  store.close();

  const { code, out } = await run('replay', '--all', '--db', db);
  assert.equal(code, 0);
  assert.match(out, /2 pending/, 'it reports the worklist it found');
  assert.match(out, /Drained: 0 replayed, 2 failed/);

  const after = new SqliteStore(db);
  try {
    const counts = after.countCursors();
    assert.equal(counts.pending, 0, 'nothing is left claimable');
    assert.equal(counts.running, 0, 'nothing is left stranded as claimed');
    assert.equal(counts.failed, 2, 'each unresolvable seed records why');
  } finally {
    after.close();
  }
});

test('replay --all --container leaves the other containers’ work queued', async () => {
  // The claim is atomic and has no container filter, so work this run declines
  // to do is claimed and must be given back — settling it would lose the page.
  const db = seededDb();
  const store = new SqliteStore(db);
  store.enqueueCursors([
    { adapterId: 'slack', actionId: 'slack.no.such.action', containerId: 'C1' },
    { adapterId: 'slack', actionId: 'slack.no.such.action', containerId: 'C2' },
  ]);
  store.close();

  const { code, out } = await run('replay', '--all', '--container', 'C1', '--db', db);
  assert.equal(code, 0);
  assert.match(out, /1 failed, 1 skipped/);

  const after = new SqliteStore(db);
  try {
    assert.equal(after.countCursors().pending, 1, 'C2’s page is claimable again');
    assert.equal(after.countCursors().running, 0);
  } finally {
    after.close();
  }
});

test('replay --all releases claims a killed drainer stranded', async () => {
  const db = seededDb();
  const store = new SqliteStore(db);
  store.enqueueCursors([{ adapterId: 'not-an-app', actionId: 'whatever' }]);
  store.claimCursors(1); // simulate a drainer that died holding the claim
  assert.equal(store.countCursors().running, 1);
  store.close();

  const { code, err } = await run('replay', '--all', '--db', db);
  assert.equal(code, 0);
  assert.match(err, /Released 1 stranded claim/);

  const after = new SqliteStore(db);
  try {
    assert.equal(after.countCursors().running, 0);
  } finally {
    after.close();
  }
});

test('replay refuses an action id together with --all', async () => {
  const { code, err } = await run('replay', 'slack.users.list', '--all');
  assert.equal(code, 1);
  assert.match(err, /either an action id or --all/);
});
