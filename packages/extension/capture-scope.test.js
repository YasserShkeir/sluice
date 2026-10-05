// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The bridge's trust boundary: a page can post anything shaped like a capture,
 * so content.js must pass only the fields inject.js emits, and background.js
 * must scope on the frame the BROWSER reports, not on the page-supplied URL.
 * Run with:  node --test capture-scope.test.js   (from this package)
 *
 * Both scripts register listeners on import, so `chrome`, `window` and `fetch`
 * are stubbed first and the listeners captured.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const EXT_ID = 'synthetic-extension-id';
const sent = [];
const posted = [];
let onRuntimeMessage;
let onWindowMessage;

globalThis.window = {
  addEventListener: (type, fn) => {
    if (type === 'message') onWindowMessage = fn;
  },
};
globalThis.chrome = {
  runtime: {
    id: EXT_ID,
    sendMessage: (m) => sent.push(m),
    onMessage: { addListener: (fn) => (onRuntimeMessage = fn) },
  },
  storage: {
    local: {
      get: async () => ({
        endpoint: 'http://127.0.0.1:7788',
        token: 'synthetic-ingest-token',
        hosts: 'slack.example',
        enabled: true,
      }),
    },
  },
};
globalThis.fetch = async (_url, init) => {
  posted.push(...JSON.parse(init.body).captures);
  return { ok: true };
};

mock.timers.enable({ apis: ['setTimeout'] });
await import('./content.js');
await import('./background.js');

const settle = () => new Promise((r) => setImmediate(r));

/** Deliver one runtime message as `sender`, then run the batch flush. */
async function deliver(entry, sender) {
  posted.length = 0;
  onRuntimeMessage({ type: 'sluice-capture', entry }, sender);
  await settle();
  mock.timers.tick(2000);
  await settle();
  await settle();
  return posted.slice();
}

const IN_SCOPE_TAB = { id: 7, url: 'https://app.slack.example/client' };
const entry = { method: 'GET', url: 'https://slack.example/api/conversations.history', resBody: '{}' };

test('content.js forwards only the fields inject.js emits', () => {
  sent.length = 0;
  onWindowMessage({
    source: globalThis.window,
    data: {
      __sluice: 'sluice-capture',
      entry: {
        ...entry,
        id: 'cap_victim',
        host: 'slack.example',
        path: '/api/other',
        tabUrl: 'https://slack.example/',
        tabId: '1',
        adapterId: 'slack',
        status: 200,
        ts: 5,
        reqHeaders: { accept: 'json', bogus: 1 },
        resHeaders: ['not', 'a', 'map'],
        reqBody: { not: 'a string' },
      },
    },
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].entry, {
    method: 'GET',
    url: entry.url,
    status: 200,
    durationMs: null,
    reqHeaders: { accept: 'json' },
    resHeaders: {},
    reqBody: null,
    resBody: '{}',
    ts: 5,
  });
});

test('content.js drops a message without a string method and url', () => {
  sent.length = 0;
  onWindowMessage({ source: globalThis.window, data: { __sluice: 'sluice-capture', entry: { url: entry.url } } });
  onWindowMessage({ source: globalThis.window, data: { __sluice: 'sluice-capture', entry: { method: 'GET', url: 1 } } });
  assert.equal(sent.length, 0);
});

test('an in-scope page reporting an in-scope request is forwarded', async () => {
  const out = await deliver(entry, { id: EXT_ID, tab: IN_SCOPE_TAB, origin: 'https://app.slack.example' });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, entry.url);
});

test('an out-of-scope page claiming an in-scope URL is dropped', async () => {
  // The forgery: any site can postMessage a capture whose url names Slack.
  const out = await deliver(entry, {
    id: EXT_ID,
    tab: { id: 8, url: 'https://evil.example/' },
    origin: 'https://evil.example',
  });
  assert.deepEqual(out, []);
});

test('an out-of-scope iframe inside an in-scope tab is dropped', async () => {
  // The tab's URL is the top frame's; the sender's origin is the ad frame's own.
  const out = await deliver(entry, { id: EXT_ID, tab: IN_SCOPE_TAB, origin: 'https://ads.example' });
  assert.deepEqual(out, []);
});

test('the frame URL is used when the browser reports no origin', async () => {
  assert.equal((await deliver(entry, { id: EXT_ID, tab: IN_SCOPE_TAB, url: 'https://app.slack.example/x' })).length, 1);
  assert.deepEqual(await deliver(entry, { id: EXT_ID, tab: IN_SCOPE_TAB, url: 'https://evil.example/x' }), []);
});

test('a missing or opaque frame origin fails closed', async () => {
  assert.deepEqual(await deliver(entry, { id: EXT_ID, tab: IN_SCOPE_TAB }), []);
  assert.deepEqual(await deliver(entry, { id: EXT_ID, tab: IN_SCOPE_TAB, origin: 'null' }), []);
});

test('an in-scope page reporting an out-of-scope request is dropped', async () => {
  const out = await deliver(
    { ...entry, url: 'https://bank.example/api/balance' },
    { id: EXT_ID, tab: IN_SCOPE_TAB, origin: 'https://app.slack.example' },
  );
  assert.deepEqual(out, []);
});

test('a message not from this extension, or not from a tab, is dropped', async () => {
  const origin = 'https://app.slack.example';
  assert.deepEqual(await deliver(entry, { id: 'someone-else', tab: IN_SCOPE_TAB, origin }), []);
  assert.deepEqual(await deliver(entry, { id: EXT_ID, origin }), []);
});
