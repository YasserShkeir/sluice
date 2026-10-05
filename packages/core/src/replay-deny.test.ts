// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isReplayMethodAllowed,
  looksLikeDeniedReplay,
  looksLikeDeniedWrite,
  replayHostAllowed,
  replayRequestProbe,
} from './replay-deny.js';

// A GET (or absent) method, so these cover the name patterns alone: they deny
// whatever the method, which keeps the runtime assert no weaker than the
// learn/build gates.
const denied = (s: string | undefined | null) => looksLikeDeniedWrite(undefined, s);

test('Slack write ops are denied', () => {
  assert.equal(denied('chat.postMessage'), true);
  assert.equal(denied('/api/chat.postMessage'), true);
  assert.equal(denied('method=chat.postMessage&text=hi'), true);
  assert.equal(looksLikeDeniedWrite('GET', 'admin.users.list'), true);
  assert.equal(denied('conversations.history'), false);
  assert.equal(denied('/api/conversations.history'), false);
});

test('Slack/OAuth write verbs are denied at a bare name and case-insensitively', () => {
  for (const s of [
    '/api/chat.post',
    'chat.post?x=1',
    '/api/chat.update',
    'chat.delete',
    'admin.x',
    'files.upload',
    'files.delete',
    'conversations.create',
    'conversations.invite',
    'conversations.kick',
    'conversations.leave',
    'conversations.archive',
    'oauth.revoke',
    '/api/oauth.token',
    'oauth.access',
    'CHAT.POST',
  ]) {
    assert.equal(denied(s), true, s);
  }
});

test('Trello write-shaped tokens are denied', () => {
  assert.equal(denied('cards.create'), true);
  assert.equal(denied('boards.create'), true);
  assert.equal(denied('cards/:id'), false);
  assert.equal(denied('/1/cards/abc12345'), false);
  assert.equal(denied('/1/members/me/cards'), false);
});

test('empty haystacks are ignored', () => {
  assert.equal(looksLikeDeniedWrite('POST', undefined, null, ''), false);
});

test('GraphQL mutations are denied', () => {
  assert.equal(denied('mutation { updateCard(id: "x") { id } }'), true);
  assert.equal(denied('query=mutation%20{'), true);
  assert.equal(denied('query { card(id: "x") { name } }'), false);
});

// ── Commerce writes (method-aware) ────────────────────────────────────────────

test('a POST to a commerce path is a denied write, but a GET of it is not', () => {
  // The case this exists for: Toters' iOS app places a real, paid order with a
  // plain `POST /api/orders`, which is shaped exactly like the POST-for-read
  // that Slack and Trello rely on.
  assert.equal(looksLikeDeniedWrite('POST', '/api/orders'), true);
  assert.equal(looksLikeDeniedWrite('PUT', '/api/v2/checkout'), true);
  assert.equal(looksLikeDeniedWrite('POST', '/api/mobile/payments'), true);
  assert.equal(looksLikeDeniedWrite('DELETE', '/api/cart/12'), true);

  // Reads of the same resources stay allowed — refusing them would be wrong,
  // and reading your own orders is the ordinary case.
  assert.equal(looksLikeDeniedWrite('GET', '/api/orders'), false);
  assert.equal(looksLikeDeniedWrite('GET', '/api/live-activity/data/orders'), false);
  assert.equal(looksLikeDeniedWrite('HEAD', '/api/mobile/payments'), false);
});

test('the commerce rail does not fire on paths that merely contain the word', () => {
  assert.equal(looksLikeDeniedWrite('POST', '/api/reorder-recommendations'), false);
  assert.equal(looksLikeDeniedWrite('POST', '/api/home/re-order-recommendations'), false);
  assert.equal(looksLikeDeniedWrite('POST', '/api/search?q=order_id=7'), false);
});

test('an absent method is treated as a read, matching the replay default', () => {
  assert.equal(looksLikeDeniedWrite(undefined, '/api/orders'), false);
  assert.equal(looksLikeDeniedWrite('post', '/api/orders'), true, 'method is case-insensitive');
});

// ── Method allowlist and probe (single source for runtime + flow build) ───────

test('isReplayMethodAllowed admits GET/HEAD/POST only', () => {
  for (const m of ['GET', 'head', 'POST']) assert.equal(isReplayMethodAllowed(m), true, m);
  for (const m of ['PUT', 'DELETE', 'PATCH', '', 'OPTIONS']) assert.equal(isReplayMethodAllowed(m), false, m);
});

test('replayRequestProbe builds the pathname?query haystack and the host', () => {
  assert.deepEqual(replayRequestProbe('https://API.Example.com/a/b?x=1&y=2'), {
    probe: '/a/b?x=1&y=2',
    host: 'api.example.com',
  });
  assert.deepEqual(replayRequestProbe('not a url'), { probe: 'not a url', host: '' });
  assert.equal(replayRequestProbe('https://h.test/p').probe, '/p?');
});

// ── Whole-request rail: deny gaps found by probing the old rail ──────────────

const req = (method: string, url: string, body?: string, headers?: Record<string, string>) => ({
  method,
  url,
  ...(body === undefined ? {} : { body }),
  ...(headers === undefined ? {} : { headers }),
});

test('looksLikeDeniedReplay refuses the write endpoints the name-only rail let through', () => {
  const writes = [
    // Slack
    req('POST', 'https://slack.com/api/conversations.mark', 'channel=C1&ts=1.2'),
    req('POST', 'https://slack.com/api/conversations.join', 'channel=C1'),
    req('POST', 'https://slack.com/api/chat.command', 'command=/remind'),
    req('POST', 'https://slack.com/api/users.profile.set', 'profile={}'),
    req('POST', 'https://slack.com/api/users.setPresence', 'presence=away'),
    req('POST', 'https://slack.com/api/reminders.add', 'text=x'),
    req('POST', 'https://slack.com/api/drafts.create', 'x=1'),
    req('POST', 'https://slack.com/api/im.open', 'user=U1'),
    // Notion
    req('POST', 'https://app.notion.com/api/v3/saveTransactionsFanout', '{}'),
    req('POST', 'https://app.notion.com/api/v3/submitTransaction', '{}'),
    // Trello
    req('POST', 'https://trello.com/1/cards', 'name=x&idList=L1'),
    req('POST', 'https://trello.com/1/cards/C1/actions/comments', 'text=hi'),
    req('POST', 'https://trello.com/1/cards/C1/markAssociatedNotificationsRead', ''),
    // LinkedIn
    req('POST', 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', '{}'),
    // Loom: persisted query (no `mutation` text) and a JSON-escaped mutation
    req('POST', 'https://www.loom.com/graphql', '{"operationName":"CreateComment","variables":{},"extensions":{"persistedQuery":{"sha256Hash":"00"}}}'),
    req('POST', 'https://www.loom.com/graphql', '{"query":"\\nmutation DoIt { x }"}'),
    req('GET', 'https://api.example.test/graphql?operationName=UpdateFolder&extensions=%7B%7D'),
    // Toters
    req('POST', 'https://api.toters-api.com/api/orders.json', '{}'),
    req('POST', 'https://api.toters-api.com/api/place-order', '{}'),
    req('POST', 'https://api.toters-api.com/api/cart-items', '{}'),
    // Percent-encoded operation names
    req('POST', 'https://slack.com/api/chat%2EpostMessage', 'text=hi'),
    req('POST', 'https://api.toters-api.com/api/order%73', '{}'),
    req('POST', 'https://slack.com/api/chat%252EpostMessage', 'text=hi'),
    req('POST', 'https://slack.com/api/x', 'method=chat%2EpostMessage'),
    // Method overrides
    req('POST', 'https://api.example.test/items/1', 'x=1', { 'X-HTTP-Method-Override': 'DELETE' }),
    req('POST', 'https://api.example.test/items/1', 'x=1', { 'x-http-method': 'PUT' }),
    req('GET', 'https://api.example.test/orders', undefined, { 'X-Method-Override': 'POST' }),
    req('POST', 'https://api.example.test/items/1', '_method=DELETE&x=1'),
    req('POST', 'https://api.example.test/items/1?_method=patch'),
    req('POST', 'https://api.example.test/items/1', '{"_method":"DELETE"}'),
  ];
  for (const r of writes) {
    assert.equal(looksLikeDeniedReplay(r), true, `${r.method} ${r.url} ${r.body ?? ''}`);
  }
});

test('looksLikeDeniedReplay keeps the shipped read actions and flow companions allowed', () => {
  const reads = [
    req('POST', 'https://slack.com/api/conversations.history', 'token=T&channel=C1&limit=100'),
    req('POST', 'https://slack.com/api/conversations.members', 'channel=C1'),
    req('POST', 'https://slack.com/api/conversations.info', 'channel=C1'),
    req('POST', 'https://slack.com/api/users.info', 'user=U1'),
    req('POST', 'https://slack.com/api/emoji.list', ''),
    req('GET', 'https://trello.com/1/members/me/cards?filter=open'),
    req('GET', 'https://trello.com/1/cards/C1/actions?filter=commentCard'),
    req('GET', 'https://trello.com/1/cards/C1'),
    req('POST', 'https://mail.google.com/sync/u/0/i/bv?hl=en&rt=r', '[[0,51]]'),
    req('POST', 'https://www.loom.com/graphql', '{"operationName":"GetLoomsForLibrary","variables":{"cursor":"x"},"query":"query GetLoomsForLibrary { x }"}'),
    req('POST', 'https://www.loom.com/graphql', '{"operationName":"GetCurrentUserUnseenNotificationsCount","query":"query Q { x }"}'),
    req('GET', 'https://www.linkedin.com/voyager/api/graphql?queryId=q1&variables=(x:1)'),
    req('POST', 'https://app.notion.com/api/v3/loadPageChunk', '{"pageId":"p1","limit":100}'),
    req('POST', 'https://app.notion.com/api/v3/syncRecordValues', '{"requests":[]}'),
    req('GET', 'https://api.toters-api.com/api/orders.json'),
    req('GET', 'https://api.example.test/search?q=100%25%20done'),
    req('POST', 'https://api.example.test/items', 'x=1', { 'X-HTTP-Method-Override': 'GET' }),
    req('POST', 'https://api.example.test/bookmarkReader', ''),
  ];
  for (const r of reads) {
    assert.equal(looksLikeDeniedReplay(r), false, `${r.method} ${r.url} ${r.body ?? ''}`);
  }
});

test('looksLikeDeniedReplay checks extra haystacks and defaults to GET', () => {
  assert.equal(looksLikeDeniedReplay({ url: 'https://slack.com/api/x' }, 'chat.postMessage'), true);
  assert.equal(looksLikeDeniedReplay({ url: 'https://h.test/api/orders' }), false, 'an absent method is a read');
  assert.equal(looksLikeDeniedReplay({ url: 'not a url chat.postMessage' }), true);
});

test('replayHostAllowed matches a listed host or a subdomain of one', () => {
  const hosts = ['slack.com', '*.slack-edge.com', ' Mail.Google.com '];
  assert.equal(replayHostAllowed('slack.com', hosts), true);
  assert.equal(replayHostAllowed('acme.slack.com', hosts), true, 'a subdomain of an apex');
  assert.equal(replayHostAllowed('EDGEAPI.SLACK.COM', hosts), true, 'case-insensitive');
  assert.equal(replayHostAllowed('a.slack-edge.com', hosts), true, 'a `*.` entry is stripped');
  assert.equal(replayHostAllowed('mail.google.com', hosts), true, 'entries are trimmed and lowercased');
  assert.equal(replayHostAllowed('evilslack.com', hosts), false, 'a lookalike is not a subdomain');
  assert.equal(replayHostAllowed('slack.com.evil.test', hosts), false);
  assert.equal(replayHostAllowed('', hosts), false, 'an empty host allows nothing');
  assert.equal(replayHostAllowed('slack.com', []), false, 'an empty list allows nothing');
  assert.equal(replayHostAllowed('slack.com', ['', '*.']), false, 'empty entries are skipped');
});
