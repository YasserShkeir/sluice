// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Replay header sanitisation and redirect handling. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * `sendableHeaders` is the pure boundary, because its failure mode is a
 * whole-replay crash, not a bad header. `runReplay` is exercised only against
 * local http servers — never a real service.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { afterEach } from 'node:test';
import { replayBudget } from './replay-policy.js';
import { runReplay, sendableHeaders } from './replay.js';

afterEach(() => replayBudget.reset());

test('a header undici would reject is dropped, at the boundary every replay crosses', () => {
  // undici throws "Cannot convert argument to a ByteString" out of the ENTIRE
  // fetch on a code unit > 255 — so one odd header must not fail the replay.
  // makeFaithful guards learned headers; this guards the adapter's own base
  // request and every other caller.
  const out = sendableHeaders({
    'user-agent': 'Mozilla/5.0 Chrome/141',
    Cookie: 'SID=abc',
    'x-weird': 'valu…e', // an ellipsis (U+2026) — > 255
  });
  assert.equal(out['user-agent'], 'Mozilla/5.0 Chrome/141', 'clean headers pass');
  assert.equal(out.Cookie, 'SID=abc', 'auth survives');
  assert.equal(out['x-weird'], undefined, 'the non-latin1 value is dropped, not fatal');
});

test('everything latin1 passes through unchanged', () => {
  const headers = { a: 'b', 'content-type': 'application/json', 'x-1': 'ÿ (U+00FF, still one byte)' };
  assert.deepEqual(sendableHeaders(headers), headers);
});

test('an empty header set is fine', () => {
  assert.deepEqual(sendableHeaders({}), {});
});

test('HTTP/2 pseudo-headers are dropped (undici cannot set them)', () => {
  const out = sendableHeaders({
    ':method': 'GET',
    ':authority': 'www.linkedin.com',
    ':scheme': 'https',
    ':path': '/voyager/api/me',
    'user-agent': 'Mozilla/5.0',
    cookie: 'li_at=x',
  });
  assert.equal(out[':method'], undefined);
  assert.equal(out[':authority'], undefined);
  assert.equal(out[':scheme'], undefined);
  assert.equal(out[':path'], undefined);
  assert.equal(out['user-agent'], 'Mozilla/5.0');
  assert.equal(out.cookie, 'li_at=x');
});

/** A loopback server that records every request it gets. */
async function localServer(
  handle: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, hits };
}

const close = (s: Server): Promise<void> => new Promise((resolve) => s.close(() => resolve()));

test('a redirect to a denied operation is recorded, never followed', async () => {
  const a = await localServer((_req, res) => {
    res.writeHead(307, { location: '/api/chat.postMessage?token=fake-secret-1234' });
    res.end();
  });
  try {
    const capture = await runReplay({
      method: 'POST',
      url: `${a.origin}/api/conversations.history`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'channel=C1',
    }, { allowedHosts: ['127.0.0.1'] });
    assert.deepEqual(a.hits, ['POST /api/conversations.history'], 'exactly one request, to the checked URL');
    assert.equal(capture.status, 307);
    assert.equal(capture.path, '/api/conversations.history');
    assert.ok(capture.resHeaders.location?.includes('chat.postMessage'), 'the 3xx is what gets recorded');
    assert.ok(!JSON.stringify(capture).includes('fake-secret-1234'), 'Location is redacted like any header');
  } finally {
    await close(a.server);
  }
});

test('a cross-origin redirect never reaches the other origin', async () => {
  const b = await localServer((_req, res) => res.end('{}'));
  const a = await localServer((_req, res) => {
    res.writeHead(308, { location: `${b.origin}/collect` });
    res.end();
  });
  try {
    const capture = await runReplay({
      method: 'POST',
      url: `${a.origin}/api/users.info`,
      headers: { 'csrf-token': 'fake-csrf-1234' },
      body: 'user=U1',
    }, { allowedHosts: ['127.0.0.1'] });
    assert.equal(capture.status, 308);
    assert.equal(a.hits.length, 1);
    assert.deepEqual(b.hits, [], 'neither the body nor the credential header left for another origin');
  } finally {
    await close(a.server);
    await close(b.server);
  }
});
