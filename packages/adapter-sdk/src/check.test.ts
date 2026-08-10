// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The load-time conformance subset. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from '@sluice/core';
import { checkConformance } from './check.js';

const base = (over: Partial<App> = {}): App =>
  ({
    id: 'demo',
    displayName: 'Demo',
    hosts: ['demo.test'],
    matchRequest: (i) => i.host === 'demo.test',
    parse: () => ({}),
    listReplayActions: () => [],
    buildReplayRequest: () => ({ method: 'GET', url: 'https://demo.test/', headers: {} }),
    ...over,
  }) as App;

test('a well-behaved adapter passes', () => {
  assert.deepEqual(checkConformance(base()), []);
});

test('a parse that throws is caught rather than allowed near the ingest funnel', () => {
  // `parse` runs on every capture. A throw there does not fail one capture — it
  // poisons the pipeline, which is why the contract forbids it.
  const problems = checkConformance(
    base({
      parse: (c) => {
        // The classic: index into a body without checking it is there.
        return JSON.parse(c.resBody as string) as Record<string, never>;
      },
    }),
  );
  assert.ok(problems.length > 0);
  assert.match(problems.join('\n'), /parse threw/);
});

test('a parse returning the wrong shape is caught', () => {
  // An array is an object to `typeof`, so it used to slip through here and then
  // store nothing — an adapter that looks like it simply found no entities.
  assert.match(checkConformance(base({ parse: () => [] as never })).join('\n'), /returned an array/);
  assert.match(
    checkConformance(base({ parse: () => ({ items: 'nope' }) as never })).join('\n'),
    /non-array items/,
  );
  assert.match(checkConformance(base({ parse: () => null as never })).join('\n'), /must return a ParseResult/);
});

test('a malformed hosts declaration is caught, because hosts is the TLS scope', () => {
  assert.match(checkConformance(base({ hosts: [] })).join('\n'), /hosts is empty/);
  assert.match(checkConformance(base({ hosts: ['HTTPS://X.TEST'] })).join('\n'), /URL, not a bare hostname/);
  assert.match(checkConformance(base({ hosts: ['Mail.Google.com'] })).join('\n'), /lowercase/);
});

test('classify and nextCursors are held to the same never-throws rule', () => {
  assert.match(
    checkConformance(base({ classify: () => { throw new Error('boom'); } })).join('\n'),
    /classify threw/,
  );
  assert.match(
    checkConformance(base({ nextCursors: () => { throw new Error('boom'); } })).join('\n'),
    /nextCursors threw/,
  );
});

test('the checker itself never throws, whatever it is handed', () => {
  // It runs while deciding whether to TRUST something. A checker that dies on
  // its input has failed at the one job it had.
  for (const evil of [
    base({ matchRequest: () => { throw new Error('x'); } }),
    base({ listReplayActions: () => { throw new Error('x'); } }),
    base({ hosts: [null as never] }),
    { id: 'x' } as App,
  ]) {
    assert.doesNotThrow(() => checkConformance(evil));
  }
});
