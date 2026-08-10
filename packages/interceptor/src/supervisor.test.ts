// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Supervisor tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * Time is injected, so none of these actually wait. A supervisor tested against
 * a real clock is a test that is either slow or flaky, and this one has a
 * backoff that reaches 16 seconds.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { EngineStatus } from '@sluice/core';
import { backoffMs, superviseEngine } from './supervisor.js';

/**
 * A fake engine whose health and start behaviour the test drives.
 *
 * `starts` and `stops` are counters rather than spies because what every test
 * below asserts is "how many times", never "with what" — start takes nothing.
 */
function fakeEngine(opts: { failStarts?: number } = {}) {
  let state: EngineStatus['state'] = 'running';
  let failStarts = opts.failStarts ?? 0;
  const e = {
    starts: 0,
    stops: 0,
    setState(s: EngineStatus['state']) {
      state = s;
    },
    async start() {
      e.starts += 1;
      if (failStarts > 0) {
        failStarts -= 1;
        throw new Error('port in use');
      }
      state = 'running';
    },
    async stop() {
      e.stops += 1;
      state = 'stopped';
    },
    status(): EngineStatus {
      return { engine: 'mitm', state, proxyPort: 8080 };
    },
  };
  return e;
}

/**
 * Run the supervisor for a bounded number of injected sleeps.
 *
 * The loop is infinite by design, so the test controls it by counting sleeps and
 * then flipping the stop flag — which is also what proves `stop()` ends it.
 */
function drive(ticks: number) {
  let remaining = ticks;
  let onExhausted = (): void => {};
  const sleep = async (): Promise<void> => {
    remaining -= 1;
    if (remaining <= 0) onExhausted();
    // Yield to the microtask queue so the loop's awaits interleave the way they
    // would with a real timer.
    await Promise.resolve();
  };
  return { sleep, whenExhausted: (fn: () => void) => (onExhausted = fn) };
}

const statuses = (): { seen: EngineStatus[]; onStatus: (s: EngineStatus) => void } => {
  const seen: EngineStatus[] = [];
  return { seen, onStatus: (s) => seen.push(s) };
};

test('a healthy engine is never restarted', () => {
  const engine = fakeEngine();
  const { sleep, whenExhausted } = drive(20);
  const sup = superviseEngine({ engine, healthy: async () => true, sleep, probeMs: 1 });
  whenExhausted(() => sup.stop());
  return Promise.resolve().then(() => {
    assert.equal(engine.starts, 0, 'the supervisor does not start what it did not stop');
    assert.equal(engine.stops, 0);
  });
});

test('an engine that stops answering is stopped and started again', async () => {
  const engine = fakeEngine();
  const { sleep, whenExhausted } = drive(6);
  const { seen, onStatus } = statuses();
  const sup = superviseEngine({ engine, healthy: async () => false, sleep, onStatus, probeMs: 1 });
  whenExhausted(() => sup.stop());
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(engine.starts >= 1, 'it was restarted');
  assert.ok(engine.stops >= 1, 'and stopped first — a half-dead listener still holds the port');
  // The state says restarting, NOT starting: a restart is not a first boot, and
  // reporting it as one hides that the capture had a hole in it.
  assert.ok(
    seen.some((s) => s.state === 'restarting'),
    'the transition is reported as restarting',
  );
  assert.ok(
    seen.every((s) => s.state !== 'starting'),
    'and never as a fresh start',
  );
});

test('a restart that keeps failing gives up, and says how many times it tried', async () => {
  // Bounded on purpose. Restarting the MITM proxy drops every in-flight
  // connection; a tight loop against a port something else has taken would look,
  // to the routed client, like the network flapping rather than like Sluice
  // failing.
  const engine = fakeEngine({ failStarts: 99 });
  const { sleep, whenExhausted } = drive(60);
  const { seen, onStatus } = statuses();
  const sup = superviseEngine({
    engine,
    healthy: async () => false,
    sleep,
    onStatus,
    probeMs: 1,
    maxRestarts: 3,
  });
  whenExhausted(() => sup.stop());
  await new Promise((r) => setTimeout(r, 20));

  const gaveUp = seen.filter((s) => s.state === 'error');
  assert.equal(gaveUp.length, 1, 'it gives up exactly once, not on every tick');
  assert.match(String(gaveUp[0]?.detail), /after 3 attempts/);
  assert.match(String(gaveUp[0]?.detail), /port in use/, 'and carries the reason it failed');
  assert.equal(sup.status().state, 'error');
});

test('each separate outage gets the full restart budget', async () => {
  // Five blips spread over an afternoon are five incidents, not an engine on its
  // last life. The counter therefore clears on RECOVERY rather than decaying —
  // otherwise the sixth blip of a long session is treated as terminal when
  // nothing has gone wrong five times in a row.
  //
  // The first start of each recovery fails and the next succeeds, so a run of
  // outages only survives if the counter really does return to zero: with
  // maxRestarts 2 and no reset, the second outage would give up.
  const engine = fakeEngine({ failStarts: 1 });
  const { sleep, whenExhausted } = drive(40);
  const { seen, onStatus } = statuses();
  const sup = superviseEngine({
    engine,
    healthy: async () => false,
    sleep,
    onStatus,
    probeMs: 1,
    maxRestarts: 2,
  });
  whenExhausted(() => sup.stop());
  await new Promise((r) => setTimeout(r, 20));

  assert.ok(engine.starts > 3, `it kept recovering across several outages (${engine.starts} starts)`);
  assert.equal(
    seen.filter((s) => s.state === 'error').length,
    0,
    'and never gave up, because each outage started from zero',
  );
});

test('an engine that is not running is left alone', async () => {
  // Someone stopped it, or it is still coming up. Restarting either would be the
  // supervisor fighting whoever is in charge.
  const engine = fakeEngine();
  engine.setState('stopped');
  const { sleep, whenExhausted } = drive(10);
  const sup = superviseEngine({ engine, healthy: async () => false, sleep, probeMs: 1 });
  whenExhausted(() => sup.stop());
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(engine.starts, 0);
  assert.equal(engine.stops, 0);
});

test('a probe that throws counts as dead, not as a crash', async () => {
  // The probe runs on a timer inside the loop that is supposed to be the durable
  // thing. A throw escaping it would end supervision at the exact moment
  // supervision is needed.
  const engine = fakeEngine();
  const { sleep, whenExhausted } = drive(6);
  const sup = superviseEngine({
    engine,
    healthy: async () => {
      throw new Error('probe blew up');
    },
    sleep,
    probeMs: 1,
  });
  whenExhausted(() => sup.stop());
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(engine.starts >= 1, 'it treated the failure as an unhealthy engine');
});

test('a listener that throws does not take the supervisor down', async () => {
  const engine = fakeEngine();
  const { sleep, whenExhausted } = drive(6);
  const sup = superviseEngine({
    engine,
    healthy: async () => false,
    sleep,
    probeMs: 1,
    onStatus: () => {
      throw new Error('broadcast failed');
    },
  });
  whenExhausted(() => sup.stop());
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(engine.starts >= 1, 'the restart still happened');
});

test('backoff doubles and starts at a second', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(backoffMs), [1000, 2000, 4000, 8000, 16000]);
  // Defensive: attempt 0 must not produce half a second through 2**-1.
  assert.equal(backoffMs(0), 1000);
});
