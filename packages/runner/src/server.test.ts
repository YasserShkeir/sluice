// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runner server tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * These cover the loopback auth boundary — the property that stops any other
 * process or browser tab on the machine from reading your captured traffic.
 * It was completely untested, and a regression here is a data-disclosure bug
 * rather than a broken feature.
 *
 * A real server on an ephemeral port, not a mock: the guard lives in the HTTP
 * upgrade path and the header handling, which a mock would not exercise.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { SqliteStore, WS_PROTOCOL_VERSION } from '@sluice/core';
import type { AppCatalogEntry, Capture } from '@sluice/core';
import { apps } from '@sluice/apps';
import { startServer, type StartServerResult } from './server.js';

const PORT = 7899;
const ORIGIN = `http://127.0.0.1:${PORT}`;
/**
 * Comfortably more broadcast frames than `RESUME_RING` in server.ts, so seq 1 is
 * guaranteed to have aged out. Hard-coded rather than imported: the ring size is
 * an internal tuning decision, and a test that reads it would still pass if the
 * bound were quietly removed.
 */
const RING_OVERFLOW = 600;

let store: SqliteStore;
let server: StartServerResult;

function capture(over: Partial<Capture> = {}): Capture {
  return {
    id: 'c1',
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
    resBody: '{"ok":true}',
    ...over,
  };
}

before(async () => {
  store = new SqliteStore(':memory:');
  store.insertCapture(capture());
  server = await startServer({
    store,
    adapters: [],
    port: PORT,
    getSessions: () => [],
  });
});

after(async () => {
  await server.close();
  store.close();
});

// ── The auth boundary ────────────────────────────────────────────────────────

test('the API refuses a request with no token', async () => {
  const res = await fetch(`${ORIGIN}/api/status`, { headers: { Origin: ORIGIN } });
  assert.equal(res.status, 403);
});

test('the API refuses a wrong token', async () => {
  const res = await fetch(`${ORIGIN}/api/status?token=not-the-token`, { headers: { Origin: ORIGIN } });
  assert.equal(res.status, 403);
});

test('the API refuses a non-loopback Origin even with the right token', async () => {
  // This is the check that stops any other website you have open from reading
  // your capture store: a browser always sends Origin on a cross-site request.
  const res = await fetch(`${ORIGIN}/api/status?token=${server.token}`, {
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(res.status, 403);
});

test('the API accepts the right token over a query param and a bearer header', async () => {
  const viaQuery = await fetch(`${ORIGIN}/api/status?token=${server.token}`, {
    headers: { Origin: ORIGIN },
  });
  assert.equal(viaQuery.status, 200);

  const viaHeader = await fetch(`${ORIGIN}/api/status`, {
    headers: { Origin: ORIGIN, Authorization: `Bearer ${server.token}` },
  });
  assert.equal(viaHeader.status, 200);
});

test('the API is read-only', async () => {
  const res = await fetch(`${ORIGIN}/api/status?token=${server.token}`, {
    method: 'POST',
    headers: { Origin: ORIGIN },
  });
  assert.equal(res.status, 405);
});

// ── Table-name validation ────────────────────────────────────────────────────

test('only materialized per-app tables are reachable', async () => {
  // A table name cannot be a bound parameter, so it is interpolated after an
  // exact match against the live schema. `captures` is a real table but not an
  // app-prefixed one, and must not be readable through this route.
  for (const name of ['captures', 'sqlite_master', "x'; DROP TABLE captures; --"]) {
    const res = await fetch(
      `${ORIGIN}/api/tables/${encodeURIComponent(name)}?token=${server.token}`,
      { headers: { Origin: ORIGIN } },
    );
    assert.equal(res.status, 404, `${name} must not be readable`);
  }
  // And the store survived the attempt.
  assert.equal(store.countCaptures(), 1);
});

// ── Static serving ───────────────────────────────────────────────────────────

test('static serving refuses path traversal', async () => {
  // Encoded so it is not normalised away by fetch before it reaches the server.
  const res = await fetch(`${ORIGIN}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
  const body = await res.text();
  assert.ok(!body.includes('root:'), 'must never serve a file outside the dist root');
});

test('the served document does NOT contain the session token', async () => {
  // Regression guard for the disclosure fix: the document is served without auth
  // (only /api/* is gated), so any local process could `curl /` and read an
  // injected token. The token now rides in the URL fragment, which is never sent
  // to the server — so a fetch of the document must not contain it anywhere.
  const res = await fetch(`${ORIGIN}/`);
  const body = await res.text();
  assert.ok(!body.includes(server.token), 'the token must never appear in the served page');
  assert.ok(!body.includes('__SLUICE_TOKEN__'), 'the token global must be gone');
  // The non-secret bootstrap config is still injected so the client can connect.
  assert.match(body, /__SLUICE_PORT__/, 'the port is still injected (not secret)');
});

test('security headers are always present', async () => {
  const res = await fetch(`${ORIGIN}/`);
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

// ── The WebSocket gate ───────────────────────────────────────────────────────

/**
 * Drive a raw upgrade handshake and return the status line.
 * `fetch` cannot do this — Connection/Upgrade are forbidden header names — so the
 * gate has to be exercised over a plain socket.
 */
async function rawUpgrade(path: string, origin: string | null, upPort: number = PORT): Promise<string> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const sock = connect({ port: upPort, host: '127.0.0.1' }, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${upPort}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n` +
          (origin ? `Origin: ${origin}\r\n` : '') +
          `\r\n`,
      );
    });
    let buf = '';
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error('upgrade timed out'));
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\r\n')) {
        sock.destroy();
        resolve(buf.split('\r\n')[0] ?? '');
      }
    });
    sock.on('error', reject);
  });
}

test('the WS upgrade refuses a missing or wrong token', async () => {
  assert.match(await rawUpgrade('/ws', ORIGIN), /403/, 'no token must be refused');
  assert.match(await rawUpgrade('/ws?token=nope', ORIGIN), /403/, 'a wrong token must be refused');
});

test('the WS upgrade refuses a cross-site Origin even with the right token', async () => {
  const line = await rawUpgrade(`/ws?token=${server.token}`, 'https://evil.example.com');
  assert.match(line, /403/);
});

test('the WS upgrade accepts the right token from loopback', async () => {
  const line = await rawUpgrade(`/ws?token=${server.token}`, ORIGIN);
  assert.match(line, /101/, 'a correct handshake must switch protocols');
});

// ── The /pty terminal channel ──────────────────────────────────────────────────

test('/pty is refused entirely when the terminal is disabled', async () => {
  // The shared `server` was started without --terminal, so there is no /pty at all
  // and no pty token — the read token must not open a shell either.
  assert.equal(server.ptyToken, '', 'no pty token is minted without --terminal');
  assert.match(await rawUpgrade('/pty', ORIGIN), /403/);
  assert.match(await rawUpgrade(`/pty?token=${server.token}`, ORIGIN), /403/);
});

test('/pty enforces the separate secret and a present loopback Origin', async () => {
  const PTY_PORT = PORT + 3;
  const store2 = new SqliteStore(':memory:');
  // A structural terminal hook — no node-pty, so the auth gate is what is tested.
  const term = {
    describe: () => 'fake',
    spawn: () => ({
      write() {},
      resize() {},
      onData() {},
      onExit() {},
      kill() {},
    }),
  };
  const s2 = await startServer({
    store: store2,
    adapters: [],
    port: PTY_PORT,
    getSessions: () => [],
    terminal: term,
  });
  const O2 = `http://127.0.0.1:${PTY_PORT}`;
  try {
    assert.notEqual(s2.ptyToken, '', 'a pty token is minted when the terminal is on');
    assert.notEqual(s2.ptyToken, s2.token, 'the pty token is distinct from the read token');
    // The READ token cannot open /pty — it is a different capability.
    assert.match(await rawUpgrade(`/pty?token=${s2.token}`, O2, PTY_PORT), /403/);
    // Wrong pty token is refused.
    assert.match(await rawUpgrade('/pty?token=nope', O2, PTY_PORT), /403/);
    // A MISSING Origin fails closed here (stricter than /ws, which tolerates it).
    assert.match(await rawUpgrade(`/pty?token=${s2.ptyToken}`, null, PTY_PORT), /403/);
    // A cross-site Origin is refused even with the right pty token.
    assert.match(
      await rawUpgrade(`/pty?token=${s2.ptyToken}`, 'https://evil.example.com', PTY_PORT),
      /403/,
    );
    // The correct pty token from a loopback Origin switches protocols.
    assert.match(await rawUpgrade(`/pty?token=${s2.ptyToken}`, O2, PTY_PORT), /101/);
  } finally {
    await s2.close();
    store2.close();
  }
});

// ── The /api/ingest endpoint (Engine C) ────────────────────────────────────────

test('/api/ingest is 404 when the runner was not started with --ingest', async () => {
  const res = await fetch(`${ORIGIN}/api/ingest`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ captures: [] }),
  });
  assert.equal(res.status, 404);
});

test('/api/ingest enforces its own secret and stores through the redacting funnel', async () => {
  const INGEST_PORT = PORT + 4;
  const store2 = new SqliteStore(':memory:');
  const s2 = await startServer({ store: store2, adapters: [], port: INGEST_PORT, getSessions: () => [], ingest: true });
  const O2 = `http://127.0.0.1:${INGEST_PORT}`;
  const post = (headers: Record<string, string>, body: unknown) =>
    fetch(`${O2}/api/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    assert.notEqual(s2.ingestToken, '', 'an ingest token is minted with --ingest');
    assert.notEqual(s2.ingestToken, s2.token, 'the ingest token is distinct from the read token');

    // No token, wrong token, and the READ token are all refused.
    assert.equal((await post({}, { captures: [] })).status, 403);
    assert.equal((await post({ Authorization: 'Bearer nope' }, { captures: [] })).status, 403);
    assert.equal((await post({ Authorization: `Bearer ${s2.token}` }, { captures: [] })).status, 403);

    // GET is not allowed even with the ingest token — only POST.
    assert.equal((await fetch(`${O2}/api/ingest?token=x`, { headers: { Origin: O2 } })).status, 405);

    // A real batch with the ingest token: stored, and the belt-and-braces
    // redaction runs on the way in (an ext-supplied auth header is scrubbed).
    const ok = await post(
      { Authorization: `Bearer ${s2.ingestToken}` },
      {
        captures: [
          {
            method: 'GET',
            url: 'https://api.example.com/v1/thing?x=1',
            status: 200,
            reqHeaders: { authorization: 'Bearer super-secret-ext-value' },
            resBody: '{"ok":true}',
          },
        ],
      },
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ingested: 1 });
    const stored = store2.listCaptures().find((c) => c.host === 'api.example.com');
    assert.ok(stored, 'the ingested capture is in the store');
    assert.equal(stored?.source, 'ext');
    assert.equal(stored?.path, '/v1/thing?x=1', 'host/path derived from the URL when omitted');
    assert.ok(
      !JSON.stringify(stored?.reqHeaders).includes('super-secret-ext-value'),
      'ext-supplied secrets are redacted by the same funnel the proxy uses',
    );
  } finally {
    await s2.close();
    store2.close();
  }
});

// ── Ingest ───────────────────────────────────────────────────────────────────

test('ingest stores a capture and re-redacts on the way in', async () => {
  server.ingest(
    capture({ id: 'c2', reqHeaders: { authorization: 'Bearer super-secret-value' } }),
  );
  const stored = store.listCaptures().find((c) => c.id === 'c2');
  assert.ok(stored);
  assert.ok(
    !JSON.stringify(stored.reqHeaders).includes('super-secret-value'),
    'the belt-and-braces redaction pass must run even if an engine already redacted',
  );
});

// ── Server-side pause ────────────────────────────────────────────────────────

type Frame = Record<string, unknown>;

interface Subscribed {
  ws: import('ws').WebSocket;
  frames: Frame[];
  close: () => void;
}

/**
 * Open a subscribed socket and collect every frame it is sent.
 *
 * `subscribe` is merged into the subscribe message so a test can ask for a
 * resume (`sinceSeq`) or a scoped stream (`filter`); `port`/`token` let a test
 * drive a server other than the shared one.
 */
async function subscribed(
  opts: { port?: number; token?: string; subscribe?: Frame } = {},
): Promise<Subscribed> {
  const port = opts.port ?? PORT;
  const token = opts.token ?? server.token;
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`, {
    origin: `http://127.0.0.1:${port}`,
  });
  const frames: Frame[] = [];
  ws.on('message', (d) => {
    try {
      frames.push(JSON.parse(String(d)) as Frame);
    } catch {
      /* not our frame */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'subscribe', ...opts.subscribe }));
  await new Promise((r) => setTimeout(r, 250));
  return { ws, frames, close: () => ws.close() };
}

/** The capture ids a connection was streamed live (not backfilled). */
function streamedIds(s: Subscribed): string[] {
  return s.frames
    .filter((f) => f.type === 'capture.new')
    .map((f) => (f.capture as Capture).id);
}

/** Every capture handed over as priming, across all backfill chunks. */
function backfilled(s: Subscribed): Capture[] {
  return s.frames
    .filter((f) => f.type === 'capture.backfill')
    .flatMap((f) => f.captures as Capture[]);
}

/** The highest `seq` a connection has seen — what a client would send to resume. */
function highestSeq(s: Subscribed): number {
  return s.frames.reduce((n, f) => (typeof f.seq === 'number' && f.seq > n ? f.seq : n), 0);
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

test('pausing stops the ENGINE writing, not just the UI rendering', async () => {
  // The bug this pins: pause used to be client-side only, so the proxy kept
  // writing every request to disk while the button read "paused". On a capture
  // tool that is a privacy failure — you pause precisely when you are about to
  // do something you would rather not record.
  const s = await subscribed();
  try {
    s.ws.send(JSON.stringify({ type: 'capture.control', action: 'pause' }));
    await settle();

    server.ingest(capture({ id: 'while-paused' }));
    await settle();
    assert.equal(
      store.listCaptures().find((c) => c.id === 'while-paused'),
      undefined,
      'a capture ingested while paused must never reach SQLite',
    );

    s.ws.send(JSON.stringify({ type: 'capture.control', action: 'resume' }));
    await settle();
    server.ingest(capture({ id: 'after-resume' }));
    await settle();
    assert.ok(store.listCaptures().find((c) => c.id === 'after-resume'), 'resume must restore writing');
  } finally {
    s.close();
  }
});

test('the pause state is broadcast, so two dashboards cannot disagree', async () => {
  const a = await subscribed();
  const b = await subscribed();
  try {
    b.frames.length = 0;
    a.ws.send(JSON.stringify({ type: 'capture.control', action: 'pause' }));
    await settle();

    const seen = b.frames.filter((f) => f.type === 'capture.state');
    assert.ok(seen.length > 0, 'the OTHER client must be told');
    assert.equal(seen.at(-1)?.paused, true);

    a.ws.send(JSON.stringify({ type: 'capture.control', action: 'resume' }));
    await settle();
  } finally {
    a.close();
    b.close();
  }
});

test('a client that connects while paused is told so at subscribe time', async () => {
  const a = await subscribed();
  a.ws.send(JSON.stringify({ type: 'capture.control', action: 'pause' }));
  await settle();

  const late = await subscribed();
  try {
    const state = late.frames.filter((f) => f.type === 'capture.state').at(-1);
    assert.equal(state?.paused, true, 'otherwise it renders "recording" over a paused runner');
  } finally {
    a.ws.send(JSON.stringify({ type: 'capture.control', action: 'resume' }));
    await settle();
    a.close();
    late.close();
  }
});

test('pause silences live capture but NOT replay or sync', async () => {
  // Replay and sync are things the user explicitly asked for while paused, which
  // is why the gate sits on the exported `ingest` rather than inside
  // ingestCapture — the latter would mute all three.
  const s = await subscribed();
  try {
    s.ws.send(JSON.stringify({ type: 'capture.control', action: 'pause' }));
    await settle();
    s.ws.send(JSON.stringify({ type: 'sync' }));
    await settle();
    const notices = s.frames.filter((f) => f.type === 'notice');
    assert.ok(notices.length > 0, 'sync must still respond while capture is paused');
  } finally {
    s.ws.send(JSON.stringify({ type: 'capture.control', action: 'resume' }));
    await settle();
    s.close();
  }
});

// ── The app catalog inventory ────────────────────────────────────────────────

test('the catalog carries each app’s hosts, MCP tools and replay actions', async () => {
  // `build.mcp` is a boolean and stays one — it drives a checklist tick. It
  // cannot answer "what did Sluice collect for this app, and what can I do with
  // it?", which is the whole of the per-app page, so the inventory rides along.
  //
  // Driven against the REAL installed apps, because the trap this pins is a
  // lifecycle one: `inputSchema` is still a zod raw shape at catalog time, and
  // only becomes a ZodObject once the MCP SDK registers the tool.
  const store2 = new SqliteStore(':memory:');
  const srv = await startServer({
    store: store2,
    adapters: apps,
    port: PORT + 1,
    getSessions: () => [],
  });
  const c = await subscribed({ port: PORT + 1, token: srv.token });
  try {
    const catalog = c.frames.find((f) => f.type === 'apps')?.apps as AppCatalogEntry[] | undefined;
    assert.ok(catalog, 'a subscriber must be sent the catalog');

    for (const app of apps) {
      const entry: AppCatalogEntry | undefined = catalog.find((e) => e.id === app.id);
      assert.ok(entry, `${app.id} must appear in the catalog`);
      assert.deepEqual(entry.hosts, app.hosts, `${app.id}: hosts are what the proxy decrypts`);

      const actions = app.listReplayActions();
      assert.deepEqual(
        entry.replayActions.map((r) => ({ id: r.id, method: r.method, params: r.params.length })),
        actions.map((r) => ({ id: r.id, method: r.method, params: r.params.length })),
      );

      const tools = app.mcpTools?.() ?? [];
      assert.deepEqual(entry.mcpTools.map((t) => t.name), tools.map((t) => t.name));
      for (const t of tools) {
        assert.deepEqual(
          entry.mcpTools.find((x) => x.name === t.name)?.params,
          Object.keys(t.inputSchema ?? {}),
          `${t.name}: params come from the raw shape's keys, not a ZodObject's members`,
        );
      }
    }

    // Preconditions — without them the loop above passes over empty arrays.
    assert.ok(catalog.some((e) => e.mcpTools.length > 0), 'some app must contribute MCP tools');
    assert.ok(
      catalog.some((e) => e.replayActions.some((r) => r.params.length > 0)),
      'some replay action must take parameters',
    );
    assert.ok(
      catalog.some((e) => e.replayActions.some((r) => r.params.some((p) => p.required))),
      'a required param must survive into the catalog — the form has to know',
    );
    // A planned app has no adapter, so it claims no hosts and offers nothing.
    const planned = catalog.find((e) => !e.build.adapter);
    assert.deepEqual(planned?.hosts, []);
    assert.deepEqual(planned?.mcpTools, []);
    assert.deepEqual(planned?.replayActions, []);
  } finally {
    c.close();
    await srv.close();
    store2.close();
  }
});

// ── Version handshake ────────────────────────────────────────────────────────

test('a protocol version mismatch is surfaced as a notice, and a match is silent', async () => {
  // WS_PROTOCOL_VERSION used to travel one way and be compared by neither end,
  // so a rebuilt runner against a cached page presented as an empty panel rather
  // than as a version skew.
  const s = await subscribed();
  try {
    s.frames.length = 0;
    s.ws.send(JSON.stringify({ type: 'hello.ok', protocolVersion: WS_PROTOCOL_VERSION + 1 }));
    await settle();
    const notice = s.frames.find(
      (f) => f.type === 'notice' && String(f.text).includes('Protocol mismatch'),
    );
    assert.ok(notice, 'a version skew must name itself');
    assert.equal(notice.level, 'error');

    s.frames.length = 0;
    s.ws.send(JSON.stringify({ type: 'hello.ok', protocolVersion: WS_PROTOCOL_VERSION }));
    await settle();
    assert.equal(
      s.frames.filter((f) => f.type === 'notice').length,
      0,
      'a matching version must not toast on every connect',
    );
  } finally {
    s.close();
  }
});

// ── seq, resume and subscribe-time filters ───────────────────────────────────

test('every broadcast frame carries a monotonically increasing seq', async () => {
  const s = await subscribed();
  try {
    s.frames.length = 0;
    server.ingest(capture({ id: 'seq-a' }));
    await settle();
    server.ingest(capture({ id: 'seq-b' }));
    await settle();
    const seqs = s.frames
      .filter((f) => f.type === 'capture.new')
      .map((f) => (typeof f.seq === 'number' ? f.seq : -1));
    assert.equal(seqs.length, 2);
    assert.ok(seqs.every((n) => n > 0), 'every broadcast frame must be stamped');
    assert.ok(seqs[1]! > seqs[0]!, 'without ordering there is nothing to resume from');
  } finally {
    s.close();
  }
});

test('a subscribe filter keeps another app’s captures off that connection', async () => {
  const scoped = await subscribed({ subscribe: { filter: { adapterId: 'trello' } } });
  const everything = await subscribed();
  try {
    scoped.frames.length = 0;
    everything.frames.length = 0;
    server.ingest(capture({ id: 'filter-trello', adapterId: 'trello' }));
    server.ingest(capture({ id: 'filter-slack', adapterId: 'slack' }));
    await settle();
    assert.deepEqual(streamedIds(scoped), ['filter-trello']);
    assert.deepEqual(
      streamedIds(everything),
      ['filter-trello', 'filter-slack'],
      'an unfiltered client must still get everything off the same broadcast',
    );
  } finally {
    scoped.close();
    everything.close();
  }
});

test('a filtered subscribe is primed with that app only, not the whole store', async () => {
  // The filter has to reach the backfill too. Applying it only to live frames
  // would ship the 2000-row prime the filter exists to avoid.
  server.ingest(capture({ id: 'prime-trello', adapterId: 'trello' }));
  await settle();
  const scoped = await subscribed({ subscribe: { filter: { adapterId: 'trello' } } });
  try {
    const rows = backfilled(scoped);
    assert.ok(rows.length > 0, 'precondition: the store holds a trello capture');
    assert.ok(rows.every((c) => c.adapterId === 'trello'), 'only the scoped app may be primed');
  } finally {
    scoped.close();
  }
});

test('a reconnect with sinceSeq resumes instead of re-backfilling every capture', async () => {
  const first = await subscribed();
  server.ingest(capture({ id: 'resume-seen' }));
  await settle();
  const lastSeq = highestSeq(first);
  assert.ok(lastSeq > 0, 'precondition: the client saw a numbered frame');
  first.close();

  server.ingest(capture({ id: 'resume-missed' }));
  await settle();

  const again = await subscribed({ subscribe: { sinceSeq: lastSeq } });
  try {
    const modes = again.frames.filter((f) => f.type === 'capture.backfill').map((f) => f.mode);
    assert.deepEqual(modes, ['resume'], 'a resume must say so, and must not re-prime');
    assert.deepEqual(backfilled(again), []);
    assert.ok(
      streamedIds(again).includes('resume-missed'),
      'the frames it missed while disconnected must be replayed',
    );
    assert.ok(
      !streamedIds(again).includes('resume-seen'),
      'a capture it already holds must not be sent twice',
    );
  } finally {
    again.close();
  }
});

test('a sinceSeq older than the ring falls back to a full backfill and says so', async () => {
  // A silent partial resume is a correctness bug: the client folds a handful of
  // deltas into a buffer that is missing everything before them, and nothing in
  // the frames tells it to start over.
  for (let i = 0; i < RING_OVERFLOW; i++) server.ingest(capture({ id: `ring-${i}` }));
  await settle();

  const late = await subscribed({ subscribe: { sinceSeq: 1 } });
  try {
    const chunks = late.frames.filter((f) => f.type === 'capture.backfill');
    assert.ok(chunks.length > 0, 'the client must be primed');
    assert.ok(
      chunks.every((f) => f.mode === 'full'),
      'it asked to resume and could not — that has to be stated, not implied',
    );
    assert.ok(
      backfilled(late).length > RING_OVERFLOW,
      'a full backfill really does re-send the store',
    );
  } finally {
    late.close();
  }
});

test('a sinceSeq this runner never issued is not resumed from', async () => {
  const late = await subscribed({ subscribe: { sinceSeq: 9_999_999 } });
  try {
    const chunks = late.frames.filter((f) => f.type === 'capture.backfill');
    assert.ok(chunks.length > 0);
    assert.ok(chunks.every((f) => f.mode === 'full'));
  } finally {
    late.close();
  }
});

test('a malformed subscribe is refused out loud, not quietly widened', async () => {
  // This used to degrade to "no filter" — which hands a client that asked to
  // watch ONE app every capture on the machine, while it renders them under the
  // heading it thinks it asked for. Being told is the only useful outcome: the
  // connection stays up, nothing is streamed against a filter nobody agreed on,
  // and the notice names the field so the skew is diagnosable from the UI.
  const s = await subscribed({
    subscribe: { sinceSeq: 'yesterday', filter: { adapterId: 7, tabId: null } },
  });
  try {
    const notices = s.frames.filter((f) => f.type === 'notice' && f.level === 'error');
    assert.ok(notices.length > 0, 'the client is told');
    assert.match(String(notices[0]?.text), /sinceSeq/, 'and told which field');
    assert.equal(
      s.frames.filter((f) => f.type === 'capture.backfill').length,
      0,
      'and is not served a stream it did not ask for',
    );
    // Still up: a bad frame must not be a disconnect, or a client with one stale
    // field can never recover by sending a good one.
    assert.equal(s.ws.readyState, s.ws.OPEN);
  } finally {
    s.close();
  }
});
