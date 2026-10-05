// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * app-loom tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The cookie decryption is macOS/Keychain-bound and is not exercised here;
 * everything below is pure. The shared invariants (never-throws, host lookalikes,
 * secrets resolved by value) come from `runConformance` at the bottom — this file
 * only pins what is specific to Loom.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, runConformance } from '@sluice/adapter-sdk';
import type { AppToolContext, Capture, Session } from '@sluice/core';
import {
  classifyLoomCapture,
  createLoomMcpTools,
  graphqlOperationOf,
  loomApp,
  loomNextCursors,
  matchesLoom,
  parseLoomCapture,
  parseVtt,
} from './index.js';

/** Synthetic, Loom-shaped (32 hex) video ids — never copied from a real account. */
const VID = '00000000000040008000000000000a01';
const VID2 = '00000000000040008000000000000a02';

/** A captured Loom GraphQL exchange: request declares `operationName`, response carries `data`. */
function loomGraphql(operationName: string, data: unknown, over: Partial<Capture> = {}): Capture {
  return makeCapture({
    adapterId: 'loom',
    method: 'POST',
    host: 'www.loom.com',
    path: '/graphql',
    url: 'https://www.loom.com/graphql',
    reqBody: JSON.stringify({ operationName, variables: {}, query: `query ${operationName} { __typename }` }),
    resBody: typeof data === 'string' ? data : JSON.stringify({ data }),
    ...over,
  });
}

const LIBRARY_RESPONSE = {
  getLooms: {
    __typename: 'GetLoomsPayload',
    videos: {
      edges: [
        { cursor: 'Y3Vyc29yOjA=', node: { id: VID, name: 'Example walkthrough', visibility: 'owner', createdAt: '2025-01-02T03:04:05.678Z' } },
        { cursor: 'Y3Vyc29yOjE=', node: { id: VID2, name: 'Example overview', visibility: 'owner' } },
      ],
      pageInfo: { endCursor: 'Y3Vyc29yOjE=', hasNextPage: true },
    },
  },
};

// ── parse ────────────────────────────────────────────────────────────────────────

test('parse: GetLoomsForLibrary → one workspace, one container, one item per video', () => {
  const cap = loomGraphql('GetLoomsForLibrary', LIBRARY_RESPONSE);
  const result = parseLoomCapture(cap);
  assert.equal(result.workspaces?.length, 1);
  assert.equal(result.workspaces?.[0]?.id, 'loom');
  assert.equal(result.containers?.length, 1);
  assert.equal(result.containers?.[0]?.id, 'loom:videos');
  assert.equal(result.items?.length, 2);
  const ids = result.items?.map((i) => i.id);
  assert.deepEqual(ids, [VID, VID2]);
  // createdAt is normalized to epoch ms; the second video (no createdAt) → 0.
  assert.equal(result.items?.[0]?.ts, Date.parse('2025-01-02T03:04:05.678Z'));
  assert.equal(result.items?.[1]?.ts, 0);
  assert.equal(result.items?.[0]?.text, 'Example walkthrough');
  assert.equal(result.items?.[0]?.containerId, 'loom:videos');
  // provenance survives: the item points back at the capture it came from.
  assert.deepEqual(result.items?.[0]?.sourceCaptureIds, [cap.id]);
});

test('parse: getVideo (single video) → one item', () => {
  const result = parseLoomCapture(loomGraphql('GetVideoCardDetails', { video: { id: VID, name: 'Solo', createdAt: '2025-02-03T04:05:06.789Z' } }));
  assert.equal(result.items?.length, 1);
  assert.equal(result.items?.[0]?.id, VID);
  assert.equal(result.items?.[0]?.text, 'Solo');
});

test('parse: non-graphql and empty bodies yield nothing, never throw', () => {
  assert.deepEqual(parseLoomCapture(makeCapture({ host: 'cdn.loom.com', path: '/assets/js/app.js', resBody: 'x' })), {});
  assert.deepEqual(parseLoomCapture(loomGraphql('GetWorkspaceSetting', { getWorkspaceSetting: { id: 'w' } })), {});
  assert.deepEqual(parseLoomCapture(loomGraphql('X', 'not json{', {})), {});
  assert.deepEqual(parseLoomCapture(makeCapture({ host: 'www.loom.com', path: '/graphql', resBody: null })), {});
});

// ── classify ───────────────────────────────────────────────────────────────────────

test('classify: video/notification ops are messages, account ops are structure', () => {
  assert.equal(classifyLoomCapture(loomGraphql('GetLoomsForLibrary', LIBRARY_RESPONSE)).class, 'messages');
  assert.equal(classifyLoomCapture(loomGraphql('FetchVideoTranscript', {})).class, 'messages');
  assert.equal(classifyLoomCapture(loomGraphql('GetCurrentUserNotifications', {})).class, 'messages');
  assert.equal(classifyLoomCapture(loomGraphql('SelectedWorkspaceMembership', {})).class, 'structure');
  assert.equal(classifyLoomCapture(loomGraphql('GetLoomsForLibrary', LIBRARY_RESPONSE)).operation, 'GetLoomsForLibrary');
});

test('classify: assets and errors', () => {
  assert.equal(classifyLoomCapture(makeCapture({ host: 'cdn.loom.com', path: '/assets/js/app.js' })).class, 'asset');
  assert.equal(classifyLoomCapture(makeCapture({ host: 'www.loom.com', path: '/looms/videos' })).class, 'asset');
  assert.equal(classifyLoomCapture(loomGraphql('GetLoomsForLibrary', LIBRARY_RESPONSE, { status: 401 })).class, 'error');
  // A 200 whose GraphQL body is all errors is still an error.
  assert.equal(
    classifyLoomCapture(loomGraphql('GetLoomsForLibrary', JSON.stringify({ errors: [{ message: 'nope' }], data: null }))).class,
    'error',
  );
});

// ── operationName extraction ────────────────────────────────────────────────────────

test('graphqlOperationOf reads operationName from the request body', () => {
  assert.equal(graphqlOperationOf(loomGraphql('FetchVideoTranscript', {})), 'FetchVideoTranscript');
  assert.equal(graphqlOperationOf(makeCapture({ path: '/graphql', reqBody: 'not json' })), undefined);
  assert.equal(graphqlOperationOf(makeCapture({ path: '/looms', reqBody: '{"operationName":"X"}' })), undefined);
});

// ── host matching ────────────────────────────────────────────────────────────────────

test('matchesLoom claims loom.com and subdomains, nothing else', () => {
  assert.ok(matchesLoom('www.loom.com'));
  assert.ok(matchesLoom('cdn.loom.com'));
  assert.ok(matchesLoom('loom.com'));
  assert.ok(!matchesLoom('notloom.com'));
  assert.ok(!matchesLoom('loom.com.evil.com'));
});

// ── WebVTT transcript parsing ─────────────────────────────────────────────────────────

test('parseVtt: parses cues, handles HH:MM:SS and MM:SS, strips tags, skips headers/NOTE', () => {
  const vtt = [
    'WEBVTT',
    '',
    'NOTE this is a comment',
    '',
    '1',
    '00:00:01.000 --> 00:00:03.500',
    'Hello <c>there</c>',
    '',
    '00:02.000 --> 00:04.000 align:start position:0%',
    '<00:00:02.500>Second line',
    '',
  ].join('\n');
  const { segments, text } = parseVtt(vtt);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.start, 1);
  assert.equal(segments[0]?.end, 3.5);
  assert.equal(segments[0]?.text, 'Hello there');
  assert.equal(segments[1]?.start, 2);
  assert.equal(segments[1]?.end, 4);
  assert.equal(segments[1]?.text, 'Second line');
  assert.equal(text, 'Hello there Second line');
});

test('parseVtt: empty / malformed input returns no segments, never throws', () => {
  assert.deepEqual(parseVtt(''), { segments: [], text: '' });
  assert.deepEqual(parseVtt('WEBVTT\n\ngarbage with no timing\n'), { segments: [], text: '' });
});

// ── Shared adapter conformance ─────────────────────────────────────────────────────────

const SESSION: Session = {
  id: 's1',
  adapterId: 'loom',
  label: 'Loom',
  credentials: {
    kind: 'loom-session',
    values: { cookieHeader: 'connect.sid=SECRET-COOKIE-VALUE-123' },
    injection: { headers: { Cookie: 'cookieHeader' } },
  },
  discoveredAt: 1_700_000_000_000,
  source: 'local-store',
};

runConformance(loomApp, {
  session: SESSION,
  fixtures: [
    loomGraphql('GetLoomsForLibrary', LIBRARY_RESPONSE),
    loomGraphql('GetVideoCardDetails', { video: { id: VID, name: 'Solo', createdAt: '2025-02-03T04:05:06.789Z' } }),
    loomGraphql('GetCurrentUserNotifications', { currentUser: { notification: { notificationConnection: { edges: [] } } } }),
    makeCapture({ host: 'cdn.loom.com', path: '/assets/js/app.js', resBody: '(function(){})()' }),
  ],
});


test('nextCursors seeds library page when hasNextPage', () => {
  const reqBody = JSON.stringify({
    operationName: 'GetLoomsForLibrary',
    query: 'query GetLoomsForLibrary',
    variables: { limit: 12, cursor: null },
  });
  const resBody = JSON.stringify({
    data: {
      getLoomsForLibrary: {
        videos: {
          edges: [{ cursor: 'c0', node: { id: 'v1', name: 'n', visibility: 'owner', createdAt: '2024-01-01' } }],
          pageInfo: { endCursor: 'cNEXT', hasNextPage: true },
        },
      },
    },
  });
  const cap = {
    id: 'c1',
    ts: 1,
    source: 'mitm' as const,
    adapterId: 'loom',
    method: 'POST',
    url: 'https://www.loom.com/graphql',
    host: 'www.loom.com',
    path: '/graphql',
    status: 200,
    durationMs: 1,
    reqHeaders: {},
    reqBody,
    resHeaders: {},
    resBody,
    pid: null,
    processName: null,
  };
  const seeds = loomApp.nextCursors?.(cap) ?? [];
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]!.actionId, 'loom.videos.library');
  assert.equal(seeds[0]!.cursor, 'cNEXT');
  assert.equal(seeds[0]!.params?.cursor, 'cNEXT');
});

test('nextCursors empty when hasNextPage is false', () => {
  const reqBody = JSON.stringify({
    operationName: 'GetLoomsForLibrary',
    query: 'query GetLoomsForLibrary',
    variables: { limit: 12 },
  });
  const resBody = JSON.stringify({
    data: {
      getLoomsForLibrary: {
        videos: {
          edges: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    },
  });
  const cap = {
    id: 'c2',
    ts: 1,
    source: 'mitm' as const,
    adapterId: 'loom',
    method: 'POST',
    url: 'https://www.loom.com/graphql',
    host: 'www.loom.com',
    path: '/graphql',
    status: 200,
    durationMs: 1,
    reqHeaders: {},
    reqBody,
    resHeaders: {},
    resBody,
    pid: null,
    processName: null,
  };
  assert.deepEqual(loomApp.nextCursors?.(cap) ?? [], []);
});

/** A library or notifications page whose request declares `variables` and whose answer has a next page. */
function pagedCapture(operationName: string, variables: Record<string, unknown>, data: unknown): Capture {
  return loomGraphql(operationName, data, {
    reqBody: JSON.stringify({ operationName, query: `query ${operationName}`, variables }),
  });
}

test('nextCursors keeps the page size the request asked for', () => {
  // The regression: libraryOp / notificationsOp send `limit` / `first` as NUMBERS
  // and the seed read them with str(), so every follow-up page reset to 12 / 20.
  // The existing 12-based tests hid it by matching the default.
  const nextPage = { pageInfo: { endCursor: 'cNEXT', hasNextPage: true } };
  const library = loomNextCursors(
    pagedCapture('GetLoomsForLibrary', { limit: 36, cursor: null }, { getLooms: { videos: { edges: [], ...nextPage } } }),
  );
  assert.equal(library[0]?.actionId, 'loom.videos.library');
  assert.equal(library[0]?.params?.limit, '36');

  const notifications = loomNextCursors(
    pagedCapture(
      'GetCurrentUserNotifications',
      { first: 5, cursor: null },
      { currentUser: { notification: { notificationConnection: { edges: [], ...nextPage } } } },
    ),
  );
  assert.equal(notifications[0]?.actionId, 'loom.notifications.list');
  assert.equal(notifications[0]?.params?.first, '5');

  // A numeric string is a page size too; anything else falls back to the default.
  const asString = loomNextCursors(
    pagedCapture('GetLoomsForLibrary', { limit: '50' }, { getLooms: { videos: { edges: [], ...nextPage } } }),
  );
  assert.equal(asString[0]?.params?.limit, '50');
  const missing = loomNextCursors(
    pagedCapture('GetLoomsForLibrary', {}, { getLooms: { videos: { edges: [], ...nextPage } } }),
  );
  assert.equal(missing[0]?.params?.limit, '12');
});

// ── MCP tools ─────────────────────────────────────────────────────────────────────────

/** A synthetic cookie source: the tools never reach Chrome or the Keychain here. */
const SYNTHETIC_COOKIE = () => 'connect.sid=SYNTHETIC-COOKIE';

function tool(name: string) {
  const t = createLoomMcpTools(SYNTHETIC_COOKIE).find((x) => x.name === name);
  assert.ok(t, `precondition: ${name} exists`);
  return t;
}

test('loom_list_notifications passes the cursor through and returns the next one', async () => {
  // The regression: the tool always sent `cursor: null`, took no cursor argument
  // and returned no nextCursor, although the query selects pageInfo — so an
  // agent could only ever see the first page.
  const sent: Array<{ operationName?: string; variables?: Record<string, unknown> }> = [];
  const ctx: AppToolContext = {
    replay: async (req) => {
      const body = JSON.parse(req.body ?? '{}') as { operationName?: string; variables?: Record<string, unknown> };
      sent.push(body);
      const data =
        body.operationName === 'GetCurrentUserNotifications'
          ? {
              currentUser: {
                notification: {
                  notificationConnection: {
                    edges: [{ cursor: 'n0', node: { id: 'n1', notificationType: 'comment', status: 'unseen' } }],
                    pageInfo: { endCursor: 'cNEXT', hasNextPage: true },
                  },
                },
              },
            }
          : { currentUser: { notification: { unseenNotificationsCount: { count: 3 } } } };
      return loomGraphql(body.operationName ?? '', data, { status: 200 });
    },
  };

  const out = (await tool('loom_list_notifications').run({ cursor: 'cPREV', limit: 5 }, ctx)) as {
    count: number;
    unseenCount?: number;
    nextCursor: string | null;
    hasNextPage: boolean;
  };
  assert.equal(sent[0]?.operationName, 'GetCurrentUserNotifications');
  assert.equal(sent[0]?.variables?.cursor, 'cPREV', 'the caller\'s cursor reaches the request');
  assert.equal(sent[0]?.variables?.first, 5);
  assert.equal(out.count, 1);
  assert.equal(out.nextCursor, 'cNEXT');
  assert.equal(out.hasNextPage, true);
  assert.equal(out.unseenCount, 3);
});

test('a tool run without a host context refuses rather than fetching directly', async () => {
  // A bare fetch would send the live session cookie past the replay rails, the
  // budget and the capture store. There is deliberately no such fallback.
  await assert.rejects(tool('loom_list_videos').run({}, undefined), /replay pipeline/);
});
