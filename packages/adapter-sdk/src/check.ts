// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The conformance checks that can run OUTSIDE a test runner.
 *
 * `runConformance` is the real harness and stays the real harness: it declares a
 * `node:test` case per property, which is what makes a failure name itself in
 * CI. That binding is also why it cannot be used at load time — calling it
 * outside a test runner registers tests nobody will run and reports nothing.
 *
 * So this is a SUBSET, and saying which subset matters. It covers the properties
 * whose violation breaks the process that loaded the adapter:
 *
 *   - a malformed declaration, where `hosts` seeds the proxy's TLS-intercept
 *     list and a bad entry either widens it or breaks it;
 *   - `parse` / `classify` / `nextCursors` throwing, which they are contractually
 *     forbidden to do because they run inside the ingest funnel — a throw there
 *     does not fail one capture, it poisons the pipeline;
 *   - a `ParseResult` of the wrong shape, which reaches the store.
 *
 * It does NOT cover host-claim coverage, replay-action wiring or seed
 * addressing — those need fixtures and a session, and their failure is a wrong
 * answer rather than a broken runner.
 *
 * None of this is a security boundary and it must not be presented as one. It
 * proves an adapter is not BROKEN — it does not throw on hostile input and does
 * not claim lookalike hosts. Trust still comes from naming the adapter yourself,
 * and from the hosts it adds being disclosed rather than assumed.
 */
import { errorMessage } from '@sluice/core';
import type { App } from '@sluice/core';
import { makeCapture } from './fixtures.js';

/**
 * Paths chosen to break a parser that indexes without checking: prototype
 * pollution vectors, traversal, an empty path, and one that is merely long.
 */
const HOSTILE_PATHS = [
  '/',
  '',
  '/__proto__',
  '/constructor/prototype',
  '/../../etc/passwd',
  `/${'a'.repeat(2048)}`,
];

/** Bodies that are valid JSON, invalid JSON, or not text at all. */
const HOSTILE_BODIES: Array<string | null> = [
  null,
  '',
  'null',
  '[]',
  '{}',
  '{"ok":false}',
  '[[[[[[[[[[]]]]]]]]]]',
  '{"__proto__":{"polluted":true}}',
  ')]}\'\n[0,null]',
  'not json at all',
  // Escaped control bytes (not raw) so diffs stay readable.
  '\u0000\u0001\u0002binary',
  '\u0000\u0001\u0002',
];

/**
 * Check an app, returning one string per problem. Empty means it passed.
 *
 * Never throws: this runs while deciding whether to trust something, and a
 * checker that dies on the input it was given has failed at the one job it had.
 */
export function checkConformance(app: App): string[] {
  const problems: string[] = [];
  const note = (s: string): void => {
    problems.push(s);
  };

  // ── the declaration ──────────────────────────────────────────────────────────
  if (typeof app.id !== 'string' || app.id.length === 0) note('id is empty');
  if (typeof app.displayName !== 'string' || app.displayName.length === 0) {
    note('displayName is empty');
  }
  if (!Array.isArray(app.hosts) || app.hosts.length === 0) {
    note('hosts is empty — it is what drives the proxy TLS-intercept list');
  } else {
    for (const h of app.hosts) {
      if (typeof h !== 'string' || h.length === 0) note(`host ${JSON.stringify(h)} is not a hostname`);
      else if (h.includes('/')) note(`host ${JSON.stringify(h)} looks like a URL, not a bare hostname`);
      else if (h !== h.toLowerCase()) note(`host ${JSON.stringify(h)} must be lowercase`);
    }
  }

  // ── the hooks that run inside the ingest funnel ──────────────────────────────
  const hosts = (Array.isArray(app.hosts) ? app.hosts : []).filter(
    (h): h is string => typeof h === 'string' && h.length > 0,
  );
  // A host it does NOT claim as well, because every capture is offered to every
  // adapter's matchRequest before one of them takes it.
  for (const host of [...hosts, 'unclaimed.example.test']) {
    for (const path of HOSTILE_PATHS) {
      for (const body of HOSTILE_BODIES) {
        const capture = makeCapture({ host, path, url: `https://${host}${path}`, resBody: body });
        const where = `${host}${path} with body ${JSON.stringify(body)?.slice(0, 24)}`;

        if (throws(() => app.matchRequest(capture))) note(`matchRequest threw on ${where}`);
        const parsed = capture$(() => app.parse(capture));
        if (parsed.threw) {
          note(`parse threw on ${where}: ${parsed.why}`);
        } else if (
          parsed.value === null ||
          typeof parsed.value !== 'object' ||
          // An array is an object to `typeof`, and is not a ParseResult. It
          // reaches `applyParseResult`, which reads five named fields off it,
          // finds none, and stores nothing — so the adapter silently produces
          // no entities and looks like it simply had nothing to say.
          Array.isArray(parsed.value)
        ) {
          note(
            `parse returned ${Array.isArray(parsed.value) ? 'an array' : String(parsed.value)} on ${where} — it must return a ParseResult object`,
          );
        } else {
          for (const key of ['workspaces', 'actors', 'containers', 'items', 'edges'] as const) {
            const v = (parsed.value as Record<string, unknown>)[key];
            if (v !== undefined && !Array.isArray(v)) note(`parse returned a non-array ${key}`);
          }
        }
        if (app.classify && throws(() => app.classify?.(capture))) note(`classify threw on ${where}`);
        if (app.nextCursors) {
          const seeds = capture$(() => app.nextCursors?.(capture));
          if (seeds.threw) note(`nextCursors threw on ${where}: ${seeds.why}`);
          else if (seeds.value !== undefined && !Array.isArray(seeds.value)) {
            note('nextCursors returned a non-array');
          }
        }
        // One problem of each kind is enough to reject; a full matrix of
        // duplicates would bury the first real finding.
        if (problems.length > 12) return problems;
      }
    }
  }

  if (throws(() => app.listReplayActions())) note('listReplayActions threw');
  return problems;
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** Call and capture — the outcome as a value, so a throw is data rather than control flow. */
function capture$(fn: () => unknown): { threw: boolean; value?: unknown; why?: string } {
  try {
    return { threw: false, value: fn() };
  } catch (e) {
    return { threw: true, why: errorMessage(e) };
  }
}
