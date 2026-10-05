// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Keeping a capture engine alive, and saying so when it is not. Without
 * supervision a dead engine kept reporting `running` while capturing nothing,
 * and silence is the worst failure for a recorder.
 *
 * Health is a callback because neither engine can report its own death: mockttp
 * swallows post-start server errors and exposes no server-level event, so the
 * detector for Engine A is "is something still listening on the port?", and the
 * supervisor has no business knowing that a proxy has a port. The caller
 * supplies the probe.
 */
import { setTimeout as sleepMs } from 'node:timers/promises';
import { errorMessage, type EngineStatus } from '@sluice/core';

/** The part of an engine a supervisor touches. Both engines satisfy it. */
export interface SupervisedEngine {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  status(): EngineStatus;
}

export interface SuperviseOptions {
  engine: SupervisedEngine;
  /**
   * Is it still alive? Called on a timer while the engine reports `running`.
   *
   * Must not throw — a probe that throws is treated as unhealthy, which is the
   * safe reading, but a probe that throws for its own reasons rather than the
   * engine's will restart a perfectly good engine in a loop.
   */
  healthy: () => Promise<boolean>;
  /** Transitions, for the WS broadcast. Never called with a state it did not reach. */
  onStatus?: (s: EngineStatus) => void;
  /** How often to probe. */
  probeMs?: number;
  /** Give up after this many CONSECUTIVE failed restarts. */
  maxRestarts?: number;
  /** Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Supervisor {
  /**
   * Stop supervising, and RESOLVE once any in-flight restart has settled. Does
   * NOT stop the engine — the caller owns its lifetime — but awaiting this is
   * what lets the caller then stop the engine without racing a supervised
   * `engine.start()`.
   */
  stop(): Promise<void>;
  /** The supervisor's view, which is the engine's own except while restarting. */
  status(): EngineStatus;
  /**
   * Consecutive failed restart ATTEMPTS within the current recovery, and 0 the
   * rest of the time — `restart` clears it the moment the engine comes back, so
   * five separate blips over an afternoon each get the full budget rather than
   * counting towards one terminal total.
   */
  failures(): number;
}

const DEFAULT_PROBE_MS = 5_000;
const DEFAULT_MAX_RESTARTS = 5;

/**
 * How long to wait before the Nth consecutive restart: 1s, 2s, 4s, 8s, 16s.
 * Backing off because restarting the MITM proxy drops every in-flight
 * connection; a tight loop would look like the network flapping.
 */
export function backoffMs(attempt: number): number {
  return 1000 * 2 ** Math.max(0, attempt - 1);
}

export function superviseEngine(opts: SuperviseOptions): Supervisor {
  const {
    engine,
    healthy,
    onStatus = () => {},
    probeMs = DEFAULT_PROBE_MS,
    maxRestarts = DEFAULT_MAX_RESTARTS,
    sleep = (ms: number) => sleepMs(ms),
  } = opts;

  let stopped = false;
  let failures = 0;
  /** Set only while this loop is driving a restart; otherwise the engine speaks. */
  let override: EngineStatus | undefined;
  /**
   * The in-flight `restart()`. `stop()` awaits it because flipping `stopped` does
   * not interrupt a restart already inside `engine.start()`.
   */
  let activity: Promise<void> | undefined;

  const notify = (s: EngineStatus): void => {
    try {
      onStatus(s);
    } catch {
      // A listener that throws must not take the supervisor down with it —
      // the whole point of this loop is to be the thing that survives.
    }
  };

  const report = (state: EngineStatus['state'], detail: string): void => {
    override = { ...engine.status(), state, detail };
    notify(override);
  };

  const probe = async (): Promise<boolean> => {
    try {
      return await healthy();
    } catch {
      return false;
    }
  };

  /**
   * Bring the engine back, retrying until it comes up or the budget runs out.
   * The retry loop lives here, not in the health loop, because a failed
   * `start()` leaves the engine `stopped`, which the health loop ignores, so
   * returning to it after a failure would silently stop supervising.
   */
  async function restart(): Promise<void> {
    while (!stopped) {
      failures += 1;
      const wait = backoffMs(failures);
      report(
        'restarting',
        `capture stopped; restarting in ${Math.round(wait / 1000)}s (attempt ${failures} of ${maxRestarts})`,
      );
      await sleep(wait);
      if (stopped) return;
      try {
        // Stop first; the engine is broken by assumption, so tolerate stop()
        // failing.
        await engine.stop().catch(() => {});
        await engine.start();
        failures = 0;
        override = undefined;
        // notify: a throwing listener must not land in the catch and restart a healthy engine.
        notify(engine.status());
        return;
      } catch (e) {
        const why = errorMessage(e);
        if (failures >= maxRestarts) {
          report(
            'error',
            `capture stopped and could not be restarted after ${maxRestarts} attempts: ${why}`,
          );
          // Terminal: probing on would turn bounded backoff into an unbounded one.
          stopped = true;
          return;
        }
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      await sleep(probeMs);
      if (stopped) return;
      // Only supervise something that claims to be up. An engine deliberately
      // stopped, or still starting, is not a crash — restarting it would fight
      // whoever stopped it.
      if (engine.status().state !== 'running') continue;
      if (await probe()) continue;
      activity = restart();
      await activity;
      activity = undefined;
    }
  }

  void loop();

  return {
    async stop() {
      stopped = true;
      // Wait out a restart that is already inside engine.start(); otherwise the
      // controller's engine.stop() would run concurrently with it.
      await activity;
    },
    status() {
      return override ?? engine.status();
    },
    failures() {
      return failures;
    },
  };
}
