// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The capture + system-proxy control, in the NavBar.
 *
 * Starting/stopping capture is the highest-frequency thing you do with Sluice, so
 * it lives in the persistent header next to the engine pills — "am I capturing?"
 * answerable from every page — rather than buried on a settings screen.
 *
 * Three honest states it must show, because each changes what to do next:
 *   - engine stopped/running/starting/restarting/error (from the engine status);
 *   - the system proxy on/off, and whether it is OURS (a proxy someone else set,
 *     or one left pointing at a dead port after a crash, must not read as "on");
 *   - the CA present-or-not — capture can be "running" and decrypt nothing until
 *     the CA is trusted, which is an interactive CLI step the dashboard cannot do.
 */
import { Loader2 } from 'lucide-react';
import type { EngineStatus } from '@sluice/core';
import type { EnvironmentState } from '../ws.js';
import { sendEngineControl, sendProxyControl } from '../ws.js';

interface Props {
  engines: EngineStatus[];
  environment?: EnvironmentState;
}

export function CaptureToggle({ engines, environment }: Props) {
  const mitm = engines.find((e) => e.engine === 'mitm');
  const state = mitm?.state ?? 'stopped';
  const running = state === 'running';
  const busy = state === 'starting' || state === 'stopping' || state === 'restarting';
  const proxy = environment?.systemProxy;

  return (
    <span className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => sendEngineControl(running ? 'stop' : 'start')}
        title={mitm?.detail ?? (running ? 'Stop capturing' : 'Start capturing')}
        className={[
          'inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60',
          running
            ? 'border border-ok/40 bg-ok/10 text-ok hover:bg-ok/20'
            : state === 'error'
              ? 'border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20'
              : 'border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20',
        ].join(' ')}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
        {busy
          ? state === 'stopping'
            ? 'Stopping…'
            : state === 'restarting'
              ? 'Restarting…'
              : 'Starting…'
          : running
            ? '❚❚ Stop capture'
            : state === 'error'
              ? '⚠ Retry capture'
              : '▶ Start capture'}
      </button>

      {/* Proxy toggle only makes sense once the engine is up — a proxy pointing at
          a stopped engine black-holes the machine's traffic. */}
      {running && proxy?.supported ? (
        <button
          type="button"
          onClick={() => sendProxyControl(proxy.ours ? 'off' : 'on')}
          title={
            proxy.enabled && !proxy.ours
              ? 'A system proxy is set, but not by Sluice'
              : proxy.ours
                ? 'Stop routing this machine through Sluice'
                : 'Route this machine’s HTTPS through Sluice'
          }
          className={[
            'rounded border px-2 py-0.5 text-[11px] transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            proxy.ours
              ? 'border-ok/40 bg-ok/10 text-ok hover:bg-ok/20'
              : proxy.enabled
                ? 'border-warn/40 bg-warn/10 text-warn'
                : 'border-border text-fg-dim hover:bg-bg-3 hover:text-fg',
          ].join(' ')}
        >
          {proxy.ours ? 'proxy: on' : proxy.enabled ? 'proxy: other' : 'proxy: off'}
        </button>
      ) : null}

      {/* Capture can be "running" yet decrypt nothing until the CA is trusted —
          which the dashboard cannot do (interactive Keychain). Say so rather than
          show green over an empty traffic table. */}
      {running && environment && !environment.caGenerated ? (
        <span
          className="rounded border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] text-warn"
          title="Run `sluice ca-install` in a terminal — capture decrypts nothing until the CA is trusted"
        >
          CA not set up
        </span>
      ) : null}
    </span>
  );
}
