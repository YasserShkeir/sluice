// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TLS-scoping helpers for Engine A. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * `tlsInterceptList` builds the host patterns used when intercept is scoped.
 * Default product behaviour is all-hosts (MitmEngine omits tlsInterceptOnly);
 * these tests lock the list shape when scoping is on.
 *
 * The patterns are handed to mockttp, which compiles them with URLPattern, so
 * the semantics asserted below (a bare host does NOT match its own subdomains)
 * are URLPattern's, not ours.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import type { Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import type { Adapter } from '@sluice/core';
import { ensureSluiceCA } from './ca.js';
import {
  MitmEngine,
  NEVER_DECRYPT_HOSTS,
  guardProxyClients,
  isAllowedProxyClient,
  isCaDownloadPath,
  isLoopbackListenHost,
  mitmTlsScope,
  tlsInterceptList,
} from './mitm-engine.js';
import { loadMockttp } from './mockttp-loader.js';

// engine.start() mints/reads the root CA under homedir(), which reads $HOME on
// every call: keep that off the developer's real CA (and remove the key after).
const HOME = mkdtempSync(join(tmpdir(), 'sluice-mitm-test-'));
process.env.HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

function adapter(id: string, hosts: string[]): Adapter {
  return {
    id,
    displayName: id,
    hosts,
    matchRequest: () => false,
    parse: () => ({}),
    listReplayActions: () => [],
    buildReplayRequest: () => ({ method: 'GET', url: '', headers: {} }),
  };
}

const hostnames = (a: Adapter[], extra: string[] = []): string[] =>
  tlsInterceptList(a, extra).map((h) => h.hostname);

test('every adapter host contributes both the bare host and its subdomains', () => {
  const list = hostnames([adapter('slack', ['slack.com', 'edgeapi.slack.com'])]);
  assert.deepEqual(list, ['*.edgeapi.slack.com', '*.slack.com', 'edgeapi.slack.com', 'slack.com']);
});

test('a host no adapter declared is absent from the scoped list', () => {
  const list = hostnames([adapter('slack', ['slack.com'])]);
  assert.ok(!list.some((h) => h.includes('bank')));
  assert.ok(!list.includes('*'));
});

test('--host widens the scoped list without needing an adapter', () => {
  const list = hostnames([adapter('slack', ['slack.com'])], ['app.notion.so']);
  assert.ok(list.includes('app.notion.so'));
  assert.ok(list.includes('*.app.notion.so'));
});

test('a caller-written wildcard is passed through as given, not re-wrapped', () => {
  const list = hostnames([], ['*.notion.so']);
  assert.deepEqual(list, ['*.notion.so']);
});

test('hosts are normalised and de-duplicated across adapters', () => {
  const list = hostnames([adapter('a', ['Slack.com', ' slack.com ']), adapter('b', ['slack.com'])]);
  assert.deepEqual(list, ['*.slack.com', 'slack.com']);
});

test('no adapters and no extra hosts yields an empty scoped list (intercept nothing when scoped)', () => {
  // mockttp distinguishes the option being absent (no restriction) from an empty
  // array (nothing matches). Returning [] here is what makes "zero adapters"
  // capture nothing instead of everything when interceptAllHosts is false;
  // MitmEngine.start omits the option entirely when all-hosts is on (default).
  assert.deepEqual(tlsInterceptList([], []), []);
});

test('blank host entries are dropped rather than becoming a match-all', () => {
  assert.deepEqual(hostnames([adapter('a', ['', '   '])], ['']), []);
});

test('MitmEngine defaults to all-hosts (interceptedHosts is undefined)', () => {
  const engine = new MitmEngine({
    port: 0,
    adapters: [adapter('slack', ['slack.com'])],
    onCapture: () => {},
  });
  assert.equal(engine.interceptedHosts(), undefined);
});

test('isLoopbackListenHost and isCaDownloadPath', () => {
  assert.equal(isLoopbackListenHost(undefined), true);
  assert.equal(isLoopbackListenHost('127.0.0.1'), true);
  assert.equal(isLoopbackListenHost('0.0.0.0'), false);
  assert.equal(isCaDownloadPath('/sluice-ca.pem'), true);
  assert.equal(isCaDownloadPath('/sluice-ca.cer?x=1'), true);
  assert.equal(isCaDownloadPath('/sluice-ca.mobileconfig'), true);
  assert.equal(isCaDownloadPath('/api/foo'), false);
});

test('MitmEngine default listen is loopback, not *', async () => {
  const engine = new MitmEngine({
    port: 0,
    adapters: [],
    interceptAllHosts: false,
    onCapture: () => {},
  });
  try {
    await engine.start();
    const addr = engine.listenAddress();
    assert.ok(addr);
    assert.equal(addr.host, '127.0.0.1');
    assert.ok(addr.port > 0);
  } finally {
    await engine.stop();
  }
});

test('MitmEngine --lan-proxy listen is 0.0.0.0 and serves CA without capturing it', async () => {
  const captures: unknown[] = [];
  const engine = new MitmEngine({
    port: 0,
    adapters: [],
    interceptAllHosts: false,
    listenHost: '0.0.0.0',
    onCapture: (c) => captures.push(c),
  });
  try {
    await engine.start();
    const addr = engine.listenAddress();
    assert.ok(addr);
    assert.ok(addr.host === '0.0.0.0' || addr.host === '::');
    const pem = await fetch(`http://127.0.0.1:${addr.port}/sluice-ca.pem`);
    assert.equal(pem.status, 200);
    const pemText = await pem.text();
    assert.match(pemText, /BEGIN CERTIFICATE/);
    const cer = await fetch(`http://127.0.0.1:${addr.port}/sluice-ca.cer`);
    assert.equal(cer.status, 200);
    const cerBuf = Buffer.from(await cer.arrayBuffer());
    assert.ok(cerBuf.length > 0);
    assert.notEqual(cerBuf[0], 0x45); // not ASCII "Error: Passthrough loop…"
    const profile = await fetch(`http://127.0.0.1:${addr.port}/sluice-ca.mobileconfig`);
    assert.equal(profile.status, 200);
    const profileText = await profile.text();
    assert.match(profileText, /com\.apple\.security\.root/);
    assert.equal(captures.length, 0);
  } finally {
    await engine.stop();
  }
});

test('MitmEngine with interceptAllHosts false returns the scoped list', () => {
  const engine = new MitmEngine({
    port: 0,
    adapters: [adapter('slack', ['slack.com'])],
    onCapture: () => {},
    interceptAllHosts: false,
  });
  assert.deepEqual(engine.interceptedHosts(), ['*.slack.com', 'slack.com']);
});

test('all-hosts mode never decrypts AI assistant hosts or their subdomains', () => {
  const scope = mitmTlsScope(undefined);
  assert.ok('tlsPassthrough' in scope);
  assert.ok(!('tlsInterceptOnly' in scope), 'mockttp throws when both are set');
  const passthrough = scope.tlsPassthrough.map((h) => h.hostname);
  for (const host of ['anthropic.com', 'claude.ai', 'claude.com', 'claudeusercontent.com', 'openai.com', 'chatgpt.com', 'githubcopilot.com']) {
    assert.ok(NEVER_DECRYPT_HOSTS.includes(host), host);
    assert.ok(passthrough.includes(host), host);
    // URLPattern wildcard: covers api.anthropic.com, bridge.claudeusercontent.com, …
    assert.ok(passthrough.includes(`*.${host}`), `*.${host}`);
    // …and the trailing-dot FQDN form (api.anthropic.com.), which those miss.
    assert.ok(passthrough.includes(`${host}.`), `${host}.`);
    assert.ok(passthrough.includes(`*.${host}.`), `*.${host}.`);
  }
});

test('the CA is minted owner-only under $HOME', { skip: process.platform === 'win32' }, async () => {
  const { caPath, keyPath } = await ensureSluiceCA();
  assert.ok(caPath.startsWith(HOME));
  assert.equal(statSync(dirname(caPath)).mode & 0o777, 0o700);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(caPath).mode & 0o777, 0o644);
});

test('the never-decrypt list cannot be mutated at runtime', () => {
  assert.ok(Object.isFrozen(NEVER_DECRYPT_HOSTS));
  assert.throws(() => (NEVER_DECRYPT_HOSTS as string[]).push('example.com'));
});

test('scoped mode keeps tlsInterceptOnly exactly as given (an empty list still decrypts nothing)', () => {
  assert.deepEqual(mitmTlsScope(['slack.com', '*.slack.com']), {
    tlsInterceptOnly: [{ hostname: 'slack.com' }, { hostname: '*.slack.com' }],
  });
  assert.deepEqual(mitmTlsScope([]), { tlsInterceptOnly: [] });
});

test('MitmEngine starts in all-hosts mode with the passthrough list accepted by mockttp', async () => {
  const engine = new MitmEngine({ port: 0, adapters: [], onCapture: () => {} });
  try {
    await engine.start();
    assert.equal(engine.status().state, 'running');
  } finally {
    await engine.stop();
  }
});

/** Resolves true when something accepts a TCP connection on 127.0.0.1:port. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

test('a failed loopback rebind stops the proxy instead of leaving it on every interface', async () => {
  // mockttp binds every interface first; the engine then rebinds to loopback.
  // Simulate the rebind failing (a mockttp upgrade hiding its listen handle) by
  // hiding the handle from the engine's first look after start.
  const { getLocal } = await loadMockttp();
  const proto = Object.getPrototypeOf(getLocal({})) as { start: (...a: unknown[]) => Promise<unknown> };
  const realStart = proto.start;
  let port = 0;
  proto.start = async function (this: { server?: NetServer; port: number }, ...args: unknown[]) {
    const out = await realStart.apply(this, args);
    port = this.port;
    const inner = this.server;
    let hidden = false;
    Object.defineProperty(this, 'server', {
      configurable: true,
      get: () => {
        if (hidden) return inner;
        hidden = true;
        return undefined;
      },
    });
    return out;
  };
  try {
    const engine = new MitmEngine({ port: 0, adapters: [], interceptAllHosts: false, onCapture: () => {} });
    await assert.rejects(engine.start(), /no listen handle/);
    assert.ok(port > 0);
    assert.equal(engine.status().state, 'error');
    assert.equal(engine.listenAddress(), undefined);
    assert.equal(await listening(port), false, 'the orphaned all-interfaces listener was stopped');
  } finally {
    proto.start = realStart;
  }
});

test('a LAN proxy admits loopback and listed clients only', () => {
  assert.equal(isAllowedProxyClient('127.0.0.1', []), true);
  assert.equal(isAllowedProxyClient('::ffff:127.0.0.1', []), true);
  assert.equal(isAllowedProxyClient('::1', []), true);
  assert.equal(isAllowedProxyClient('192.168.1.50', []), false, 'an empty list admits loopback only');
  assert.equal(isAllowedProxyClient('192.168.1.50', ['192.168.1.50']), true);
  assert.equal(isAllowedProxyClient('::ffff:192.168.1.50', ['192.168.1.50']), true, 'IPv4-mapped');
  assert.equal(isAllowedProxyClient('192.168.1.51', ['192.168.1.50']), false);
  assert.equal(isAllowedProxyClient(undefined, ['192.168.1.50']), false);
});

test('guardProxyClients drops a refused client before any other connection handler runs', () => {
  const server = new EventEmitter();
  const seen: string[] = [];
  server.on('connection', (sock: { remoteAddress: string }) => seen.push(sock.remoteAddress));
  const refused: Array<string | undefined> = [];
  guardProxyClients(server as unknown as NetServer, ['10.0.0.5'], (a) => refused.push(a));
  const socket = (remoteAddress: string) => {
    const s = {
      remoteAddress,
      destroyed: false,
      destroy: () => {
        s.destroyed = true;
      },
    };
    return s;
  };
  const phone = socket('10.0.0.5');
  const stranger = socket('10.0.0.9');
  server.emit('connection', phone);
  server.emit('connection', stranger);
  assert.equal(phone.destroyed, false);
  assert.equal(stranger.destroyed, true);
  assert.deepEqual(refused, ['10.0.0.9']);
  assert.deepEqual(seen, ['10.0.0.5', '10.0.0.9'], 'the guard runs first; it does not remove later listeners');
});
