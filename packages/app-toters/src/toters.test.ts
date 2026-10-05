// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * app-toters tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The fixtures copy REAL captured shapes — the `{ errors, data }` envelope, the
 * Laravel paginator on `/api/home/stores`, `ref` as the display name, the
 * numeric store ids — because the point of most of these is that the adapter
 * agrees with what the iOS app actually sends, not with what would be
 * convenient to parse. Every VALUE (ids, names, tokens) is synthetic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, makeJsonCapture, runConformance } from '@sluice/adapter-sdk';
import { redactText, registerAppRedaction } from '@sluice/core';
import type { AppToolContext, Capture, Session } from '@sluice/core';
import {
  buildTotersReplayRequest,
  classifyTotersCapture,
  parseTotersCapture,
  totersApp,
  totersNextCursors,
  totersOperation,
} from './index.js';

const API = 'api.toters-api.com';

function json(path: string, body: unknown, over: Partial<Capture> = {}): Capture {
  return makeJsonCapture(API, path, body, { method: 'GET', status: 200, ...over });
}

// ── Matching ─────────────────────────────────────────────────────────────────

test('matchRequest claims the Toters domains and rejects lookalikes', () => {
  const hit = (host: string) => totersApp.matchRequest({ host, path: '/api/x', method: 'GET', url: '' });
  for (const h of [
    'toters-api.com',
    'api.toters-api.com',
    'search-service.prod.toters-api.com',
    'images.totersapp.com',
    'ably.prod.totersapi.com',
  ]) {
    assert.ok(hit(h), `${h} should match`);
  }
  // The leading dot in the suffix test is what makes these fail.
  for (const h of ['nottoters-api.com', 'toters-api.com.evil.test', 'slack.com', 'totersapp.com.attacker.io']) {
    assert.ok(!hit(h), `${h} must not match`);
  }
});

// ── Classification ───────────────────────────────────────────────────────────

test('an HTTP 200 carrying { errors: true } classifies as error, not structure', () => {
  // This is the Slack `{ ok: false }` problem: the status code says success.
  const c = json('/api/user-info', { errors: true, data: { message: 'unauthenticated' } });
  assert.equal(classifyTotersCapture(c).class, 'error');
  // …and the parser must therefore find nothing in it.
  assert.deepEqual(parseTotersCapture(c), {});
});

test('classification names operations without leaking ids into the name', () => {
  assert.equal(totersOperation(json('/api/stores/10001/items/popular', {})), 'stores.{id}.items.popular');
  assert.equal(totersOperation(json('/api/user-info', {})), 'user-info');
  const img = makeCapture({ method: 'GET', url: 'https://images.toters-api.com/a/b.jpeg', host: 'images.toters-api.com', path: '/a/b.jpeg' });
  assert.equal(classifyTotersCapture(img).class, 'asset');
});

test('a 4xx and an auth call are classified before any body parsing', () => {
  assert.equal(classifyTotersCapture(json('/api/user-info', {}, { status: 401 })).class, 'error');
  assert.equal(classifyTotersCapture(json('/api/auth/refresh', { errors: false, data: {} }, { method: 'POST' })).class, 'auth');
});

// ── Parsing ──────────────────────────────────────────────────────────────────

test('user-info yields the signed-in actor and names the workspace', () => {
  const r = parseTotersCapture(
    json('/api/user-info', {
      errors: false,
      data: { user: { id: 100001, first_name: 'Test', last_name: 'User', email: 'user@example.test' } },
    }),
  );
  assert.equal(r.workspaces?.[0]?.name, 'Toters — Test User');
  assert.equal(r.actors?.[0]?.id, '100001');
  assert.equal(r.actors?.[0]?.displayName, 'Test User');
});

test('the store list parses through the Laravel paginator and uses `ref` as the name', () => {
  const r = parseTotersCapture(
    json('/api/home/stores', {
      errors: false,
      data: {
        stores: {
          current_page: 1,
          last_page: 28,
          data: [
            { id: 10001, ref: 'Example Grocer - Test Street', type: 'Grocery', is_open: true },
            { id: 10002, ref: 'Second Store', type: 'Restaurant' },
          ],
        },
      },
    }),
  );
  assert.equal(r.containers?.length, 2);
  assert.equal(r.containers?.[0]?.id, 'store:10001');
  // `ref`, not `name` — Toters has no `name` field on a store.
  assert.equal(r.containers?.[0]?.name, 'Example Grocer - Test Street');
  assert.equal(r.containers?.[0]?.kind, 'other');
});

test('items are attributed to the store in the request path, which the records omit', () => {
  const r = parseTotersCapture(
    json('/api/stores/10001/items/popular', {
      errors: false,
      data: { popular: [{ id: 20001, ref: 'Example Combo' }, { id: 20002, ref: 'Other' }] },
    }),
  );
  assert.equal(r.items?.length, 2);
  assert.equal(r.items?.[0]?.id, 'item:20001');
  assert.equal(r.items?.[0]?.text, 'Example Combo');
  // The item record carries no store_id; only the path does.
  assert.equal(r.items?.[0]?.containerId, 'store:10001');
});

test('parse never throws on hostile or wrong-typed bodies', () => {
  const hostile: unknown[] = [
    { errors: false, data: { stores: { data: { nope: 'an object where an array belongs' } } } },
    { errors: false, data: { user: 'a string' } },
    { errors: false, data: null },
    { errors: false },
    null,
    42,
    [1, 2, 3],
    { errors: false, data: { addresses: [null, 7, { noId: true }] } },
  ];
  for (const body of hostile) {
    assert.doesNotThrow(() => parseTotersCapture(json('/api/home/stores', body)));
    assert.doesNotThrow(() => parseTotersCapture(json('/api/user-info', body)));
    assert.doesNotThrow(() => parseTotersCapture(json('/api/addresses', body)));
  }
  // Truncated JSON, which is not the same as wrong-typed JSON.
  const truncated = makeCapture({
    method: 'GET', url: `https://${API}/api/home/stores`, host: API, path: '/api/home/stores',
    status: 200, resBody: '{"errors":false,"data":{"stores":{"data":[{"id":1,',
  });
  assert.doesNotThrow(() => parseTotersCapture(truncated));
  assert.deepEqual(parseTotersCapture(truncated), {});
});

// ── Pagination ───────────────────────────────────────────────────────────────

test('the store list seeds the next page, and stops at the last one', () => {
  const page = (current: number, last: number) =>
    json('/api/home/stores', {
      errors: false,
      data: { stores: { current_page: current, last_page: last, data: [{ id: 1, ref: 'A' }] } },
    });

  const seeds = totersNextCursors(page(1, 28));
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]?.cursor, '2');
  assert.equal(seeds[0]?.adapterId, 'toters');
  // The seed must name an action the app actually offers.
  assert.ok(totersApp.listReplayActions().some((a) => a.id === seeds[0]?.actionId));

  assert.deepEqual(totersNextCursors(page(28, 28)), [], 'last page seeds nothing');
  assert.deepEqual(totersNextCursors(page(29, 28)), [], 'past the end seeds nothing');
});

test('endpoints without a paginator seed nothing rather than looping on page one', () => {
  assert.deepEqual(totersNextCursors(json('/api/stores/1/items/popular', { errors: false, data: { popular: [{ id: 1 }] } })), []);
  assert.deepEqual(totersNextCursors(json('/api/user-info', { errors: false, data: { user: { id: 1 } } })), []);
  // Never an empty cursor — that would re-fetch page one forever.
  for (const seed of totersNextCursors(json('/api/home/stores', { errors: false, data: { stores: { current_page: 1, last_page: 2, data: [] } } }))) {
    assert.notEqual(seed.cursor, '');
  }
});

// ── Replay ───────────────────────────────────────────────────────────────────

const session: Session = {
  id: 'sess_test',
  adapterId: 'toters',
  workspaceId: 'toters',
  label: 'test',
  credentials: {
    kind: 'toters-bearer',
    values: { accessToken: 'TOKEN-VALUE-123456', clientDeviceToken: 'DEVICE-VALUE-999' },
    injection: { headers: { authorization: 'accessToken', 'client-device-token': 'clientDeviceToken' } },
  },
  discoveredAt: 0,
  source: 'manual',
};

test('every replay action is a GET — nothing here can place an order', () => {
  for (const action of totersApp.listReplayActions()) {
    assert.equal(action.method, 'GET', `${action.id} must be a read`);
    assert.ok(action.urlTemplate.startsWith('https://'));
    assert.ok(action.id.startsWith('toters.'), `${action.id} must be namespaced`);
  }
});

test('the builder injects credential VALUES, never the injection key names', () => {
  const action = totersApp.listReplayActions().find((a) => a.id === 'toters.user.info')!;
  const req = buildTotersReplayRequest(action, {}, session);
  assert.equal(req.headers?.authorization, 'Bearer TOKEN-VALUE-123456');
  assert.equal(req.headers?.['client-device-token'], 'DEVICE-VALUE-999');
  // The probe conformance runs: no key NAME may reach the wire.
  const wire = `${req.url} ${JSON.stringify(req.headers)} ${req.body ?? ''}`;
  for (const key of ['accessToken', 'clientDeviceToken']) {
    assert.ok(!wire.includes(key), `injection key ${key} leaked onto the wire`);
  }
});

test('path and query params are substituted, and blanks are dropped', () => {
  const action = totersApp.listReplayActions().find((a) => a.id === 'toters.store.popular-items')!;
  const req = buildTotersReplayRequest(action, { storeId: '10001' }, session);
  assert.equal(req.url, 'https://api.toters-api.com/api/stores/10001/items/popular');

  const stores = totersApp.listReplayActions().find((a) => a.id === 'toters.home.stores')!;
  const paged = buildTotersReplayRequest(stores, { page: '2', lat: '', lon: '35.5' }, session);
  assert.ok(paged.url.includes('page=2'));
  assert.ok(paged.url.includes('lon=35.5'));
  assert.ok(!paged.url.includes('lat='), 'an empty param must not be sent');
});

test('a missing store id throws by name instead of building /api/stores//items/popular', () => {
  const action = totersApp.listReplayActions().find((a) => a.id === 'toters.store.popular-items')!;
  assert.throws(() => buildTotersReplayRequest(action, {}, session), /storeId/);
  assert.throws(() => buildTotersReplayRequest(action, { storeId: '' }, session), /storeId/);
});

test('only declared params reach the query — a caller cannot add its own', () => {
  const stores = totersApp.listReplayActions().find((a) => a.id === 'toters.home.stores')!;
  const req = buildTotersReplayRequest(stores, { page: '2', include: 'orders', storeId: '1' }, session);
  assert.deepEqual([...new URL(req.url).searchParams.keys()], ['page']);
});

test('a session with no credentials builds an unauthenticated GET rather than throwing', () => {
  const anon: Session = { ...session, credentials: { kind: 'none', values: {}, injection: {} } };
  const action = totersApp.listReplayActions()[0]!;
  const req = buildTotersReplayRequest(action, {}, anon);
  assert.equal(req.method, 'GET');
  assert.equal(req.headers?.authorization, undefined);
});

// ── Credentials ──────────────────────────────────────────────────────────────

test('extractSessions reports none — there is no Toters desktop app to read', async () => {
  assert.deepEqual(await totersApp.credentials!.extractSessions(), []);
  // No signed-in workspace either: a constant would make `sluice doctor` pass and
  // overwrite the parsed `Toters — <name>` workspace on every start.
  assert.deepEqual(await totersApp.credentials!.listWorkspaces!(), []);
});

test('sessionFromInput turns a pasted token into a usable session', () => {
  const s = totersApp.credentials!.sessionFromInput!({ token: 'abc123', cookie: 'dev-tok' });
  assert.equal(s?.adapterId, 'toters');
  assert.equal(s?.credentials.values.accessToken, 'abc123');
  assert.equal(s?.credentials.values.clientDeviceToken, 'dev-tok');
  assert.equal(totersApp.credentials!.sessionFromInput!({ token: '', cookie: '' }), undefined);
  const named = totersApp.credentials!.sessionFromInput!({
    token: 'generic',
    accessToken: 'at-1',
    clientDeviceToken: 'dt-1',
  });
  assert.equal(named?.credentials.values.accessToken, 'at-1', "Toters' own key wins over the generic one");
  assert.equal(named?.credentials.values.clientDeviceToken, 'dt-1');
});

test('a pasted session injects `Bearer <token>` through its injection map, as the flow builder reads it', () => {
  for (const token of ['abc123', 'Bearer abc123', 'bearer   abc123']) {
    const s = totersApp.credentials!.sessionFromInput!({ token })!;
    const { values, injection } = s.credentials;
    assert.equal(values[injection.headers!.authorization!], 'Bearer abc123', token);
    const action = totersApp.listReplayActions().find((a) => a.id === 'toters.user.info')!;
    assert.equal(buildTotersReplayRequest(action, {}, s).headers?.authorization, 'Bearer abc123');
  }
  assert.equal(totersApp.credentials!.sessionFromInput!({ token: 'Bearer' }), undefined);
});

test('a pasted Slack token never becomes a Toters bearer', () => {
  for (const token of ['xoxc-not-a-real-token', 'XOXD-not-a-real-token', 'Bearer xoxp-not-a-real-token']) {
    assert.equal(totersApp.credentials!.sessionFromInput!({ token, cookie: 'd=not-a-real-cookie' }), undefined, token);
  }
});

// ── MCP tools ────────────────────────────────────────────────────────────────

test('a store-backed tool says so when the host provided no store', async () => {
  const tool = totersApp.mcpTools!().find((t) => t.name === 'toters_stores')!;
  await assert.rejects(() => tool.run({}, {} as AppToolContext), /capture store/i);
});

test('toters_stores reads containers and filters to this adapter', async () => {
  const containers = [
    { id: 'store:1', workspaceId: 'toters', adapterId: 'toters', kind: 'other' as const, name: 'Alpha', raw: { type: 'Grocery', is_open: true } },
    { id: 'store:2', workspaceId: 'toters', adapterId: 'toters', kind: 'other' as const, name: 'Beta', raw: { type: 'Restaurant' } },
    { id: 'store:3', workspaceId: 'toters', adapterId: 'slack', kind: 'other' as const, name: 'NotOurs', raw: {} },
    { id: 'address:9', workspaceId: 'toters', adapterId: 'toters', kind: 'other' as const, name: 'Home', raw: {} },
  ];
  const ctx = { store: { listContainers: () => containers } } as unknown as AppToolContext;
  const tool = totersApp.mcpTools!().find((t) => t.name === 'toters_stores')!;

  const all = (await tool.run({}, ctx)) as { count: number; stores: Array<{ name: string }> };
  assert.equal(all.count, 2, 'another adapter\'s container and the address are excluded');
  assert.deepEqual(all.stores.map((s) => s.name), ['Alpha', 'Beta']);

  const filtered = (await tool.run({ search: 'alp' }, ctx)) as { count: number };
  assert.equal(filtered.count, 1);
});

test('toters_store_items refuses a non-numeric store id', async () => {
  const tool = totersApp.mcpTools!().find((t) => t.name === 'toters_store_items')!;
  const ctx = { store: { queryItems: () => [] } } as unknown as AppToolContext;
  await assert.rejects(() => tool.run({ storeId: '../etc' }, ctx), /numeric/i);
  await assert.rejects(() => tool.run({ storeId: 'abc' }, ctx), /numeric/i);
});

// ── Redaction ────────────────────────────────────────────────────────────────

test('the payment token the generic policy used to miss is masked, and the body stays valid JSON', () => {
  // The generic SECRET_FIELD rule used to match `\btoken\b`, and `_` is a word
  // character — so `payment_method_token` had no boundary before `token` and
  // slid straight past it. This was measured on real captures, not imagined.
  registerAppRedaction([totersApp]);

  // Synthetic, but shaped like a real Stripe id so the value pattern is exercised.
  const pm = 'pm_1TESTTESTTESTTESTTESTTEST';
  const body = JSON.stringify({
    errors: false,
    data: {
      payment_methods: [
        { id: 12, payment_method_token: pm, brand: 'visa', last4: '4242' },
        { id: 13, address_token: 'adr_secretvalue12345678', label: 'Home' },
      ],
    },
  });
  const out = redactText(body);

  assert.ok(!out.includes(pm.slice(0, 12)), 'the Stripe payment-method id must be masked');
  // …by the value pattern alone, whatever field it rides in.
  assert.ok(!redactText(`note: ${pm}`).includes(pm.slice(0, 12)));
  assert.ok(!out.includes('adr_secretvalue'), 'address_token must be masked');
  // Over-redaction is its own bug: these are what makes a payment method
  // recognisable to its owner and neither is a credential.
  assert.ok(out.includes('"last4":"4242"'), 'benign fields must survive');
  assert.ok(out.includes('"brand":"visa"'));
  // The field NAME must survive too. Masking the `"field":"` prefix along with
  // the value leaves malformed JSON that every later parse of the capture
  // fails on — a data-integrity bug hiding inside a security fix.
  assert.ok(out.includes('"payment_method_token"'), 'the field name must survive');
  assert.doesNotThrow(() => JSON.parse(out), 'a redacted body must still parse');
});

// ── Conformance ──────────────────────────────────────────────────────────────

runConformance(totersApp, { session });
