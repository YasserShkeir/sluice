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
import type { Capture, Session } from '@sluice/core';
import {
  classifyLoomCapture,
  graphqlOperationOf,
  loomApp,
  matchesLoom,
  parseLoomCapture,
  parseVtt,
} from './index.js';

const VID = 'f80e3bad896845c4a395c5a07646c2eb';

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
        { cursor: 'Y3Vyc29yOjA=', node: { id: VID, name: 'DigitalOcean walkthrough', visibility: 'owner', createdAt: '2026-05-07T03:46:15.476Z' } },
        { cursor: 'Y3Vyc29yOjE=', node: { id: '76a66473ad3f4f939d9e6a13a80ac926', name: 'Documentation Overview', visibility: 'owner' } },
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
  assert.deepEqual(ids, [VID, '76a66473ad3f4f939d9e6a13a80ac926']);
  // createdAt is normalized to epoch ms; the second video (no createdAt) → 0.
  assert.equal(result.items?.[0]?.ts, Date.parse('2026-05-07T03:46:15.476Z'));
  assert.equal(result.items?.[1]?.ts, 0);
  assert.equal(result.items?.[0]?.text, 'DigitalOcean walkthrough');
  assert.equal(result.items?.[0]?.containerId, 'loom:videos');
  // provenance survives: the item points back at the capture it came from.
  assert.deepEqual(result.items?.[0]?.sourceCaptureIds, [cap.id]);
});

test('parse: getVideo (single video) → one item', () => {
  const result = parseLoomCapture(loomGraphql('GetVideoCardDetails', { video: { id: VID, name: 'Solo', createdAt: '2025-11-01T14:01:24.292Z' } }));
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
    loomGraphql('GetVideoCardDetails', { video: { id: VID, name: 'Solo', createdAt: '2025-11-01T14:01:24.292Z' } }),
    loomGraphql('GetCurrentUserNotifications', { currentUser: { notification: { notificationConnection: { edges: [] } } } }),
    makeCapture({ host: 'cdn.loom.com', path: '/assets/js/app.js', resBody: '(function(){})()' }),
  ],
});
