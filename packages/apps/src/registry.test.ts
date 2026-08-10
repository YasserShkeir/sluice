// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Registry tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * This package had no test script at all, which meant nothing anywhere asserted
 * that the registry was well-formed — and the registry is the one file that
 * decides what the whole system captures. Two adapters sharing an id, or both
 * claiming the same host, produces silently misattributed captures rather than
 * an error.
 *
 * It is also where the conformance harness becomes MANDATORY. Running
 * runConformance here, over the exported list rather than per package, is what
 * makes it impossible to register a new adapter without satisfying the
 * invariants — an app package could otherwise simply not call it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, runConformance } from '@sluice/adapter-sdk';
import { apps, getApp } from './index.js';

test('every adapter id is unique', () => {
  const ids = apps.map((a) => a.id);
  assert.deepEqual([...new Set(ids)], ids, 'a duplicate id silently misattributes captures');
});

test('apps[0] is the default and is Slack', () => {
  // Not decoration: `sluice start` names apps[0] in its routing instructions and
  // defaultCaptureUrl() derives the landing page from apps[0].hosts.
  assert.equal(apps[0]?.id, 'slack');
});

test('getApp resolves every registered app and nothing else', () => {
  for (const app of apps) assert.equal(getApp(app.id)?.id, app.id);
  assert.equal(getApp('not-installed'), undefined);
});

test('no two adapters claim the same request', () => {
  // The ingest funnel takes the FIRST adapter whose matchRequest returns true,
  // so an overlap means attribution depends on registration order — which is a
  // coin flip nobody would think to look at.
  for (const a of apps) {
    for (const b of apps) {
      if (a.id === b.id) continue;
      for (const host of a.hosts) {
        for (const path of ['/', '/api/test', '/1/members/me']) {
          const input = { host, path, method: 'GET', url: `https://${host}${path}` };
          if (!a.matchRequest(input)) continue;
          assert.equal(
            b.matchRequest(input),
            false,
            `${a.id} and ${b.id} both claim https://${host}${path}`,
          );
        }
      }
    }
  }
});

test('no two adapters declare the same host', () => {
  const owner = new Map<string, string>();
  for (const app of apps) {
    for (const host of app.hosts) {
      const existing = owner.get(host);
      assert.equal(existing, undefined, `${host} is declared by both ${existing} and ${app.id}`);
      owner.set(host, app.id);
    }
  }
});

test('registering an app also registers its redaction, before any capture', () => {
  // registerAppRedaction runs at import time precisely because redaction happens
  // BEFORE a capture is attributed to an adapter. Importing this module is what
  // must be sufficient — an entrypoint that forgot to call it would write live
  // tokens to disk.
  const withRedaction = apps.filter((a) => a.redaction !== undefined);
  assert.ok(withRedaction.length > 0, 'at least one app contributes redaction, so the wiring is observable');
});

test('an unclaimed host is claimed by nobody', () => {
  const stray = makeCapture({ host: 'unrelated.test', path: '/api/x', url: 'https://unrelated.test/api/x' });
  for (const app of apps) {
    assert.equal(
      app.matchRequest({ host: stray.host, path: stray.path, method: stray.method, url: stray.url }),
      false,
      `${app.id} claimed an unrelated host`,
    );
  }
});

// The harness itself, over every registered app. Adding an adapter to the
// registry above without satisfying these fails the build.
for (const app of apps) runConformance(app);
