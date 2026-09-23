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
import { readNdjsonFile } from './ndjson-file.js';

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

test('record writes one line per capture, oldest first, in the form mock reads back', async () => {
  // record writes line by line and mock reads in chunks (a single joined string
  // capped both at ~512 MB). This pins that the two still agree on the format.
  const dbPath = join(scratch(), 'sluice.db');
  const store = new SqliteStore(dbPath);
  for (const [i, ts] of [1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000].entries()) {
    store.insertCapture({
      id: `cap_${i}`,
      ts,
      source: 'mitm',
      adapterId: null,
      method: 'GET',
      url: `https://api.example.test/v1/items/${i}`,
      host: 'api.example.test',
      path: `/v1/items/${i}`,
      status: 200,
      durationMs: 5,
      reqHeaders: {},
      reqBody: null,
      resHeaders: {},
      resBody: `{"title":"Café ${i} 🧪"}`,
    });
  }
  store.close();

  const file = join(scratch(), 'fixture.ndjson');
  const { code, err } = await run('record', '--out', file, '--db', dbPath);
  assert.equal(code, 0);
  assert.match(err, /Wrote 3 captures/);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.split('\n').length, 4, 'three lines, each newline-terminated');

  const { captures, skipped } = readNdjsonFile(file);
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    captures.map((c) => c.id),
    ['cap_0', 'cap_1', 'cap_2'],
    'oldest first',
  );
  assert.equal(captures[2]?.resBody, '{"title":"Café 2 🧪"}');

  const piped = await run('record', '--db', dbPath);
  assert.equal(piped.code, 0);
  assert.equal(piped.out, text, 'stdout carries the same bytes as --out');
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
  assert.match(out, /default when no --host/i);
});

test('serve --help documents default all-host decrypt', async () => {
  const { code, out } = await run('serve', '--help');
  assert.equal(code, 0);
  assert.match(out, /--host/);
  assert.match(out, /every host is decrypted/i);
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


test('flows list and learn-flows work against a seeded db', async () => {
  const db = join(scratch(), 'flows.db');
  const store = new SqliteStore(db);
  const T0 = 1_700_000_000_000;
  const cap = (over: Partial<import('@sluice/core').Capture>): import('@sluice/core').Capture => ({
    id: 'x',
    ts: T0,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/api.test',
    host: 'slack.com',
    path: '/api/api.test',
    status: 200,
    durationMs: 10,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: null,
    ...over,
  });
  store.insertCapture(
    cap({
      id: 'p',
      path: '/api/conversations.history',
      url: 'https://slack.com/api/conversations.history',
      classification: 'conversations.history',
      reqBody: 'token=«redacted»&channel=C1&limit=50',
    }),
  );
  store.insertCapture(
    cap({
      id: 'c',
      ts: T0 + 40,
      path: '/api/conversations.members',
      url: 'https://slack.com/api/conversations.members',
      classification: 'conversations.members',
      reqBody: 'token=«redacted»&channel=C1',
    }),
  );
  store.upsertFlow({
    id: 'flow-obs',
    adapterId: 'slack',
    primaryCaptureId: 'p',
    startedAt: T0,
    endedAt: T0 + 50,
    source: 'observed',
    steps: [
      { captureId: 'p', seq: 0, role: 'primary', operation: 'conversations.history', required: true },
      { captureId: 'c', seq: 1, role: 'companion', operation: 'conversations.members', required: false },
    ],
  });
  store.close();

  const list = await run('flows', 'list', '--db', db);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /flow-obs/);
  assert.match(list.out, /conversations\.history/);

  const pin = await run('flows', 'pin', 'flow-obs', '--db', db);
  assert.equal(pin.code, 0, pin.err);
  assert.match(pin.out, /pinned/);

  const learn = await run('learn-flows', '--adapter', 'slack', '--no-cluster', '--db', db);
  assert.equal(learn.code, 0, learn.err);
  assert.match(learn.out, /learned /);

  const tmpls = await run('flows', 'templates', '--adapter', 'slack', '--db', db);
  assert.equal(tmpls.code, 0, tmpls.err);
  assert.match(tmpls.out, /conversations\.history/);
});

test('flows help and unknown subcommand exit cleanly', async () => {
  const help = await run('flows', '--help');
  assert.equal(help.code, 0);
  assert.match(help.out, /pin-captures/);

  const bad = await run('flows', 'nope');
  assert.equal(bad.code, 1);
});

test('replay --flow without a template fails before session acquire', async () => {
  const db = join(scratch(), 'empty-flow.db');
  new SqliteStore(db).close();
  const { code, err } = await run('replay', '--flow', 'missing-tmpl', '--db', db);
  assert.equal(code, 1);
  assert.match(err, /Unknown flow template|learn-flows|flows list/);
});

// ── workspace selection ──────────────────────────────────────────────────────
// Pasted --token/--cookie sessions, so no extractor runs and no Keychain prompt
// is raised. Each case exits before a request is built, so nothing leaves the
// machine either.

const PASTED = ['--token', 'xoxc-not-a-real-token', '--cookie', 'd=not-a-real-cookie'];

test('replay --workspace that matches nothing fails and names the workspaces there are', async () => {
  const { code, err } = await run('replay', 'slack.conversations.list', '--workspace', 'no-such-team', ...PASTED);
  assert.equal(code, 1);
  assert.match(err, /No workspace matching "no-such-team"\. Have: Slack \(paste-in\)/);
});

test('replay --workspace matches a label substring, ignoring case', async () => {
  // Past the selector, the malformed --param is the next thing to fail, which
  // shows the workspace was accepted without sending anything.
  const { code, err } = await run(
    'replay',
    'slack.conversations.list',
    '--workspace',
    'PASTE-IN',
    '--param',
    'noequals',
    ...PASTED,
  );
  assert.equal(code, 1);
  assert.doesNotMatch(err, /No workspace matching/);
  assert.match(err, /Bad --param "noequals"/);
});

test('sync --workspace shares the matcher and the miss message', async () => {
  const { code, err } = await run('sync', '--workspace', 'no-such-team', ...PASTED);
  assert.equal(code, 1);
  assert.match(err, /No workspace matching "no-such-team"\. Have: Slack \(paste-in\)/);
});

// ── reparse ──────────────────────────────────────────────────────────────────

/**
 * One Notion page observed twice, renamed in between, stored with no adapter —
 * the shape of traffic captured before its app was installed.
 *
 * Bodies are the real `loadPageChunk` envelope, doubly-nested wrapper included,
 * because the whole point is that the installed adapter parses them.
 */
function renamedPageDb(): { dbPath: string; pageId: string } {
  const dbPath = join(scratch(), 'sluice.db');
  const store = new SqliteStore(dbPath);
  const pageId = 'f1c3b2a0-6d4e-4f8a-9b7c-2e5d8a1f0c34';
  const space = '5e9a7c1d-3b2f-4e6a-8d0c-7f4b1a9e2d58';
  const chunk = (title: string, editedAt: number): string =>
    JSON.stringify({
      recordMap: {
        __version__: 3,
        block: {
          [pageId]: {
            spaceId: space,
            value: {
              role: 'editor',
              value: {
                id: pageId,
                type: 'page',
                properties: { title: [[title]] },
                parent_id: 'c0000000-0000-4000-8000-000000000001',
                parent_table: 'collection',
                space_id: space,
                last_edited_time: editedAt,
                alive: true,
              },
            },
          },
        },
      },
    });

  for (const [i, [title, ts]] of (
    [
      ['old name', 1_757_000_000_000],
      ['NEW NAME', 1_757_900_000_000],
    ] as const
  ).entries()) {
    store.insertCapture({
      id: `cap_${i}`,
      ts,
      source: 'mitm',
      adapterId: null, // captured before app-notion existed — the case reparse exists for
      method: 'POST',
      url: 'https://app.notion.com/api/v3/loadPageChunk',
      host: 'app.notion.com',
      path: '/api/v3/loadPageChunk',
      status: 200,
      durationMs: 10,
      reqHeaders: {},
      reqBody: JSON.stringify({ pageId }),
      resHeaders: {},
      resBody: chunk(title, ts),
      parsedAt: ts, // stamped but never parsed: exactly what ingestCapture leaves behind
    });
  }
  store.close();
  return { dbPath, pageId };
}

test('reparse applies captures oldest-first, so the newest observation wins', async () => {
  const { dbPath, pageId } = renamedPageDb();

  const dry = await run('reparse', '--adapter', 'notion', '--dry-run', '--db', dbPath);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /would claim 2/);
  const untouched = new SqliteStore(dbPath);
  assert.equal(untouched.queryItems({ adapterId: 'notion' }).length, 0, '--dry-run writes nothing');
  untouched.close();

  const { code, out } = await run('reparse', '--adapter', 'notion', '--db', dbPath);
  assert.equal(code, 0);
  assert.match(out, /claimed 2/);

  const store = new SqliteStore(dbPath);
  const items = store.queryItems({ adapterId: 'notion' });
  assert.equal(items.length, 1);
  // Newest-first application would leave 'old name' here: entity upserts are
  // last-writer-wins, so the last capture applied is the one that sticks.
  assert.equal(items[0]?.text, 'NEW NAME');
  assert.equal(items[0]?.id, pageId);
  // Attribution is written back, so a second run has nothing left to claim.
  assert.equal(store.countCaptures({ unattributed: true }), 0);
  store.close();

  const again = await run('reparse', '--adapter', 'notion', '--db', dbPath);
  assert.equal(again.code, 0);
  assert.match(again.out, /No app claimed anything|scanned 0/);
});

test('reparse --reapply heals rows an out-of-order run already wrote', async () => {
  const { dbPath } = renamedPageDb();
  await run('reparse', '--adapter', 'notion', '--db', dbPath);

  // Simulate the damage the newest-first walk used to leave: the earliest
  // observation sitting in a row whose captures are all attributed, so a plain
  // reparse has nothing left to claim and cannot reach it.
  const store = new SqliteStore(dbPath);
  const [item] = store.queryItems({ adapterId: 'notion' });
  store.upsertItem({ ...item!, text: 'old name' });
  store.close();

  const plain = await run('reparse', '--adapter', 'notion', '--db', dbPath);
  assert.match(plain.out, /scanned 0 unattributed/);
  const stale = new SqliteStore(dbPath);
  assert.equal(stale.queryItems({ adapterId: 'notion' })[0]?.text, 'old name');
  stale.close();

  const healed = await run('reparse', '--adapter', 'notion', '--reapply', '--db', dbPath);
  assert.equal(healed.code, 0);
  assert.match(healed.out, /re-read 2/);
  const fixed = new SqliteStore(dbPath);
  assert.equal(fixed.queryItems({ adapterId: 'notion' })[0]?.text, 'NEW NAME');
  fixed.close();
});

test('reparse drains a millisecond that holds more captures than one page', async () => {
  // 600 captures no installed app matches, all at one ms, then 10 Notion ones a
  // ms later. Unmatched rows stay unattributed, so the first 500 come back on
  // every page; a walk keyed on ts alone re-read them, saw nothing new and
  // stopped with exit 0, having claimed none of the Notion captures behind them.
  const dbPath = join(scratch(), 'sluice.db');
  const store = new SqliteStore(dbPath);
  const base = 1_757_000_000_000;
  const add = (id: string, ts: number, host: string, path: string): void =>
    store.insertCapture({
      id,
      ts,
      source: 'mitm',
      adapterId: null,
      method: 'POST',
      url: `https://${host}${path}`,
      host,
      path,
      status: 200,
      durationMs: 1,
      reqHeaders: {},
      reqBody: '{}',
      resHeaders: {},
      resBody: '{}',
      parsedAt: ts,
    });
  for (let i = 0; i < 600; i++) add(`cap_other_${String(i).padStart(3, '0')}`, base, 'telemetry.example.test', '/v1/events');
  for (let i = 0; i < 10; i++) add(`cap_notion_${i}`, base + 1, 'app.notion.com', '/api/v3/loadPageChunk');
  store.close();

  const dry = await run('reparse', '--adapter', 'notion', '--dry-run', '--db', dbPath);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /scanned 610 unattributed/);
  assert.match(dry.out, /would claim 10/);

  const real = await run('reparse', '--adapter', 'notion', '--db', dbPath);
  assert.equal(real.code, 0, real.err);
  assert.match(real.out, /scanned 610 unattributed/);
  assert.match(real.out, /claimed 10/);
  const after = new SqliteStore(dbPath);
  assert.equal(after.countCaptures({ adapterId: 'notion' }), 10);
  assert.equal(after.countCaptures({ unattributed: true }), 600, 'the unmatched rows are left alone');
  after.close();
});

test('reparse --reapply without --adapter refuses rather than re-deriving everything', async () => {
  const { code, err } = await run('reparse', '--reapply');
  assert.equal(code, 1);
  assert.match(err, /--reapply needs --adapter/);
});
