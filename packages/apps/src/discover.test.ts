// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * External-adapter discovery. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * Nothing here imports from disk: `load` is injected, so a test can hand back a
 * hostile module without a fixture package existing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { App } from '@sluice/core';
import { checkConformance } from '@sluice/adapter-sdk';
import { apps } from './index.js';
import {
  describeDiscovery,
  discoverAdapters,
  externalConfigPath,
  looksLikeApp,
  readExternalSpecifiers,
  resolveSpecifier,
} from './discover.js';

/** The smallest thing that passes the structural gate. */
function fakeApp(over: Partial<App> = {}): App {
  return {
    id: 'demo',
    displayName: 'Demo',
    hosts: ['demo.test'],
    matchRequest: () => false,
    parse: () => ({}),
    listReplayActions: () => [],
    buildReplayRequest: () => ({ method: 'GET', url: 'https://demo.test/', headers: {} }),
    ...over,
  } as App;
}

function configWith(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sluice-discover-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

// ── The security posture ─────────────────────────────────────────────────────────

test('nothing is loaded unless a config names it', async () => {
  // The whole design. A name-pattern scan of node_modules would make "install a
  // package" and "hand it your session cookies" the same action.
  const r = await discoverAdapters({
    configPath: configWith({ proxyPort: 8080 }),
    load: async () => assert.fail('nothing should be imported'),
  });
  assert.deepEqual(r.loaded, []);
  assert.deepEqual(r.rejected, []);
});

test('the config is read from the HOME path, not from the working directory', () => {
  // `loadConfig` walks up from the CWD before falling back to home, which is
  // right for proxyPort and wrong for this: a repo you cloned could ship a
  // `sluice.config.json`, and running sluice inside it would load whatever that
  // file named — auto-discovery again, wearing a config file.
  const path = externalConfigPath('/home/someone');
  assert.equal(path, '/home/someone/.sluice/config.json');
  assert.ok(!path.includes(process.cwd()), 'never relative to where sluice was run');
});

test('an external adapter may not take a built-in id', async () => {
  // Registration order decides who parses what, and the store keys entities by
  // adapter id. An external `slack` would silently become the parser for every
  // Slack capture already in the store.
  const r = await discoverAdapters({
    configPath: configWith({ externalAdapters: ['evil'] }),
    taken: new Set(['slack']),
    load: async () => ({ default: fakeApp({ id: 'slack' }) }),
  });
  assert.deepEqual(r.loaded, []);
  assert.match(r.rejected[0]?.reason ?? '', /already registered/);
});

test('two external adapters cannot claim the same id either', async () => {
  const r = await discoverAdapters({
    configPath: configWith({ externalAdapters: ['a', 'b'] }),
    load: async () => ({ default: fakeApp({ id: 'same' }) }),
  });
  assert.equal(r.loaded.length, 1, 'the first one wins');
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]?.reason ?? '', /already registered/);
});

test('a failed conformance check rejects the adapter', async () => {
  const r = await discoverAdapters({
    configPath: configWith({ externalAdapters: ['sloppy'] }),
    load: async () => ({ default: fakeApp() }),
    check: () => ['parse threw on a hostile body', 'claims a lookalike host'],
  });
  assert.deepEqual(r.loaded, []);
  assert.match(r.rejected[0]?.reason ?? '', /failed conformance: parse threw.*lookalike/s);
});

test('the hosts an external adapter adds are disclosed, not just counted', () => {
  // Loading one WIDENS what the proxy decrypts, which is the most
  // privacy-relevant thing it does. A count would let that pass unread.
  const lines = describeDiscovery({
    loaded: [
      { specifier: '~/adapters/x.js', app: fakeApp({ id: 'x', hosts: ['a.test', 'b.test'] }), hosts: ['a.test', 'b.test'] },
    ],
    rejected: [{ specifier: 'y', reason: 'could not be imported: ENOENT' }],
  });
  assert.match(lines[0] ?? '', /decrypting a\.test, b\.test/);
  assert.match(lines[1] ?? '', /REJECTED: could not be imported/);
});

// ── Robustness ───────────────────────────────────────────────────────────────────

test('a malformed config does not stop Sluice starting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sluice-discover-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, '{not json');
  assert.deepEqual(readExternalSpecifiers(path).specifiers, []);
  const r = await discoverAdapters({ configPath: path });
  assert.deepEqual(r.loaded, []);
});

test('a config whose externalAdapters is the wrong shape yields nothing', async () => {
  for (const value of ['a-string', 42, { a: 1 }, null]) {
    assert.deepEqual(readExternalSpecifiers(configWith({ externalAdapters: value })).specifiers, []);
  }
  // …and non-string entries inside a real array are dropped rather than imported.
  assert.deepEqual(
    readExternalSpecifiers(configWith({ externalAdapters: ['ok', 7, null, '', '  '] })).specifiers,
    ['ok'],
  );
});

test('a module that throws on import is a rejection, not a crash', async () => {
  const r = await discoverAdapters({
    configPath: configWith({ externalAdapters: ['boom'] }),
    load: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.match(r.rejected[0]?.reason ?? '', /could not be imported: ENOENT/);
});

test('a module that is not an adapter is rejected by shape', async () => {
  // The failure this prevents is ugly: an object missing `matchRequest` reaches
  // the ingest funnel and throws on the FIRST capture, so the symptom is capture
  // dying rather than loading failing.
  for (const mod of [{}, { default: {} }, { default: { id: 'x' } }, null, 'nope', { default: fakeApp({ matchRequest: undefined as never }) }]) {
    const r = await discoverAdapters({
      configPath: configWith({ externalAdapters: ['x'] }),
      load: async () => mod,
    });
    assert.equal(r.loaded.length, 0, JSON.stringify(mod));
    assert.match(r.rejected[0]?.reason ?? '', /exported no Sluice app/);
  }
});

test('the app is taken from `default` or a named `app`, and nothing else is guessed', async () => {
  const viaDefault = await discoverAdapters({
    configPath: configWith({ externalAdapters: ['a'] }),
    load: async () => ({ default: fakeApp({ id: 'viaDefault' }) }),
  });
  assert.equal(viaDefault.loaded[0]?.app.id, 'viaDefault');

  const viaNamed = await discoverAdapters({
    configPath: configWith({ externalAdapters: ['a'] }),
    load: async () => ({ app: fakeApp({ id: 'viaNamed' }) }),
  });
  assert.equal(viaNamed.loaded[0]?.app.id, 'viaNamed');

  const viaSomethingElse = await discoverAdapters({
    configPath: configWith({ externalAdapters: ['a'] }),
    load: async () => ({ myAdapter: fakeApp({ id: 'nope' }) }),
  });
  assert.equal(viaSomethingElse.loaded.length, 0, 'an arbitrary export name is not searched');
});

test('looksLikeApp rejects the near misses', () => {
  assert.equal(looksLikeApp(fakeApp()), true);
  assert.equal(looksLikeApp(fakeApp({ id: '' })), false, 'an empty id collides with nothing safely');
  assert.equal(looksLikeApp(fakeApp({ hosts: [1 as never] })), false, 'hosts seed the TLS list');
  assert.equal(looksLikeApp({ ...fakeApp(), parse: 'yes' }), false);
});

test('every shipped adapter passes the check an external one must pass', () => {
  // The loader's gate has to agree with the adapters that already ship, or it is
  // a second standard nobody meets — and the first external author to hit it
  // would have no way to tell a real defect from Sluice being wrong.
  for (const app of apps) {
    assert.deepEqual(checkConformance(app), [], `${app.id} must clear its own bar`);
  }
});

// ── Specifier resolution ─────────────────────────────────────────────────────────

test('a path specifier is resolved against the user, not against the bundle', () => {
  // The shipped artifact is an esbuild bundle, so a relative `import()` resolves
  // against the bundle's own location — meaning the same config entry would mean
  // different files depending on how Sluice was installed.
  assert.equal(resolveSpecifier('~/adapters/x.js', '/home/me'), 'file:///home/me/adapters/x.js');
  assert.equal(resolveSpecifier('/opt/x.js'), 'file:///opt/x.js');
  // A package name is left alone — that is what Node's resolver is for.
  assert.equal(resolveSpecifier('sluice-adapter-notion'), 'sluice-adapter-notion');
  assert.equal(resolveSpecifier('@acme/sluice-adapter'), '@acme/sluice-adapter');
});
