// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tiny fixture-based tests for the Slack parser. Run with:
 *   node --test --import tsx   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, runConformance } from '@sluice/adapter-sdk';
import { MASK, redactText, registerAppRedaction, resetAppRedaction } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { slackApp } from './index.js';
import { slackAdapter, slackSessionFromCreds } from './slack-adapter.js';
import { classifySlackCapture, parseSlackCapture, slackNextCursors } from './parse.js';

/**
 * Slack defaults over the SDK factory. The private copy this file used to carry
 * had to be edited every time `Capture` grew a field, and three other packages
 * carried their own drifting version of the same thing.
 */
function capture(over: Partial<Capture> = {}): Capture {
  return makeCapture({
    id: 'cap_test',
    adapterId: 'slack',
    url: 'https://slack.com/api/api.test',
    host: 'slack.com',
    path: '/api/api.test',
    reqHeaders: {},
    resHeaders: {},
    ...over,
  });
}

/** A Slack call as captured: method in the path, params in the urlencoded body. */
function slackCall(method: string, reqBody: string | null, body: unknown): Capture {
  return capture({
    path: `/api/${method}`,
    url: `https://slack.com/api/${method}`,
    reqBody,
    resBody: JSON.stringify(body),
  });
}

test('conversations.list → containers with kind/topic/privacy/members', () => {
  const res = parseSlackCapture(
    capture({
      url: 'https://acme.slack.com/api/conversations.list',
      path: '/api/conversations.list',
      resBody: JSON.stringify({
        ok: true,
        channels: [
          {
            id: 'C1',
            name: 'general',
            is_channel: true,
            is_private: false,
            num_members: 42,
            context_team_id: 'T99',
            topic: { value: 'hello world' },
          },
          { id: 'D1', is_im: true, user: 'U5' },
        ],
      }),
    }),
  );
  assert.equal(res.containers?.length, 2);
  const general = res.containers?.[0];
  assert.equal(general?.kind, 'channel');
  assert.equal(general?.name, 'general');
  assert.equal(general?.topic, 'hello world');
  assert.equal(general?.isPrivate, false);
  assert.equal(general?.memberCount, 42);
  assert.equal(general?.workspaceId, 'T99'); // team id lifted from context_team_id
  assert.equal(res.containers?.[1]?.kind, 'dm');
  assert.equal(res.containers?.[1]?.name, 'dm:U5');
});

test('users.list → actors with handle/displayName/avatar', () => {
  const res = parseSlackCapture(
    capture({
      path: '/api/users.list',
      url: 'https://slack.com/api/users.list',
      resBody: JSON.stringify({
        ok: true,
        members: [
          {
            id: 'U5',
            name: 'ada',
            profile: { display_name: 'Ada L.', real_name: 'Ada Lovelace', image_48: 'https://x/48.png' },
          },
        ],
      }),
    }),
  );
  const a = res.actors?.[0];
  assert.equal(a?.handle, 'ada');
  assert.equal(a?.displayName, 'Ada L.');
  assert.equal(a?.avatarUrl, 'https://x/48.png');
});

test('users.list actors land in the same workspace as conversations.list containers', () => {
  // `members[].team_id` is the only place a users.list response names its team.
  // Missing it, the actors were filed under the synthetic `slack:slack.com` while
  // containers from the SAME workspace were filed under `T99`, so the webapp's
  // `listActors(container.workspaceId)` returned [] and every message rendered as
  // a bare `U5` with no handle.
  const actor = parseSlackCapture(
    slackCall('users.list', 'limit=200', {
      ok: true,
      members: [{ id: 'U5', name: 'ada', team_id: 'T99' }],
    }),
  ).actors?.[0];
  const container = parseSlackCapture(
    slackCall('conversations.list', 'limit=200', {
      ok: true,
      channels: [{ id: 'C1', name: 'general', is_channel: true, context_team_id: 'T99' }],
    }),
  ).containers?.[0];
  assert.equal(actor?.workspaceId, 'T99');
  assert.equal(container?.workspaceId, actor?.workspaceId);

  // users.info reads team_id off `user`, and must keep agreeing with users.list.
  const fromInfo = parseSlackCapture(
    slackCall('users.info', 'user=U5', { ok: true, user: { id: 'U5', name: 'ada', team_id: 'T99' } }),
  ).actors?.[0];
  assert.equal(fromInfo?.workspaceId, actor?.workspaceId);
});

test('ctx.workspaceId wins over the id derived from the body', () => {
  const cap = slackCall('users.list', 'limit=200', {
    ok: true,
    members: [{ id: 'U5', name: 'ada', team_id: 'T99' }],
  });
  assert.equal(parseSlackCapture(cap).actors?.[0]?.workspaceId, 'T99');
  assert.equal(
    parseSlackCapture(cap, { workspaceId: 'TCALLER' }).actors?.[0]?.workspaceId,
    'TCALLER',
  );
});

test('conversations.history → items with channel from form body + ms ts', () => {
  const res = parseSlackCapture(
    capture({
      path: '/api/conversations.history',
      url: 'https://slack.com/api/conversations.history',
      reqBody: 'token=xoxc-REDACTED&channel=C1&limit=200',
      resBody: JSON.stringify({
        ok: true,
        messages: [
          { type: 'message', ts: '1700000000.001500', user: 'U5', text: 'hi', thread_ts: '1700000000.001500' },
          { type: 'message', ts: '1700000001.002000', user: 'U6', text: 'yo' },
        ],
      }),
    }),
  );
  assert.equal(res.items?.length, 2);
  const first = res.items?.[0];
  assert.equal(first?.containerId, 'C1');
  assert.equal(first?.id, '1700000000.001500');
  assert.equal(first?.ts, Math.round(1700000000.0015 * 1000));
  assert.equal(first?.authorId, 'U5');
  assert.equal(first?.threadId, '1700000000.001500');
  assert.deepEqual(first?.sourceCaptureIds, ['cap_test']);
});

test('ok:false response yields empty result', () => {
  const res = parseSlackCapture(
    capture({
      path: '/api/conversations.list',
      resBody: JSON.stringify({ ok: false, error: 'not_authed' }),
    }),
  );
  assert.deepEqual(res, {});
});

test('matchRequest only claims slack /api/ hosts', () => {
  assert.equal(slackAdapter.matchRequest({ host: 'acme.slack.com', path: '/api/conversations.list', method: 'POST', url: '' }), true);
  assert.equal(slackAdapter.matchRequest({ host: 'edgeapi.slack.com', path: '/api/search.modules.messages', method: 'POST', url: '' }), true);
  assert.equal(slackAdapter.matchRequest({ host: 'evil.com', path: '/api/x', method: 'GET', url: '' }), false);
  assert.equal(slackAdapter.matchRequest({ host: 'slack.com', path: '/help', method: 'GET', url: '' }), false);
});

test('buildReplayRequest puts token in form + d in Cookie header', () => {
  const session = slackSessionFromCreds('xoxc-abc', 'xoxd-def', { label: 't' });
  const action = slackAdapter.listReplayActions().find((a) => a.id === 'slack.conversations.history')!;
  const req = slackAdapter.buildReplayRequest(action, { channel: 'C1', limit: '50' }, session);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://slack.com/api/conversations.history');
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(req.headers['Cookie'], 'd=xoxd-def');
  const form = new URLSearchParams(req.body);
  assert.equal(form.get('token'), 'xoxc-abc');
  assert.equal(form.get('channel'), 'C1');
  assert.equal(form.get('limit'), '50');
});

test('extractCredentialHints reports presence on a redacted capture', () => {
  const hints = slackAdapter.extractCredentialHints!(
    capture({ reqHeaders: { authorization: '«redacted»', cookie: '«redacted»' }, reqBody: 'token=«redacted»&channel=C1' }),
  );
  const roles = hints.map((h) => `${h.location}:${h.role}`);
  assert.ok(roles.includes('header:bearer'));
  assert.ok(roles.includes('cookie:session-cookie'));
  assert.ok(roles.includes('body:bearer'));
  for (const h of hints) assert.ok(!h.valuePreview.includes('xox'));
});

// ── classify ────────────────────────────────────────────────────────────────────

test('classify names the slack method as the operation', () => {
  const seen = (m: string): { class: string; operation?: string } =>
    classifySlackCapture(slackCall(m, null, { ok: true }));
  assert.deepEqual(seen('conversations.list'), { class: 'structure', operation: 'conversations.list' });
  assert.deepEqual(seen('client.userBoot'), { class: 'structure', operation: 'client.userBoot' });
  assert.deepEqual(seen('conversations.history'), { class: 'messages', operation: 'conversations.history' });
  assert.deepEqual(seen('auth.test'), { class: 'auth', operation: 'auth.test' });
  assert.deepEqual(seen('chat.postMessage'), { class: 'unknown', operation: 'chat.postMessage' });
});

test('classify: a 200 with ok:false is an error, not an unrecognized endpoint', () => {
  // The regression this pins: parse() collapses {ok:false} to {}, which is
  // byte-identical to an endpoint we do not handle. An expired session must not
  // look like a quiet workspace.
  const expired = slackCall('conversations.list', null, { ok: false, error: 'not_authed' });
  assert.equal(expired.status, 200);
  assert.deepEqual(classifySlackCapture(expired), {
    class: 'error',
    operation: 'conversations.list',
  });
  assert.deepEqual(parseSlackCapture(expired), {}, 'parse still yields nothing — hence the class');

  const throttled = slackCall('conversations.history', null, { ok: false, error: 'ratelimited' });
  assert.equal(classifySlackCapture(throttled).class, 'error');
  assert.equal(
    classifySlackCapture(capture({ path: '/api/conversations.history', status: 429, resBody: null }))
      .class,
    'error',
  );
});

test('classify never throws on a hostile body', () => {
  for (const resBody of [null, '', '{"ok":true,"channels":[', '<html>502', '[1,2,3]', 'null']) {
    assert.doesNotThrow(() => classifySlackCapture(capture({ resBody })));
    assert.doesNotThrow(() => slackNextCursors(capture({ resBody })));
  }
});

// ── nextCursors ─────────────────────────────────────────────────────────────────

test('nextCursors carries the channel forward from the REQUEST', () => {
  // channel appears nowhere in a conversations.history response, so a seed built
  // from the body alone would replay a call that cannot run.
  const seeds = slackNextCursors(
    slackCall('conversations.history', 'token=xoxc-REDACTED&channel=C1&limit=200', {
      ok: true,
      has_more: true,
      messages: [{ ts: '1700000000.000100', text: 'hi' }],
      response_metadata: { next_cursor: 'bmV4dF90czoxNzAw' },
    }),
  );
  assert.equal(seeds.length, 1);
  const seed = seeds[0];
  assert.equal(seed?.adapterId, 'slack');
  assert.equal(seed?.actionId, 'slack.conversations.history');
  assert.equal(seed?.cursor, 'bmV4dF90czoxNzAw');
  assert.equal(seed?.containerId, 'C1');
  assert.equal(seed?.reason, 'cursor');
  assert.deepEqual(seed?.params, { channel: 'C1', limit: '200' });
  // Rule 3: a seed must name an action that actually exists.
  const ids = slackAdapter.listReplayActions().map((a) => a.id);
  assert.ok(ids.includes(seed?.actionId ?? ''));
});

test('every seed names a replay action that exists', () => {
  // Rule 3, for all five paged methods rather than the one a spot-check covers:
  // a seed addressed to an actionId nobody declares is dequeued and dropped, and
  // the pagination just stops with no error anywhere.
  const ids = new Set(slackAdapter.listReplayActions().map((a) => a.id));
  const paged: Array<[string, string]> = [
    ['conversations.list', 'types=public_channel&limit=200'],
    ['users.conversations', 'types=im&limit=200'],
    ['users.list', 'limit=200'],
    ['conversations.history', 'channel=C1&limit=200'],
    ['conversations.replies', 'channel=C1&ts=1700000000.000100'],
  ];
  for (const [method, reqBody] of paged) {
    const seeds = slackNextCursors(
      slackCall(method, reqBody, { ok: true, response_metadata: { next_cursor: 'abc' } }),
    );
    assert.equal(seeds.length, 1, `${method} produced no seed`);
    assert.ok(ids.has(seeds[0]?.actionId ?? ''), `${method} → unknown action ${seeds[0]?.actionId}`);
    assert.equal(seeds[0]?.adapterId, slackAdapter.id);
  }
});

test('nextCursors: an empty next_cursor means EXHAUSTED, not page one', () => {
  const exhausted = (next: unknown): number =>
    slackNextCursors(
      slackCall('conversations.list', 'types=public_channel&limit=200', {
        ok: true,
        channels: [{ id: 'C1', name: 'general', is_channel: true }],
        response_metadata: { next_cursor: next },
      }),
    ).length;
  assert.equal(exhausted(''), 0);
  assert.equal(exhausted(undefined), 0);
  assert.equal(exhausted(null), 0);
  assert.equal(exhausted('dGVhbTpDMDYx'), 1);
});

test('nextCursors drops a page it could not address', () => {
  // No channel in the request → the replay has no channel to send, and Slack
  // answers `channel_not_found`. Emitting nothing beats emitting a known-bad call.
  assert.deepEqual(
    slackNextCursors(
      slackCall('conversations.history', null, {
        ok: true,
        response_metadata: { next_cursor: 'abc' },
      }),
    ),
    [],
  );
  // replies additionally needs the thread ts.
  assert.deepEqual(
    slackNextCursors(
      slackCall('conversations.replies', 'channel=C1', {
        ok: true,
        response_metadata: { next_cursor: 'abc' },
      }),
    ),
    [],
  );
});

test('nextCursors: a boot response fans out one history seed per channel', () => {
  const seeds = slackNextCursors(
    slackCall('client.userBoot', null, {
      ok: true,
      team: { id: 'T99', name: 'Acme' },
      channels: [{ id: 'C1', name: 'general', is_channel: true }, { id: 'C2', name: 'random' }],
      ims: [{ id: 'D1', is_im: true, user: 'U5' }],
      mpims: [{ id: 'C1' }], // the same channel listed twice must not double up
    }),
  );
  assert.deepEqual(
    seeds.map((s) => s.containerId),
    ['C1', 'C2', 'D1'],
  );
  for (const s of seeds) {
    assert.equal(s.reason, 'fanout', 'a boot payload carries no cursor — this is fan-out');
    assert.equal(s.actionId, 'slack.conversations.history');
    assert.equal(s.cursor, undefined);
    assert.deepEqual(s.params, { channel: s.containerId });
  }
});

test('nextCursors returns nothing for a failed call', () => {
  assert.deepEqual(
    slackNextCursors(
      slackCall('users.list', 'limit=200', {
        ok: false,
        error: 'ratelimited',
        response_metadata: { next_cursor: 'stale' },
      }),
    ),
    [],
  );
});

test('a prototype key in the path routes nowhere instead of throwing', () => {
  // `CURSOR_ROUTES['__proto__']` on an object literal handed back Object.prototype
  // — truthy — so the route branch ran and `for (const name of route.carry)` threw
  // out of a hook the ingest funnel runs for EVERY capture, which stops capture
  // for every app at once, not just this one row.
  for (const method of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    const paged = slackCall(method, 'channel=C1&limit=200', {
      ok: true,
      response_metadata: { next_cursor: 'abc' },
    });
    assert.deepEqual(slackNextCursors(paged), [], `/api/${method} is not a paged method`);
    assert.deepEqual(parseSlackCapture(paged), {}, `/api/${method} is not an endpoint`);
    assert.equal(classifySlackCapture(paged).class, 'unknown');
  }
});

// ── Redaction ───────────────────────────────────────────────────────────────────

test('the whole percent-escaped d cookie is redacted, not just its prefix', () => {
  // Two patterns, applied in registration order, shadowed each other: the narrower
  // `xox[abcdeprs]-[A-Za-z0-9-]{8,}` had no `%` in its class, so it masked only
  // `xoxd-cVdDdMSUmqNs` and consumed the `xoxd-` the wider pattern needed — 40 of
  // the 57 secret characters reached SQLite and the WebSocket.
  const cookie = 'xoxd-cVdDdMSUmqNs%2FJqjc9fLuaQnEXxrABCDEFGH%2BijklMNOP%3D';
  const token = 'xoxc-2417832418-2417832418-8231978423-abcdef0123456789';
  resetAppRedaction();
  registerAppRedaction([slackApp]);
  try {
    const out = redactText(`{"d":"${cookie}","api_token":"${token}","team":"T99"}`);
    for (const secret of [cookie, token]) {
      for (let i = 0; i + 8 <= secret.length; i++) {
        const fragment = secret.slice(i, i + 8);
        assert.ok(!out.includes(fragment), `leaked "${fragment}" of ${secret.slice(0, 5)}`);
      }
    }
    assert.equal(out, `{"d":"${MASK}","api_token":"${MASK}","team":"T99"}`);
  } finally {
    resetAppRedaction();
  }
});

// ── The shared adapter invariants ───────────────────────────────────────────────

runConformance(slackApp, {
  fixtures: [
    slackCall('conversations.list', 'types=public_channel&limit=200', {
      ok: true,
      channels: [{ id: 'C1', name: 'general', is_channel: true, context_team_id: 'T99' }],
      response_metadata: { next_cursor: 'dGVhbTpDMDYx' },
    }),
    slackCall('conversations.history', 'token=xoxc-REDACTED&channel=C1', {
      ok: true,
      messages: [{ ts: '1700000000.000100', user: 'U5', text: 'hi' }],
    }),
    slackCall('users.list', 'limit=200', {
      ok: true,
      members: [{ id: 'U5', name: 'ada', profile: { display_name: 'Ada L.' } }],
    }),
    slackCall('client.userBoot', null, {
      ok: true,
      team: { id: 'T99', name: 'Acme', domain: 'acme' },
      channels: [{ id: 'C1', name: 'general', is_channel: true }],
      ims: [{ id: 'D1', is_im: true, user: 'U5' }],
    }),
    slackCall('conversations.list', null, { ok: false, error: 'not_authed' }),
  ],
  session: slackSessionFromCreds('xoxc-abc', 'xoxd-def', { label: 'conformance' }),
});
