// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Keeping a capture engine alive, and saying so when it is not.
 *
 * What this fixes: `engine.start()` was called exactly once per process. If the
 * proxy died afterwards — a port taken, an unhandled rejection inside mockttp,
 * a CDP socket dropped when Chrome quit — nothing noticed. The engine's own
 * `status()` went on reporting whatever it last set, so the dashboard showed a
 * green "running" pill over a capture session that had stopped capturing, and
 * the first sign of trouble was a traffic table that quietly never grew again.
 * Silence is the worst failure mode for a tool whose whole job is to be
 * recording while you are not watching.
 *
 * ## What this is NOT
 *
 * It is not process isolation. §S1's complaint is that "one crashing takes the
 * runner with it", and a supervisor living inside the runner cannot answer that:
 * an `uncaughtException` in the proxy still ends the process this loop is
 * running in. Fixing that properly means the child-process design in
 * docs/interceptor-plan.md — engines in their own processes, captures over a
 * pipe. This is the half that is worth having first, because a crash you can see
 * and recover from beats a crash you can see, and both beat neither.
 *
 * ## Why health is a callback
 *
 * Neither engine can report its own death. mockttp swallows post-start server
 * errors and exposes no server-level event, so the only detector for Engine A is
 * "is something still listening on the port?" — and the supervisor has no
 * business knowing that a proxy has a port. The caller supplies the probe.
 */
import type { EngineStatus } from '@sluice/core';

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
 *
 * Bounded and backing off because a restart is not free the way reopening a
 * socket is. Restarting the MITM proxy drops every in-flight connection and
 * loses the exchanges mid-flight at the time; a tight retry loop against a port
 * something else has taken would do that repeatedly, and to the routed client it
 * would look like the network flapping rather than like Sluice failing.
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
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  } = opts;

  let stopped = false;
  let failures = 0;
  /** Set only while this loop is driving a restart; otherwise the engine speaks. */
  let override: EngineStatus | undefined;
  /**
   * The in-flight `restart()`, if one is running right now. `stop()` awaits it so
   * a caller (the EngineController) can be certain no `engine.start()` is racing
   * its own `engine.stop()` — flipping `stopped` alone does not interrupt a
   * `restart()` already past its `if (stopped)` checkpoints and inside
   * `engine.start()`.
   */
  let activity: Promise<void> | undefined;

  const report = (state: EngineStatus['state'], detail: string): void => {
    override = { ...engine.status(), state, detail };
    try {
      onStatus(override);
    } catch {
      // A listener that throws must not take the supervisor down with it —
      // the whole point of this loop is to be the thing that survives.
    }
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
   *
   * The retry loop lives HERE rather than in the health loop, and that is the
   * whole correctness of it. A failed `start()` leaves the engine reporting
   * `stopped`, and the health loop deliberately ignores anything that is not
   * `running` — so bouncing back out to it after a failure meant the supervisor
   * quietly stopped supervising, having reported `restarting` once and `error`
   * never. It looked like it was still trying. It was not.
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
        // Stop first, and tolerate it failing: the engine is already broken by
        // assumption, so its `stop()` is as likely to throw as anything else,
        // and refusing to start because the corpse would not lie down is the
        // wrong call.
        await engine.stop().catch(() => {});
        await engine.start();
        failures = 0;
        override = undefined;
        onStatus(engine.status());
        return;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (failures >= maxRestarts) {
          report(
            'error',
            `capture stopped and could not be restarted after ${maxRestarts} attempts: ${why}`,
          );
          // Terminal, and it says so. Continuing to probe a thing that has
          // failed `maxRestarts` times in a row is how a bounded backoff turns
          // back into an unbounded one.
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
