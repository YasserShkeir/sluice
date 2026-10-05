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
 * the drain settles them before it would ask for one — or belong to Toters,
 * which has nothing to extract. The suite therefore runs on any machine and
 * raises no Keychain prompt.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { KEYCHAIN_ALLOW_ADVICE, SqliteStore } from '@sluice/core';
import type { Capture, CredentialHint } from '@sluice/core';
import { readNdjsonFile } from './ndjson-file.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
/** tsx resolved from here: a bare `--import tsx` resolves from the CWD, which a test may move. */
const TSX = import.meta.resolve('tsx');

/**
 * A throwaway HOME for every spawned CLI. Commands that open a store create and
 * tighten `~/.sluice`; a test run must never touch the real one — nor read the
 * real config's app allow-list. Paste-in env vars are cleared for the same
 * reason: the machine's own environment must not change what a test asserts.
 */
const HOME = mkdtempSync(join(tmpdir(), 'sluice-cli-home-'));
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME, ...extra };
  if (!('SLUICE_TOKEN' in extra)) delete env.SLUICE_TOKEN;
  if (!('SLUICE_COOKIE' in extra)) delete env.SLUICE_COOKIE;
  return env;
}

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return runWith({}, ...args);
}

async function runWith(
  opts: { env?: Record<string, string>; stdin?: string; cwd?: string },
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  if (opts.stdin === undefined) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', TSX, CLI, ...args], {
        timeout: 60_000,
        env: cliEnv(opts.env),
        cwd: opts.cwd,
      });
      return { code: 0, out: stdout, err: stderr };
    } catch (e) {
      const x = e as { code?: number; stdout?: string; stderr?: string };
      return { code: x.code ?? 1, out: x.stdout ?? '', err: x.stderr ?? '' };
    }
  }
  // execFile cannot feed stdin, which `--token -` reads.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], { env: cliEnv(opts.env), cwd: opts.cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
    child.stdin.end(opts.stdin);
  });
}

// ── on-disk fixtures ─────────────────────────────────────────────────────────
// The CLI is spawned as a real process, so it needs a real database file; the
// store is seeded in-process here rather than through the CLI because what is
// under test is what `export` and `replay --all` DO with rows, not how rows get
// there.

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
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
  assert.match(out, /--lan-proxy/);
  assert.match(out, /default when no --host/i);
});

test('serve --help documents default all-host decrypt', async () => {
  const { code, out } = await run('serve', '--help');
  assert.equal(code, 0);
  assert.match(out, /--host/);
  assert.match(out, /--lan-proxy/);
  assert.match(out, /--lan-allow/);
  assert.match(out, /every host is decrypted/i);
});

test('--lan-proxy is refused without a --lan-allow client, before anything binds', async () => {
  // Each of these fails at argument validation, so no store opens and no port
  // or proxy is bound.
  for (const cmd of ['serve', 'start']) {
    const bare = await run(cmd, '--lan-proxy', '--db', join(scratch(), 's.db'));
    assert.equal(bare.code, 1, `${cmd} --lan-proxy alone`);
    assert.match(bare.err, /--lan-proxy needs --lan-allow/);
  }
  const notIp = await run('serve', '--lan-proxy', '--lan-allow', 'my-phone', '--db', join(scratch(), 's.db'));
  assert.equal(notIp.code, 1);
  assert.match(notIp.err, /takes an IP address, not "my-phone"/);
  const withoutLan = await run('start', '--lan-allow', '192.168.1.50', '--db', join(scratch(), 's.db'));
  assert.equal(withoutLan.code, 1);
  assert.match(withoutLan.err, /only applies with --lan-proxy/);
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

/** Make a claim look an hour old — past the drainer's lease, so it reads as stranded. */
function backdateClaim(store: SqliteStore, id: string): void {
  store.db.prepare(`UPDATE cursors SET updated_ts = @ts WHERE id = @id`).run({ ts: Date.now() - 3_600_000, id });
}

test('replay --all releases claims a killed drainer stranded', async () => {
  const db = seededDb();
  const store = new SqliteStore(db);
  store.enqueueCursors([
    { adapterId: 'not-an-app', actionId: 'whatever', cursor: 'dead' },
    { adapterId: 'not-an-app', actionId: 'whatever', cursor: 'live' },
  ]);
  const [dead] = store.claimCursors(1); // a drainer that died holding the claim an hour ago
  backdateClaim(store, dead!.id);
  store.claimCursors(1); // a drainer still running, inside its lease
  assert.equal(store.countCursors().running, 2);
  store.close();

  const { code, err } = await run('replay', '--all', '--db', db);
  assert.equal(code, 0);
  assert.match(err, /Released 1 stranded claim/);

  const after = new SqliteStore(db);
  try {
    assert.equal(after.countCursors().running, 1, "the live drainer's claim is not stolen");
    assert.equal(after.listCursors({ state: 'running' })[0]?.cursor, 'live');
  } finally {
    after.close();
  }
});

test('replay refuses an action id together with --all', async () => {
  const { code, err } = await run('replay', 'slack.users.list', '--all');
  assert.equal(code, 1);
  assert.match(err, /either an action id or --all/);
});

test('replay --all drains the store the config file names, as every other command does', async () => {
  // It used to open `--db` or the default only, so a sluice.config.json `db`
  // was honoured by `replay <action>` and ignored by `replay --all`.
  const db = seededDb();
  const store = new SqliteStore(db);
  store.enqueueCursors([{ adapterId: 'not-an-app', actionId: 'whatever' }]);
  store.close();
  const dir = scratch();
  writeFileSync(join(dir, 'sluice.config.json'), JSON.stringify({ db }));

  const { code, out } = await runWith({ cwd: dir }, 'replay', '--all', '--dry-run');
  assert.equal(code, 0);
  assert.match(out, /Would replay 1 item/);
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
  // Anchored: the pasted pair made exactly ONE session, not one per app.
  assert.match(err, /No workspace matching "no-such-team"\. Have: Slack \(paste-in\)$/m);
});

test('replay --workspace matches a label substring, ignoring case', async () => {
  // Past the selector, opening the store is the next step, and this --db cannot
  // be opened: its parent is a file. Failing there shows the workspace was
  // accepted, and it fails before any request is built, so nothing is sent.
  const blocker = join(scratch(), 'not-a-dir');
  writeFileSync(blocker, '');
  const { code, err } = await run(
    'replay',
    'slack.conversations.list',
    '--workspace',
    'PASTE-IN',
    '--db',
    join(blocker, 'x.db'),
    ...PASTED,
  );
  assert.equal(code, 1);
  assert.doesNotMatch(err, /No workspace matching/);
  assert.match(err, /EEXIST|ENOTDIR|not a directory|unable to open/i);
});

test('replay rejects a malformed --param before acquiring any session', async () => {
  // No pasted credentials: acquiring a session first would run the extractors
  // (and, on macOS, could raise a Keychain prompt) only to report a typo.
  const { code, err } = await run('replay', 'slack.users.list', '--param', 'bad');
  assert.equal(code, 1);
  assert.match(err, /Bad --param "bad"/);
  assert.doesNotMatch(err, /No session/);
  assert.ok(!err.includes(KEYCHAIN_ALLOW_ADVICE), 'no extraction was started');
});

test('sync --workspace shares the matcher and the miss message', async () => {
  const { code, err } = await run('sync', '--workspace', 'no-such-team', ...PASTED);
  assert.equal(code, 1);
  assert.match(err, /No workspace matching "no-such-team"\. Have: Slack \(paste-in\)$/m);
});

test('replay --flow redacts the error and step detail it prints', async () => {
  // A step whose built URL carries a token-shaped value in its host is refused
  // at build time, and the refusal quotes the host. Refused before the network,
  // so nothing is sent; the value is assembled at runtime so no scanner sees one.
  const fake = `${['xo', 'xb-'].join('')}1234567890-${'a'.repeat(24)}`;
  const db = join(scratch(), 'flow-redact.db');
  const store = new SqliteStore(db);
  store.upsertFlowTemplate({
    id: 'tmpl-redact',
    adapterId: 'slack',
    primaryKey: 'conversations.history',
    sampleCount: 1,
    version: 1,
    learnedAt: 1_700_000_000_000,
    flowParams: [],
    steps: [
      {
        seq: 0,
        role: 'primary',
        method: 'GET',
        path: 'https://{h}.example.test/api/x',
        params: { h: { kind: 'literal', value: fake } },
        required: true,
        support: 1,
        delayMsP50: 0,
      },
    ],
  });
  store.close();

  const { code, out, err } = await run('replay', '--flow', 'tmpl-redact', '--db', db, ...PASTED);
  assert.equal(code, 1);
  assert.match(out, /FAILED/);
  assert.match(out, /denied/);
  assert.ok(!`${out}${err}`.includes(fake), 'the token-shaped value is masked');
});

// ── pasted credentials name ONE app ──────────────────────────────────────────

test('a pasted Slack pair becomes a Slack session only — never another app’s', async () => {
  // Offered to every provider, the same xoxc-/d= pair also minted a Toters
  // session, and `sync` sent the Slack token to api.toters-api.com as a Bearer.
  const { code, err } = await run('sync', '--workspace', 'no-such-team', ...PASTED);
  assert.equal(code, 1);
  assert.doesNotMatch(err, /Toters/, 'the pair must not reach another app’s provider');
});

/** Not Slack-shaped, so only the env/flag binding — not Toters' own xox refusal — keeps it from Toters. */
const TOTERS_PASTE = ['--token', 'not-a-real-toters-token'];

test('--adapter names the app pasted credentials are for', async () => {
  const { code, err } = await run('sync', '--adapter', 'toters', '--workspace', 'no-such-team', ...TOTERS_PASTE);
  assert.equal(code, 1);
  assert.match(err, /Have: Toters \(pasted token\)$/m);
  assert.doesNotMatch(err, /Slack/);

  const replay = await run('replay', 'toters.user.info', '--adapter', 'toters', '--workspace', 'no-such-team', ...TOTERS_PASTE);
  assert.match(replay.err, /Have: Toters \(pasted token\)$/m);
});

test('a pasted token never reaches the app a replay targets unless --adapter names it', async () => {
  // SLUICE_TOKEN may be ambient in the shell: `replay <toters action>` used to
  // hand it to Toters as a Bearer. --workspace keeps every run offline.
  const env = { SLUICE_TOKEN: 'not-a-real-toters-token' };
  const r = await runWith({ env }, 'replay', 'toters.user.info', '--workspace', 'no-such-team');
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.err, /Toters \(pasted token\)/);
  assert.match(r.err, /pass --adapter toters/);
});

test('replay --all never offers a paste to another app’s queued work', async () => {
  // A resolvable Toters page, so the drain does ask for a session. Missing its
  // storeId, so even a regression dies in the builder and sends nothing.
  const db = seededDb();
  const store = new SqliteStore(db);
  store.enqueueCursors([{ adapterId: 'toters', actionId: 'toters.store.popular-items' }]);
  store.close();

  const { code, out, err } = await run('replay', '--all', '--db', db, ...TOTERS_PASTE);
  assert.equal(code, 0);
  assert.match(err, /Pasted credentials are for slack, not toters/);
  assert.match(err, /No toters session/);
  assert.match(out, /0 replayed, 0 failed, 1 skipped/);

  const after = new SqliteStore(db);
  try {
    assert.equal(after.countCursors().pending, 1, 'the page stays queued for a run that has its session');
    assert.equal(after.countCursors().running, 0);
  } finally {
    after.close();
  }
});

test('a paste for an app that cannot take one fails instead of reading its local session', async () => {
  const { code, err } = await run('sync', '--adapter', 'trello', ...TOTERS_PASTE);
  assert.equal(code, 1);
  assert.match(err, /trello does not accept pasted --token\/--cookie/);
  assert.ok(!err.includes(KEYCHAIN_ALLOW_ADVICE), 'no extraction was started');
});

test('sync rejects an unknown --adapter before touching credentials', async () => {
  const { code, err } = await run('sync', '--adapter', 'notanapp', ...PASTED);
  assert.equal(code, 1);
  assert.match(err, /Unknown adapter "notanapp"/);
});

test('a literal --token warns that argv is visible; the env var does the same without it', async () => {
  const literal = await run('sync', '--workspace', 'no-such-team', ...PASTED);
  assert.match(literal.err, /visible to other local users/);

  const viaEnv = await runWith(
    { env: { SLUICE_TOKEN: 'xoxc-not-a-real-token', SLUICE_COOKIE: 'd=not-a-real-cookie' } },
    'sync',
    '--workspace',
    'no-such-team',
  );
  assert.equal(viaEnv.code, 1);
  assert.match(viaEnv.err, /Have: Slack \(paste-in\)$/m, 'the same session as the flags');
  assert.doesNotMatch(viaEnv.err, /visible to other local users/);
});

test('--token - reads the token from stdin', async () => {
  const r = await runWith(
    { stdin: 'xoxc-not-a-real-token\n', env: { SLUICE_COOKIE: 'd=not-a-real-cookie' } },
    'sync',
    '--workspace',
    'no-such-team',
    '--token',
    '-',
  );
  assert.equal(r.code, 1);
  assert.match(r.err, /Have: Slack \(paste-in\)$/m);
  assert.doesNotMatch(r.err, /visible to other local users/);
});

// ── --dry-run is a preview or it is refused ──────────────────────────────────

test('--dry-run is refused outside --all instead of sending a real request', async () => {
  const single = await run('replay', 'slack.users.list', '--dry-run', ...PASTED);
  assert.equal(single.code, 1);
  assert.match(single.err, /only to --all/);

  const flow = await run('replay', '--flow', 'any-template', '--dry-run');
  assert.equal(flow.code, 1);
  assert.match(flow.err, /only to --all/);
});

test('replay --all --dry-run also lists stranded claims the real run would release', async () => {
  const db = seededDb();
  const store = new SqliteStore(db);
  store.enqueueCursors([{ adapterId: 'slack', actionId: 'slack.conversations.history', containerId: 'C1', cursor: 'p2' }]);
  const [dead] = store.claimCursors(1); // a drainer that died holding it
  backdateClaim(store, dead!.id);
  store.close();

  const { code, out } = await run('replay', '--all', '--dry-run', '--db', db);
  assert.equal(code, 0);
  assert.match(out, /Would replay 1 item/);
  assert.match(out, /stranded claim/);
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

// ── record re-redacts every URL-like field ───────────────────────────────────

test('record masks secrets in path and tabUrl, not only url', async () => {
  // Rows stored before the ingest funnel redacted URL fields still hold raw
  // query strings, and a fixture is the artifact that leaves the machine.
  const dbPath = join(scratch(), 'sluice.db');
  const store = new SqliteStore(dbPath);
  store.insertCapture({
    id: 'cap_url',
    ts: 1_700_000_000_000,
    source: 'ext',
    adapterId: null,
    method: 'GET',
    url: 'https://api.example.test/v1/items',
    host: 'api.example.test',
    path: '/v1/items?token=not-a-real-0000',
    status: 200,
    durationMs: 5,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: '{}',
    tabUrl: 'https://app.example.test/cb?access_token=not-a-real-1111',
  });
  store.close();

  const { code, out } = await run('record', '--db', dbPath);
  assert.equal(code, 0);
  assert.ok(!out.includes('not-a-real-0000'), 'path is redacted');
  assert.ok(!out.includes('not-a-real-1111'), 'tabUrl is redacted');
  assert.match(out, /«redacted»/);
});

// ── deleting captures rebuilds the derived tables ────────────────────────────

function slackChannelRows(dbPath: string): number {
  const store = new SqliteStore(dbPath);
  try {
    const exists = store.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'slack_channel'")
      .get() as { n: number };
    if (exists.n === 0) return 0;
    return (store.db.prepare('SELECT COUNT(*) AS n FROM slack_channel').get() as { n: number }).n;
  } finally {
    store.close();
  }
}

test('prune drops the derived rows of the captures it deletes', async () => {
  // materialize only ever upserts, so a pruned capture's channel row used to
  // survive both the prune and every build-db after it.
  const dbPath = join(scratch(), 'sluice.db');
  const store = new SqliteStore(dbPath);
  store.insertCapture({
    id: 's1',
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/conversations.list',
    host: 'slack.com',
    path: '/api/conversations.list',
    status: 200,
    durationMs: 5,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'general' }] }),
  });
  store.close();

  const built = await run('build-db', '--db', dbPath);
  assert.equal(built.code, 0, built.err);
  assert.equal(slackChannelRows(dbPath), 1, 'precondition: the channel was materialized');

  const pruned = await run('prune', '--max-rows', '0', '--db', dbPath);
  assert.equal(pruned.code, 0, pruned.err);
  assert.match(pruned.out, /Rebuilt/);
  assert.equal(slackChannelRows(dbPath), 0, 'the pruned capture’s derived row is gone');

  const rebuilt = await run('build-db', '--db', dbPath);
  assert.equal(rebuilt.code, 0, rebuilt.err);
  assert.equal(slackChannelRows(dbPath), 0, 'and a later build-db does not bring it back');
});

test('auth --hints lists each credential once, most confident first, and never its value', async () => {
  const dbPath = join(scratch(), 'auth.db');
  const store = new SqliteStore(dbPath);
  const base: Capture = {
    id: '',
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: null,
    method: 'GET',
    url: 'https://api.example.test/v1/me',
    host: 'api.example.test',
    path: '/v1/me',
    status: 200,
    durationMs: 5,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: '{}',
  };
  const bearer = { authorization: 'Bearer not-a-real-token-0000' };
  store.insertCapture({ ...base, id: 'a1', reqHeaders: bearer });
  store.insertCapture({ ...base, id: 'a2', ts: base.ts + 1, reqHeaders: bearer });
  store.insertCapture({ ...base, id: 'a3', ts: base.ts + 2, reqHeaders: { cookie: 'sid=not-a-real-cookie-1111' } });
  store.close();

  const { code, out } = await run('auth', '--hints', '--json', '--db', dbPath);
  assert.equal(code, 0);
  const { hints } = JSON.parse(out) as { hints: CredentialHint[] };
  const keys = hints.map((h) => `${h.location}/${h.name}`);
  assert.equal(new Set(keys).size, keys.length, 'each location/name once');
  assert.equal(keys.filter((k) => k === 'header/authorization').length, 1);
  for (let i = 1; i < hints.length; i++) {
    assert.ok((hints[i - 1]?.confidence ?? 0) >= (hints[i]?.confidence ?? 0), 'most confident first');
  }
  assert.doesNotMatch(out, /not-a-real-token-0000|not-a-real-cookie-1111/, 'previews only, never a value');
});

// ── writing captured data into a Git worktree ────────────────────────────────

test('record and export warn when they write captured data to an unignored path in a Git worktree', async () => {
  const db = seededDb();
  // Real path: macOS temp dirs sit behind a /var → /private/var symlink, which
  // `git rev-parse --show-toplevel` resolves.
  const repo = realpathSync(scratch());
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
  mkdirSync(join(repo, 'ignored'));
  const outside = realpathSync(scratch());
  const WARN = /is inside the Git worktree .* and is not ignored/;

  const tracked = await run('record', '--db', db, '--out', join(repo, 'fixture.ndjson'));
  assert.equal(tracked.code, 0);
  assert.match(tracked.err, WARN);

  const ignored = await run('record', '--db', db, '--out', join(repo, 'ignored', 'fixture.ndjson'));
  assert.equal(ignored.code, 0);
  assert.doesNotMatch(ignored.err, WARN);

  const elsewhere = await run('record', '--db', db, '--out', join(outside, 'fixture.ndjson'));
  assert.equal(elsewhere.code, 0);
  assert.doesNotMatch(elsewhere.err, WARN);

  const exported = await run('export', 'C1', '--format', 'json', '--db', db, '--out', join(repo, 'c1.json'));
  assert.equal(exported.code, 0, exported.err);
  assert.match(exported.err, WARN);
  assert.ok(existsSync(join(repo, 'c1.json')), 'the warning never blocks the write');
});

test('record and text exports write owner-only files, tightening one that exists', { skip: process.platform === 'win32' }, async () => {
  // Full mail and message bodies: as private as the 0600 store they came from.
  const db = seededDb();
  const dir = scratch();
  const loose = (name: string): string => {
    const f = join(dir, name);
    writeFileSync(f, '');
    chmodSync(f, 0o644);
    return f;
  };
  for (const out of [join(dir, 'fresh.ndjson'), loose('old.ndjson')]) {
    assert.equal((await run('record', '--db', db, '--out', out)).code, 0);
    assert.equal(statSync(out).mode & 0o077, 0, `record --out ${out} is owner-only`);
  }
  for (const out of [join(dir, 'fresh.json'), loose('old.json')]) {
    assert.equal((await run('export', 'C1', '--db', db, '--out', out)).code, 0);
    assert.equal(statSync(out).mode & 0o077, 0, `export --out ${out} is owner-only`);
  }
});
