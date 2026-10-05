// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The shared Capture builders every engine and replay go through. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * redactedCapture is the one redaction point for engine output, so the masking
 * assertions here are what stop a new engine field from leaking.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Adapter, RequestMatchInput } from '@sluice/core';
import { MAX_CAPTURE_BODY, capBody, redactedCapture, wsFrameCapture } from './capture-build.js';
import type { RawCapture } from './capture-build.js';

const SECRET = 'fake-secret-1234';

function stub(id: string, match: (i: RequestMatchInput) => boolean): Adapter {
  return { id, matchRequest: match } as unknown as Adapter;
}

function raw(over: Partial<RawCapture> = {}): RawCapture {
  return {
    ts: 1,
    source: 'cdp',
    adapterId: null,
    method: 'POST',
    url: 'https://app.example.com/api/x',
    host: 'app.example.com',
    path: '/api/x',
    status: 200,
    durationMs: 3,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody: null,
    ...over,
  };
}

test('redactedCapture masks headers, url, bodies and tabUrl', () => {
  const c = redactedCapture(
    raw({
      url: `https://app.example.com/api/x?token=${SECRET}`,
      reqHeaders: { authorization: `Bearer ${SECRET}` },
      reqBody: JSON.stringify({ password: SECRET }),
      resBody: JSON.stringify({ access_token: SECRET }),
      tabId: 't1',
      tabUrl: `https://app.example.com/cb#access_token=${SECRET}`,
    }),
  );
  assert.ok(!JSON.stringify(c).includes(SECRET), JSON.stringify(c));
  assert.equal(c.tabId, 't1');
  assert.ok(c.tabUrl?.startsWith('https://app.example.com/cb'));
});

test('redactedCapture fills id/pid/processName and keeps null bodies null', () => {
  const c = redactedCapture(raw());
  assert.match(c.id, /^cap_/);
  assert.equal(c.pid, null);
  assert.equal(c.processName, null);
  assert.equal(c.reqBody, null);
  assert.equal(c.resBody, null);
  assert.ok(!('tabUrl' in c), 'no tab fields appear on a capture that had none');
});

test('capBody leaves the cap intact and marks what it cut', () => {
  const exact = 'x'.repeat(MAX_CAPTURE_BODY);
  assert.equal(capBody(exact), exact);
  const over = capBody(`${exact}y`);
  assert.ok(over.endsWith('…[truncated 1 chars]'));
  assert.equal(over.length, MAX_CAPTURE_BODY + '…[truncated 1 chars]'.length);
});

test('wsFrameCapture puts a sent frame in reqBody and a received one in resBody', () => {
  const adapters = [stub('slack', (i) => i.host === 'wss-primary.slack.com' && i.method === 'WS')];
  const url = 'wss://wss-primary.slack.com/?v=1';
  const sent = wsFrameCapture({ adapters, url, wsId: 'w1', direction: 'sent', text: '{"type":"ping"}' });
  assert.equal(sent.reqBody, '{"type":"ping"}');
  assert.equal(sent.resBody, null);
  assert.equal(sent.method, 'WS');
  assert.equal(sent.source, 'ws');
  assert.equal(sent.status, null);
  assert.equal(sent.adapterId, 'slack');
  assert.equal(sent.wsId, 'w1');

  const received = wsFrameCapture({ adapters, url, wsId: 'w1', direction: 'received', text: `{"token":"${SECRET}"}` });
  assert.equal(received.reqBody, null);
  assert.ok(received.resBody && !received.resBody.includes(SECRET), 'frame payloads are redacted');
});

test('wsFrameCapture on an unknown socket url is attributed to host "unknown"', () => {
  const c = wsFrameCapture({ adapters: [], url: '', wsId: 'w2', direction: 'received', text: 'hi' });
  assert.equal(c.host, 'unknown');
  assert.equal(c.adapterId, null);
});
