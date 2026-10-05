// SPDX-License-Identifier: Apache-2.0
/**
 * The conformance harness run over a small well-behaved app, plus the one
 * property of the module itself that matters at runtime. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import type { App } from '@sluice/core';
import { runConformance } from './conformance.js';

test('conformance.ts has no static node:test import, so the barrel stays runtime-safe', () => {
  // The barrel re-exports runConformance, so a static import put node:test into
  // every runtime import of the SDK and into both shipped bundles.
  const src = readFileSync(new URL('./conformance.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import (?!type )[^;]*['"]node:test['"]/m);
});

/** Every (hook, host, path) the hostile probes drove, to prove the generator covers them all. */
const seen = { parse: new Set<string>(), classify: new Set<string>(), nextCursors: new Set<string>() };

const demo: App = {
  id: 'demo',
  displayName: 'Demo',
  hosts: ['demo.test'],
  matchRequest: (i) => i.host === 'demo.test' || i.host.endsWith('.demo.test'),
  parse: (c) => {
    seen.parse.add(`${c.host}${c.path}`);
    return {};
  },
  classify: (c) => {
    seen.classify.add(`${c.host}${c.path}`);
    return { class: 'structure' };
  },
  nextCursors: (c) => {
    seen.nextCursors.add(`${c.host}${c.path}`);
    return [];
  },
  listReplayActions: () => [
    {
      id: 'demo.items',
      adapterId: 'demo',
      label: 'Items',
      method: 'GET',
      urlTemplate: 'https://demo.test/api/items',
      params: [],
    },
  ],
  buildReplayRequest: () => ({ method: 'GET', url: 'https://demo.test/api/items', headers: {} }),
} as App;

runConformance(demo);

after(() => {
  for (const [hook, keys] of Object.entries(seen)) {
    for (const key of [
      'demo.test/api/items',
      'unrelated.test/api/items',
      'demo.test/api/__proto__',
      'unrelated.test/',
    ]) {
      assert.ok(keys.has(key), `${hook} was never probed at ${key}`);
    }
  }
});
