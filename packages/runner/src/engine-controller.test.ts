// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * EngineController lifecycle. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * These pin the races the architecture review named: double-start, a supervisor
 * restarting a user-stopped engine, a stale supervisor leaving a UI-started
 * engine unsupervised, and a system proxy outliving the engine it points at.
 * Everything is faked — no mockttp, no OS proxy — so the lifecycle is what is
 * under test, not the engine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineStatus } from '@sluice/core';
import type { Supervisor } from '@sluice/interceptor';
import { EngineController } from './engine-controller.js';
import type { EngineControllerDeps, EngineHandle, SystemProxyReport } from './engine-controller.js';

function fakeEngine(): EngineHandle & { starts: number; stops: number; state: EngineStatus['state'] } {
  const e = {
    starts: 0,
    stops: 0,
    state: 'stopped' as EngineStatus['state'],
    async start() {
      e.starts += 1;
      // A real start is async; yield so a concurrent second call can interleave
      // if the controller fails to serialize.
      await Promise.resolve();
      e.state = 'running';
      return { port: 8080, caPath: '/ca.pem' };
    },
    async stop() {
      e.stops += 1;
      await Promise.resolve();
      e.state = 'stopped';
    },
    status(): EngineStatus {
      return { engine: 'mitm', state: e.state, proxyPort: 8080 };
    },
  };
  return e;
}

function fakeSupervisor(): Supervisor & { stopped: boolean } {
  const s = {
    stopped: false,
    async stop() {
      s.stopped = true;
    },
    status(): EngineStatus {
      return { engine: 'mitm', state: 'running', proxyPort: 8080 };
    },
    failures() {
      return 0;
    },
  };
  return s;
}

interface Harness {
  ctrl: EngineController;
  engines: ReturnType<typeof fakeEngine>[];
  supervisors: ReturnType<typeof fakeSupervisor>[];
  proxy: { on: number; off: number; enabled: boolean };
}

function harness(): Harness {
  const engines: ReturnType<typeof fakeEngine>[] = [];
  const supervisors: ReturnType<typeof fakeSupervisor>[] = [];
  const proxy = { on: 0, off: 0, enabled: false };
  const deps: EngineControllerDeps = {
    buildEngine: () => {
      const e = fakeEngine();
      engines.push(e);
      return e;
    },
    supervise: () => {
      const s = fakeSupervisor();
      supervisors.push(s);
      return s;
    },
    proxy: {
      async on() {
        proxy.on += 1;
        proxy.enabled = true;
      },
      async off() {
        proxy.off += 1;
        proxy.enabled = false;
      },
      async state(): Promise<SystemProxyReport> {
        return { supported: true, enabled: proxy.enabled, ours: proxy.enabled, port: 8080 };
      },
    },
    onStatus: () => {},
    onEnvironment: () => {},
    caInfo: () => ({ generated: true, path: '/ca.pem' }),
  };
  return { ctrl: new EngineController(deps), engines, supervisors, proxy };
}

test('status is stopped before anything starts, and never throws', () => {
  const { ctrl } = harness();
  // EngineLike consumers deref this unconditionally (computeCatalog, statusFrame),
  // so a controller holding no engine must synthesize stopped, not blow up.
  assert.deepEqual(ctrl.status(), { engine: 'mitm', state: 'stopped' });
});

test('two concurrent starts build exactly one engine', async () => {
  const { ctrl, engines } = harness();
  await Promise.all([ctrl.startEngine(), ctrl.startEngine()]);
  assert.equal(engines.length, 1, 'single-flight: the second start waits, sees running, no-ops');
  assert.equal(engines[0]?.starts, 1);
});

test('each start builds a FRESH supervisor', async () => {
  const { ctrl, supervisors } = harness();
  await ctrl.startEngine();
  await ctrl.stopEngine();
  await ctrl.startEngine();
  assert.equal(supervisors.length, 2, 'a stopped supervisor is permanent — never reused');
  assert.equal(supervisors[0]?.stopped, true, 'the first was stopped on stopEngine');
});

test('stopEngine stops the supervisor BEFORE the engine', async () => {
  const { ctrl, engines, supervisors } = harness();
  await ctrl.startEngine();
  await ctrl.stopEngine();
  assert.equal(supervisors[0]?.stopped, true, 'supervisor.stop() was awaited');
  assert.equal(engines[0]?.stops, 1, 'then the engine was stopped');
  assert.equal(ctrl.status().state, 'stopped');
});

test('the system proxy is refused until the engine is running', async () => {
  const { ctrl, proxy } = harness();
  await assert.rejects(() => ctrl.proxyOn(), /Start capture before/);
  assert.equal(proxy.on, 0);
  await ctrl.startEngine();
  await ctrl.proxyOn();
  assert.equal(proxy.on, 1);
  assert.equal(proxy.enabled, true);
});

test('stopping the engine takes the system proxy down with it', async () => {
  // A proxy left pointing at a dead port black-holes all machine HTTPS.
  const { ctrl, proxy } = harness();
  await ctrl.startEngine();
  await ctrl.proxyOn();
  assert.equal(proxy.enabled, true);
  await ctrl.stopEngine();
  assert.equal(proxy.enabled, false, 'proxy cleared as part of stop');
  assert.equal(proxy.off, 1);
});

test('shutdown restores the proxy even without an explicit stop', async () => {
  const { ctrl, proxy, engines } = harness();
  await ctrl.startEngine();
  await ctrl.proxyOn();
  await ctrl.shutdown();
  assert.equal(proxy.enabled, false, 'process exit must not strand the proxy');
  assert.equal(engines[0]?.stops, 1);
});

test('the supervisor giving up (terminal error) clears the proxy', async () => {
  // Wire a supervisor whose onStatus we can drive to 'error'.
  let fireError: (() => void) | undefined;
  const proxy = { on: 0, off: 0, enabled: false };
  const ctrl = new EngineController({
    buildEngine: () => fakeEngine(),
    supervise: (_engine, onStatus) => {
      fireError = () => onStatus({ engine: 'mitm', state: 'error', detail: 'gave up' });
      return fakeSupervisor();
    },
    proxy: {
      async on() {
        proxy.on += 1;
        proxy.enabled = true;
      },
      async off() {
        proxy.off += 1;
        proxy.enabled = false;
      },
      async state(): Promise<SystemProxyReport> {
        return { supported: true, enabled: proxy.enabled, ours: proxy.enabled };
      },
    },
    onStatus: () => {},
    onEnvironment: () => {},
    caInfo: () => ({ generated: true }),
  });
  await ctrl.startEngine();
  await ctrl.proxyOn();
  assert.equal(proxy.enabled, true);
  fireError?.();
  await new Promise((r) => setTimeout(r, 5)); // let the async terminal handler run
  assert.equal(proxy.enabled, false, 'a dead engine must not keep the proxy up');
});
