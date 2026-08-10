// SPDX-License-Identifier: Apache-2.0
/**
 * The conformance harness every adapter must pass.
 *
 * These invariants were already being tested — just not by everyone, and not the
 * same way twice. "parse never throws" was pinned in app-fast and app-trello but
 * not app-slack; "matchRequest rejects a lookalike host" was pinned in all three
 * with a different bogus host each time. An invariant asserted in two packages
 * out of three is not an invariant, it is a coincidence.
 *
 * Running these is a build-time obligation, not a suggestion: `@sluice/apps`
 * runs the whole suite over every registered app, so a new adapter cannot be
 * added to the registry without satisfying them.
 *
 * Uses node:test directly so it drops into the existing
 * `node --import tsx --test src/*.test.ts` runner with no new dependency.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { App, Capture, CursorSeed, Session } from '@sluice/core';
import { makeCapture } from './fixtures.js';

/**
 * Paths that a hook must survive.
 *
 * The prototype keys are not paranoia. An adapter that routes on a path segment
 * with a plain object literal — `ROUTES[method]` — gets `Object.prototype` back
 * for `__proto__` and a function for `toString`, both truthy, and then reads a
 * field off them. That is a TypeError out of a hook contractually forbidden from
 * throwing, and it shipped: an earlier version of this list held only
 * `/api/test`, so nothing varied the path and nothing caught it.
 */
const HOSTILE_PATHS = [
  '/',
  '/api/test',
  '/api/__proto__',
  '/api/constructor',
  '/api/toString',
  '/api/hasOwnProperty',
  '/1/__proto__/cards',
  `/api/${'x'.repeat(300)}`,
  '/api/%2e%2e%2f',
  '/api/a.b.c.d',
];

/** Bodies that a parser must survive. Each one has broken a real parser. */
const HOSTILE_BODIES: Array<[label: string, body: string | null]> = [
  ['null', null],
  ['empty', ''],
  ['truncated json', '{"ok":true,"channels":['],
  ['not json at all', '<!DOCTYPE html><html><body>502 Bad Gateway'],
  ['json but an array', '[1,2,3]'],
  ['json but a scalar', '"just a string"'],
  ['json null', 'null'],
  ['an object of nulls', '{"channels":null,"members":null,"messages":null}'],
  ['wrong types throughout', '{"channels":[{"id":123,"name":[],"is_private":"yes"}]}'],
  ['deeply nested empties', '{"data":{"items":[{},{},{}]}}'],
  // A field the adapter expects to be an array, sent as an object. Real APIs do
  // this (a map keyed by index), and `?? []` does not save you — the value is
  // present, just not iterable.
  ['array field sent as an object', '{"targets":{"0":{"url":"https://x/"}},"members":{"a":1}}'],
  ['prototype keys in the payload', '{"__proto__":{"polluted":true},"constructor":{"x":1}}'],
  // SUCCESS-shaped. Without one of these, every "did it throw?" probe stops at
  // the adapter's own `ok === false` / shape guard and the code past it is never
  // reached — which is precisely how a throw in the pagination path survived.
  ['a successful paged response', '{"ok":true,"has_more":true,"response_metadata":{"next_cursor":"abc"}}'],
  ['a successful empty response', '{"ok":true}'],
];

/**
 * The adapter's OWN endpoints, taken from its replay actions.
 *
 * Generic hostile paths never reach an adapter's real code: every parser opens
 * with a guard on the endpoint it recognises, so `/api/test` is rejected on line
 * one and everything past it stays unexercised. The replay actions are the one
 * place an adapter already declares its real URLs, so they double as the paths
 * these probes must drive.
 */
function ownPaths(app: App): string[] {
  const out = new Set<string>();
  for (const action of app.listReplayActions()) {
    try {
      out.add(new URL(action.urlTemplate).pathname);
    } catch {
      /* a template that is not a URL is caught by its own test below */
    }
  }
  return [...out];
}

export interface ConformanceOptions {
  /**
   * A session for this adapter, to exercise buildReplayRequest. Omit and the
   * replay checks are skipped — an adapter with no credential seam is legitimate
   * (fast.com has none).
   */
  session?: Session;
  /**
   * Real captures from this service. Anything supplied gets the same
   * never-throws treatment as the hostile bodies, plus the entity-ownership
   * checks, which only bite on a capture that actually parses into something.
   */
  fixtures?: Capture[];
}

/**
 * Every rule a CursorSeed must obey, checked wherever seeds are produced.
 *
 * Hoisted out of the hostile-body loop because that loop alone made the checks
 * VACUOUS: hostile bodies produce no seeds for any real adapter, so the assertions
 * ran zero times and an adapter returning seeds addressed to another adapter, at
 * a non-existent action, with an empty cursor, passed cleanly. Verified — that
 * exact adapter passed before this was split out.
 */
function assertSeeds(app: App, seeds: readonly CursorSeed[], where: string): void {
  const actionIds = new Set(app.listReplayActions().map((a) => a.id));
  for (const s of seeds) {
    assert.equal(s.adapterId, app.id, `${where}: a seed must be addressed to its own adapter`);
    assert.ok(s.actionId.length > 0, `${where}: a seed needs an action id`);
    assert.ok(
      actionIds.has(s.actionId),
      `${where}: seed names action "${s.actionId}", which listReplayActions() does not offer`,
    );
    // An empty cursor means EXHAUSTED. Emitting one queues a page that re-fetches
    // page 1 forever.
    assert.notEqual(s.cursor, '', `${where}: an empty cursor means exhausted, never a page`);
  }
}

/**
 * Register the full conformance suite for one app. Call at module top level in
 * a `*.test.ts` file.
 */
export function runConformance(app: App, opts: ConformanceOptions = {}): void {
  const name = app.id;

  test(`[${name}] declares a non-empty id, displayName and hosts`, () => {
    assert.ok(app.id.length > 0, 'id is what attributes a capture to this app');
    assert.ok(app.displayName.length > 0);
    assert.ok(app.hosts.length > 0, 'hosts drives the proxy TLS-intercept list');
    for (const h of app.hosts) {
      assert.ok(h.length > 0 && !h.includes('/'), `host ${JSON.stringify(h)} must be a bare hostname`);
      assert.equal(h, h.toLowerCase(), 'hosts are compared case-insensitively elsewhere');
    }
  });

  test(`[${name}] matchRequest claims its own hosts`, () => {
    for (const host of app.hosts) {
      const claimed = app.matchRequest({
        host,
        path: '/',
        method: 'GET',
        url: `https://${host}/`,
      });
      // An adapter may legitimately require a path prefix (Slack wants /api/),
      // so a bare "/" need not match — but SOMETHING on its own host must.
      const withApiPath = app.matchRequest({
        host,
        path: '/api/test',
        method: 'GET',
        url: `https://${host}/api/test`,
      });
      assert.ok(claimed || withApiPath, `${name} claims ${host} but matched nothing on it`);
    }
  });

  test(`[${name}] matchRequest rejects lookalike hosts`, () => {
    // The invariant is that an adapter never claims a host in a DIFFERENT
    // registrable domain. A suffix match on 'slack.com' also accepts
    // 'slack.com.evil.test'; a substring match accepts 'slack.comevil.com'.
    //
    // Note what is NOT tested: a PREFIX like 'notslack.com'. Adapters must match
    // their own subdomains — a Slack workspace is served from acme.slack.com —
    // so 'notedgeapi.slack.com' is an ordinary workspace host that no correct
    // matcher can reject. An earlier version of this probe asserted otherwise and
    // pushed two adapters into narrowing their real host lists to satisfy it.
    for (const host of app.hosts) {
      const dashed = host.replace(/\./g, '-');
      for (const impostor of [
        `${host}.evil.test`,
        `${host}evil.com`,
        `${dashed}.evil.test`,
        'evil.test',
      ]) {
        assert.equal(
          app.matchRequest({
            host: impostor,
            path: '/api/test',
            method: 'GET',
            url: `https://${impostor}/api/test`,
          }),
          false,
          `${name} must not claim ${impostor}`,
        );
      }
    }
  });

  test(`[${name}] parse never throws`, () => {
    // parse() runs in the ingest funnel for EVERY capture, so a throw does not
    // lose one row — it takes down capture for every app at once.
    for (const [label, body] of HOSTILE_BODIES) {
      for (const host of [...app.hosts, 'unrelated.test']) {
        for (const path of [...HOSTILE_PATHS, ...ownPaths(app)]) {
          const capture = makeCapture({ host, path, url: `https://${host}${path}`, resBody: body, reqBody: body });
          assert.doesNotThrow(() => app.parse(capture), `parse threw on ${label} at ${path} from ${host}`);
        }
      }
    }
  });

  test(`[${name}] parse returns a well-formed ParseResult`, () => {
    for (const [, body] of HOSTILE_BODIES) {
      const result = app.parse(makeCapture({ host: app.hosts[0] ?? 'x', resBody: body }));
      assert.ok(result !== null && typeof result === 'object', 'parse must return an object');
      for (const key of ['workspaces', 'actors', 'containers', 'items', 'edges'] as const) {
        const value = result[key];
        if (value !== undefined) assert.ok(Array.isArray(value), `${key} must be an array or absent`);
      }
    }
  });

  test(`[${name}] classify never throws and names an operation`, { skip: !app.classify }, () => {
    const classify = app.classify;
    if (!classify) return;
    for (const [label, body] of HOSTILE_BODIES) {
      for (const host of [...app.hosts, 'unrelated.test']) {
        for (const path of [...HOSTILE_PATHS, ...ownPaths(app)]) {
          const capture = makeCapture({ host, path, url: `https://${host}${path}`, resBody: body });
          assert.doesNotThrow(() => classify(capture), `classify threw on ${label} at ${path}`);
          const got = classify(capture);
          assert.ok(got !== null && typeof got === 'object', 'classify must return an object');
          assert.ok(typeof got.class === 'string' && got.class.length > 0);
        }
      }
    }
  });

  test(`[${name}] nextCursors never throws and returns an array`, { skip: !app.nextCursors }, () => {
    const nextCursors = app.nextCursors;
    if (!nextCursors) return;
    for (const [label, body] of HOSTILE_BODIES) {
      for (const path of [...HOSTILE_PATHS, ...ownPaths(app)]) {
        for (const host of [...app.hosts, 'unrelated.test']) {
        const capture = makeCapture({ host, path, url: `https://${host}${path}`, resBody: body });
        assert.doesNotThrow(() => nextCursors(capture), `nextCursors threw on ${label} at ${path}`);
        const seeds = nextCursors(capture);
        assert.ok(Array.isArray(seeds), 'nextCursors must return an array — [] is a fine answer');
        assertSeeds(app, seeds, `${label} at ${path}`);
        }
      }
    }
    // And over the real fixtures, which are the only inputs that actually
    // PRODUCE seeds — see assertSeeds for why that distinction mattered.
    for (const capture of opts.fixtures ?? []) {
      assert.doesNotThrow(() => nextCursors(capture), `nextCursors threw on fixture ${capture.path}`);
      assertSeeds(app, nextCursors(capture), `fixture ${capture.path}`);
    }
  });

  test(`[${name}] every emitted entity is owned by this adapter`, () => {
    for (const capture of opts.fixtures ?? []) {
      const r = app.parse(capture);
      for (const e of [...(r.workspaces ?? []), ...(r.actors ?? []), ...(r.containers ?? []), ...(r.items ?? [])]) {
        assert.equal(e.adapterId, app.id, 'an entity attributed to another adapter corrupts the store');
        assert.ok(e.id.length > 0, 'an empty id upserts onto whatever else has one');
      }
      for (const edge of r.edges ?? []) {
        assert.equal(edge.adapterId, app.id);
        assert.ok(edge.srcId.length > 0 && edge.dstId.length > 0);
      }
    }
  });

  test(`[${name}] replay actions are well-formed and uniquely named`, () => {
    const actions = app.listReplayActions();
    assert.ok(Array.isArray(actions));
    const ids = new Set<string>();
    for (const a of actions) {
      assert.equal(a.adapterId, app.id);
      assert.ok(!ids.has(a.id), `duplicate replay action id ${a.id}`);
      ids.add(a.id);
      assert.ok(a.id.startsWith(`${app.id}.`), `${a.id} must be namespaced under the adapter id`);
      assert.ok(a.urlTemplate.startsWith('https://'), 'replay must never fall back to plaintext http');
      const names = new Set<string>();
      for (const p of a.params) {
        assert.ok(!names.has(p.name), `duplicate param ${p.name} on ${a.id}`);
        names.add(p.name);
      }
    }
  });

  const session = opts.session;
  test(`[${name}] buildReplayRequest resolves secrets by value, never by key name`, { skip: !session }, () => {
    if (!session) return;
    // The regression: `injection.cookies` maps a cookie NAME to the KEY in
    // `values` holding its secret. Reading it literally emits the string
    // 'cookieD' as the cookie VALUE — a request that looks correct and is
    // unauthenticated.
    const keyNames = Object.keys(session.credentials.values);
    for (const action of app.listReplayActions()) {
      const params: Record<string, string> = {};
      for (const p of action.params) params[p.name] = p.default ?? 'x';
      const req = app.buildReplayRequest(action, params, session);

      assert.ok(req.url.startsWith('https://'), 'replay must never downgrade to http');
      const wire = `${JSON.stringify(req.headers)}\n${req.body ?? ''}`;
      for (const key of keyNames) {
        const value = session.credentials.values[key];
        // The key name may only appear where it is a legitimate wire name
        // (a form field literally called `token`); it must never appear as a
        // stand-in for the secret it points at.
        if (value !== undefined && wire.includes(key) && !wire.includes(value)) {
          assert.fail(`${action.id} emitted the injection KEY "${key}" instead of its value`);
        }
      }
    }
  });

  test(`[${name}] credential hints never carry a usable secret`, { skip: !app.extractCredentialHints }, () => {
    const extract = app.extractCredentialHints;
    if (!extract) return;
    for (const capture of opts.fixtures ?? []) {
      for (const hint of extract(capture)) {
        assert.ok(hint.confidence >= 0 && hint.confidence <= 1, 'confidence is a 0..1 probability');
        assert.ok(hint.valuePreview.length <= 64, 'a preview long enough to use is not a preview');
      }
    }
  });
}
