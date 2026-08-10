// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Refresh-and-retry tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The invariants here are all about NOT doing too much. Re-extraction re-enters
 * the OS consent boundary and can raise a Keychain prompt; the replay budget is
 * a process-global 60-per-60s bucket that a sync run already draws N times per
 * session. So "retries once, only when it would help, and never in a loop" is
 * the property, not "retries".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Capture, ReplayRequest, Session } from '@sluice/core';
import { ReplayDeniedError } from './replay-policy.js';
import { replayWithRefresh } from './replay-refresh.js';

function session(label: string): Session {
  return {
    id: label,
    adapterId: 'slack',
    label,
    credentials: { kind: 'slack-session', values: { token: `tok-${label}` }, injection: {} },
    discoveredAt: 0,
    source: 'local-store',
  };
}

function capture(status: number | null, resBody: string | null = null): Capture {
  return {
    id: `cap-${status}-${resBody ?? ''}`,
    ts: 1_700_000_000_000,
    source: 'replay',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/x',
    host: 'slack.com',
    path: '/api/x',
    status,
    durationMs: 1,
    reqHeaders: {},
    reqBody: null,
    resHeaders: {},
    resBody,
  };
}

/** A harness that records what happened, so the assertions are about behaviour. */
function harness(responses: Capture[], opts: { refresh?: () => Promise<Session | undefined> } = {}) {
  const built: string[] = [];
  const recorded: Capture[] = [];
  let refreshes = 0;
  return {
    built,
    recorded,
    get refreshes() {
      return refreshes;
    },
    io: {
      build: (s: Session): ReplayRequest => {
        built.push(s.label);
        return { method: 'POST', url: 'https://slack.com/api/x', headers: { token: s.credentials.values.token ?? '' } };
      },
      run: async (): Promise<Capture> => responses.shift() ?? capture(200, '{"ok":true}'),
      record: (c: Capture) => recorded.push(c),
      refresh:
        opts.refresh === undefined
          ? undefined
          : async () => {
              refreshes += 1;
              return opts.refresh?.();
            },
    },
  };
}

test('a successful call does not refresh anything', async () => {
  const h = harness([capture(200, '{"ok":true}')], { refresh: async () => session('fresh') });
  const out = await replayWithRefresh(session('stale'), h.io);
  assert.equal(out.status, 200);
  assert.equal(h.refreshes, 0, 'a working session must never trigger a Keychain prompt');
  assert.deepEqual(h.built, ['stale']);
});

test('a 401 refreshes and retries exactly once', async () => {
  const h = harness([capture(401), capture(200, '{"ok":true}')], { refresh: async () => session('fresh') });
  const out = await replayWithRefresh(session('stale'), h.io);
  assert.equal(out.status, 200);
  assert.equal(h.refreshes, 1);
  assert.deepEqual(h.built, ['stale', 'fresh'], 'the retry must rebuild from the FRESH session');
});

test("Slack's HTTP 200 expiry triggers the retry too", async () => {
  const h = harness([capture(200, '{"ok":false,"error":"not_authed"}'), capture(200, '{"ok":true}')], {
    refresh: async () => session('fresh'),
  });
  const out = await replayWithRefresh(session('stale'), h.io);
  assert.equal(out.resBody, '{"ok":true}');
  assert.equal(h.refreshes, 1);
});

test('the retry rebuilds the request rather than reusing the stale one', async () => {
  // Reusing the first request resends the DEAD credential, gets the same 401,
  // and looks exactly like the refresh not working.
  const h = harness([capture(401), capture(200, '{"ok":true}')], { refresh: async () => session('fresh') });
  await replayWithRefresh(session('stale'), h.io);
  assert.equal(h.built.length, 2);
  assert.notEqual(h.built[0], h.built[1]);
});

test('it retries once and then stops, even if the retry also fails', async () => {
  // A loop here is a rate-limit trip mid-sync AND a Keychain prompt storm.
  const h = harness([capture(401), capture(401), capture(200)], { refresh: async () => session('fresh') });
  const out = await replayWithRefresh(session('stale'), h.io);
  assert.equal(out.status, 401, 'the second failure is the answer, not a third attempt');
  assert.equal(h.refreshes, 1);
  assert.equal(h.built.length, 2);
});

test('an app with no refresh mechanism never retries', async () => {
  // fast.com replays with a synthetic empty session; there is nothing to
  // re-extract and no prompt worth raising.
  const h = harness([capture(401), capture(200)]);
  const out = await replayWithRefresh(session('stale'), h.io);
  assert.equal(out.status, 401);
  assert.equal(h.built.length, 1);
});

test('a refresh that finds no session leaves the original failure intact', async () => {
  const h = harness([capture(401), capture(200)], { refresh: async () => undefined });
  const out = await replayWithRefresh(session('stale'), h.io);
  assert.equal(out.status, 401);
  assert.equal(h.built.length, 1);
});

test('a refresh that throws does not replace the auth failure with its own error', async () => {
  // "could not read the keychain" would hide what actually went wrong.
  const h = harness([capture(401)], {
    refresh: async () => {
      throw new Error('keychain denied');
    },
  });
  const out = await replayWithRefresh(session('stale'), h.io);
  assert.equal(out.status, 401);
});

test('BOTH attempts are recorded, failure first', async () => {
  // The failed attempt is the evidence that makes "the session expired at 14:03"
  // answerable later. Dropping it to keep the audit trail tidy is backwards.
  const h = harness([capture(401), capture(200, '{"ok":true}')], { refresh: async () => session('fresh') });
  await replayWithRefresh(session('stale'), h.io);
  assert.equal(h.recorded.length, 2);
  assert.equal(h.recorded[0]?.status, 401);
  assert.equal(h.recorded[1]?.status, 200);
});

test('a policy refusal on the retry surfaces as itself, not as the 401', async () => {
  const h = harness([capture(401)], { refresh: async () => session('fresh') });
  let calls = 0;
  h.io.run = async (): Promise<Capture> => {
    calls += 1;
    if (calls === 1) return capture(401);
    throw new ReplayDeniedError('rate_budget_exhausted', 'budget spent');
  };
  await assert.rejects(() => replayWithRefresh(session('stale'), h.io), ReplayDeniedError);
});

test('a network error on the retry falls back to the original failure', async () => {
  const h = harness([capture(401)], { refresh: async () => session('fresh') });
  let calls = 0;
  h.io.run = async (): Promise<Capture> => {
    calls += 1;
    if (calls === 1) return capture(401);
    throw new Error('ECONNRESET');
  };
  const out = await replayWithRefresh(session('stale'), h.io);
  assert.equal(out.status, 401, 'the auth failure is the more useful of the two');
});
