// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime control of the capture engine + system proxy, so the DASHBOARD can
 * start and stop capture instead of it being fixed at `sluice start` time.
 *
 * The engine used to be a `const` built inside `cmdStart`, downstream of nothing
 * — construct, start, set proxy, done. Making it toggleable at runtime turns it
 * into mutable state two dashboards and a supervisor can all reach at once, and
 * the architecture review found the concrete races that opens. This controller
 * is the serialized state machine that closes them:
 *
 *   - **Single-flight.** start/stop chain onto one in-flight promise, so a
 *     double-click or two dashboards cannot run `engine.start()` twice (which
 *     leaks a mockttp server and orphans the port). The engine's own reentrancy
 *     guard is the second line; this is the first.
 *   - **A fresh supervisor per start.** `superviseEngine` is single-use
 *     (`stopped` is permanent), so reusing one would leave a UI-started engine
 *     unsupervised — green pill over a dead engine, the exact thing the
 *     supervisor exists to prevent.
 *   - **stop() awaits the supervisor.** `supervisor.stop()` now resolves only
 *     after any in-flight restart settles, so `engine.stop()` cannot race a
 *     supervised `engine.start()`.
 *   - **The system proxy is bound to a running engine.** It is set only while
 *     running and cleared on stop, on the supervisor giving up, and on process
 *     shutdown — because a proxy left pointing at a dead loopback port
 *     black-holes all of the machine's HTTPS.
 *
 * Dependencies are injected (engine factory, supervise fn, proxy ops) so the
 * lifecycle is testable without a real mockttp server or touching the OS proxy.
 */
import type { EngineStatus } from '@sluice/core';
import type { Supervisor } from '@sluice/interceptor';

/** The slice of a capture engine the controller drives. `MitmEngine` satisfies it. */
export interface EngineHandle {
  start(): Promise<{ port: number; caPath: string }>;
  stop(): Promise<void>;
  status(): EngineStatus;
}

/** How the controller talks to the OS system proxy. macOS `proxy.ts` satisfies it. */
export interface SystemProxyOps {
  on(port: number): Promise<void>;
  /** Clear the proxy — implementations must only touch a proxy pointing at us. */
  off(): Promise<void>;
  /** Current state, for `environment()`. */
  state(): Promise<SystemProxyReport>;
}

export interface SystemProxyReport {
  supported: boolean;
  enabled: boolean;
  host?: string;
  port?: number;
  /** Whether the enabled proxy points at OUR port (vs. someone else's). */
  ours: boolean;
  detail?: string;
}

/** What `environment()` reports — everything the dashboard's control page renders. */
export interface EnvironmentState {
  systemProxy: SystemProxyReport;
  /** The port the engine is (or was last) bound to, when known. */
  proxyPort?: number;
  /** Whether the CA cert exists on disk (trust is a separate, CLI-only step). */
  caGenerated: boolean;
  caPath?: string;
}

export interface EngineControllerDeps {
  /** Build a FRESH engine. Called once per start — never reused across a stop. */
  buildEngine: () => EngineHandle;
  /** Wrap a running engine in a fresh supervisor. Injected so tests can fake it. */
  supervise: (engine: EngineHandle, onStatus: (s: EngineStatus) => void, port: number) => Supervisor;
  proxy: SystemProxyOps;
  /** Broadcast an engine transition (wired to the server's broadcastEngineStatus). */
  onStatus: (s: EngineStatus) => void;
  /** Broadcast an environment change (proxy toggled, engine started/stopped). */
  onEnvironment: (e: EnvironmentState) => void;
  /** Whether the CA cert file exists, and where — for `environment()`. */
  caInfo: () => { generated: boolean; path?: string };
}

const STOPPED: EngineStatus = { engine: 'mitm', state: 'stopped' };

export class EngineController {
  private engine: EngineHandle | undefined;
  private supervisor: Supervisor | undefined;
  private port: number | undefined;
  /** True only when THIS process set the system proxy — the ours-check for clearing. */
  private proxyOurs = false;
  /** Serializes start/stop so two callers cannot interleave a lifecycle op. */
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: EngineControllerDeps) {}

  /** Run `fn` after any in-flight lifecycle op, and make the next one wait on it. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.inflight.then(fn, fn);
    this.inflight = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The engine's status — the supervisor's view while it owns one, else synthesized. */
  status(): EngineStatus {
    if (this.supervisor) return this.supervisor.status();
    return this.engine ? this.engine.status() : STOPPED;
  }

  async environment(): Promise<EnvironmentState> {
    const ca = this.deps.caInfo();
    return {
      systemProxy: await this.proxyState(),
      proxyPort: this.port,
      caGenerated: ca.generated,
      caPath: ca.path,
    };
  }

  private async proxyState(): Promise<SystemProxyReport> {
    try {
      return await this.deps.proxy.state();
    } catch (e) {
      return { supported: false, enabled: false, ours: false, detail: errText(e) };
    }
  }

  /** Start capture. Idempotent: a running engine is left as-is, not restarted. */
  startEngine(): Promise<{ port: number; caPath: string }> {
    return this.serialize(async () => {
      if (this.engine && this.status().state === 'running') {
        return { port: this.port ?? 0, caPath: this.deps.caInfo().path ?? '' };
      }
      const engine = this.deps.buildEngine();
      const { port, caPath } = await engine.start();
      this.engine = engine;
      this.port = port;
      // A brand-new supervisor every time — the old one is permanently stopped.
      // Its terminal-failure path clears the system proxy so a dead engine never
      // leaves the machine's HTTPS routed at a closed port.
      this.supervisor = this.deps.supervise(
        engine,
        (s) => {
          this.deps.onStatus(s);
          if (s.state === 'error') void this.onTerminalFailure();
        },
        port,
      );
      this.deps.onStatus(engine.status());
      void this.emitEnvironment();
      return { port, caPath };
    });
  }

  /** Stop capture, and take the system proxy down with it (it points at us). */
  stopEngine(): Promise<void> {
    return this.serialize(async () => {
      // Supervisor first, AWAITED — so no supervised restart is mid-flight when
      // we stop the engine. Then the proxy, because it must not outlive the port.
      if (this.supervisor) {
        await this.supervisor.stop();
        this.supervisor = undefined;
      }
      if (this.proxyOurs) await this.clearProxyInternal();
      if (this.engine) {
        await this.engine.stop();
        this.deps.onStatus(this.engine.status());
        this.engine = undefined;
      } else {
        this.deps.onStatus(STOPPED);
      }
      void this.emitEnvironment();
    });
  }

  /** Route the machine's HTTPS through the proxy — only while the engine runs. */
  proxyOn(): Promise<void> {
    return this.serialize(async () => {
      if (this.status().state !== 'running' || this.port === undefined) {
        throw new Error('Start capture before turning the system proxy on.');
      }
      await this.deps.proxy.on(this.port);
      this.proxyOurs = true;
      await this.emitEnvironment();
    });
  }

  proxyOff(): Promise<void> {
    return this.serialize(async () => {
      await this.clearProxyInternal();
      await this.emitEnvironment();
    });
  }

  private async clearProxyInternal(): Promise<void> {
    try {
      await this.deps.proxy.off();
    } finally {
      // Cleared regardless: if `off()` failed because it was not ours to clear,
      // we still stop claiming it.
      this.proxyOurs = false;
    }
  }

  /**
   * The supervisor gave up (maxRestarts exhausted). The engine is dead, so the
   * system proxy cannot be allowed to keep pointing at it.
   */
  private async onTerminalFailure(): Promise<void> {
    if (this.proxyOurs) {
      await this.clearProxyInternal().catch(() => {});
      void this.emitEnvironment();
    }
  }

  private async emitEnvironment(): Promise<void> {
    try {
      this.deps.onEnvironment(await this.environment());
    } catch {
      /* environment is advisory; never let it break a lifecycle op */
    }
  }

  /**
   * Process shutdown. Tear everything down and, crucially, restore the system
   * proxy — a runner that exits with the proxy still set strands all machine
   * HTTPS on a closed port. Best-effort: every step is guarded so one failure
   * does not skip the proxy restore.
   */
  async shutdown(): Promise<void> {
    await this.supervisor?.stop().catch(() => {});
    if (this.proxyOurs) await this.clearProxyInternal().catch(() => {});
    await this.engine?.stop().catch(() => {});
    this.engine = undefined;
    this.supervisor = undefined;
  }
}

/** Kept local so the controller does not depend on core's redactText for one string. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
