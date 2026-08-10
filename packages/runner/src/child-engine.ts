// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Parent-side handle for the isolated capture engine (§S1).
 *
 * Satisfies the same {@link EngineHandle} the in-process `MitmEngine` does, so
 * the {@link EngineController} and {@link superviseEngine} drive it unchanged:
 * they call start/stop/status and probe the port, none of which cares that the
 * engine now lives in another process.
 *
 * The one behaviour that matters for recovery: an UNEXPECTED child exit (a crash)
 * leaves `status()` reporting the last running state, NOT `error`. That is
 * deliberate and matches how the supervisor already treats mockttp — it restarts
 * only a thing that claims to be `running` whose health probe (the port) then
 * fails. Flipping to `error` here would make the supervisor skip the very restart
 * this isolation exists to enable. An INTENTIONAL stop reports `stopped`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Capture, EngineStatus } from '@sluice/core';
import type { EngineHandle } from './engine-controller.js';

export interface ChildEngineOptions {
  /** Executable to run (normally process.execPath). */
  command: string;
  /** Args: the child module, plus any loader flags (e.g. --import tsx in dev). */
  args: string[];
  /** SLUICE_CHILD_* config, merged over the parent env. */
  env: Record<string, string>;
  onCapture: (c: Capture) => void;
  onStatus?: (s: EngineStatus) => void;
  onError?: (e: unknown) => void;
  /** How long stop() waits for a graceful exit before SIGKILL. */
  stopTimeoutMs?: number;
}

type ChildFrame =
  | { t: 'started'; port: number; caPath: string }
  | { t: 'status'; status: EngineStatus }
  | { t: 'capture'; capture: Capture }
  | { t: 'error'; message: string };

const RUNNING: EngineStatus = { engine: 'mitm', state: 'running' };
const STOPPED: EngineStatus = { engine: 'mitm', state: 'stopped' };

export class ChildEngine implements EngineHandle {
  private child: ChildProcess | undefined;
  private last: EngineStatus = { engine: 'mitm', state: 'stopped' };
  /** True between a requested stop and the child's exit — an exit then is expected. */
  private stopping = false;

  constructor(private readonly opts: ChildEngineOptions) {}

  status(): EngineStatus {
    return this.last;
  }

  start(): Promise<{ port: number; caPath: string }> {
    // Reuse a live child rather than spawning a second proxy on the same port.
    if (this.child && this.last.state === 'running') {
      return Promise.resolve({ port: this.last.proxyPort ?? 0, caPath: '' });
    }
    this.stopping = false;
    this.last = { engine: 'mitm', state: 'starting' };

    const child = spawn(this.opts.command, this.opts.args, {
      env: { ...process.env, ...this.opts.env },
      // stdin (control) | stdout+stderr inherited (mockttp logs) | fd3 data pipe.
      stdio: ['pipe', 'inherit', 'inherit', 'pipe'],
    });
    this.child = child;

    return new Promise<{ port: number; caPath: string }>((resolve, reject) => {
      let settled = false;
      const dataPipe = child.stdio[3];
      if (dataPipe && 'on' in dataPipe) {
        createInterface({ input: dataPipe as NodeJS.ReadableStream }).on('line', (line) => {
          let frame: ChildFrame;
          try {
            frame = JSON.parse(line) as ChildFrame;
          } catch {
            return;
          }
          switch (frame.t) {
            case 'started':
              this.last = { ...RUNNING, proxyPort: frame.port };
              this.opts.onStatus?.(this.last);
              if (!settled) {
                settled = true;
                resolve({ port: frame.port, caPath: frame.caPath });
              }
              break;
            case 'status':
              // The child's own transitions (starting → running). Keep the port
              // from `started` if the frame omits it.
              this.last = { ...frame.status, proxyPort: frame.status.proxyPort ?? this.last.proxyPort };
              this.opts.onStatus?.(this.last);
              break;
            case 'capture':
              this.opts.onCapture(frame.capture);
              break;
            case 'error':
              this.opts.onError?.(new Error(frame.message));
              break;
          }
        });
      }

      child.on('error', (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
        this.opts.onError?.(e);
      });

      child.on('exit', (code, signal) => {
        this.child = undefined;
        if (this.stopping) {
          this.last = STOPPED;
        } else if (!settled) {
          // Died before it ever came up — a real start failure, surfaced so the
          // supervisor's restart loop (or the caller) sees it.
          settled = true;
          reject(new Error(`capture engine exited before starting (code ${code ?? signal})`));
        } else {
          // A crash after running. Keep reporting `running` (stale) so the
          // supervisor's port probe drives the restart — see the class comment.
          this.opts.onError?.(new Error(`capture engine exited unexpectedly (code ${code ?? signal})`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    this.last = STOPPED;
    if (!child || child.exitCode !== null) {
      this.child = undefined;
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, this.opts.stopTimeoutMs ?? 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.stdin?.write(`${JSON.stringify({ t: 'stop' })}\n`);
      } catch {
        child.kill('SIGKILL');
      }
    });
    this.child = undefined;
  }
}
