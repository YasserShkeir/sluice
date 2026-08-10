// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The embedded Claude Code terminal drawer.
 *
 * A bottom drawer holding one xterm.js instance wired to the runner's `/pty`
 * socket. The design mirrors the server's guarantees so the UI cannot imply more
 * than the backend allows:
 *
 *   - It connects only after the user first opens the drawer — opening the page
 *     never launches claude. After that the socket stays up across hide/show, so
 *     toggling the drawer does not kill the session; the session dies when the
 *     TAB closes (the socket drops, the server kills the child).
 *   - It carries the SEPARATE pty secret (never the read token) via {@link ptyWsUrl}.
 *   - It is single-session by construction: one socket, one child. A reconnect
 *     replaces rather than multiplies (the server takes over).
 *
 * The wire protocol is the small hand-rolled `PtyClientFrame`/`PtyServerFrame`
 * pair, not the capture channel's zod-validated messages — a keystroke/redraw
 * stream has no business in the broadcast ring.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PtyServerFrame } from '@sluice/core';
import { ptyWsUrl } from '../ws.js';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Status = 'connecting' | 'live' | 'ended' | 'error';

const THEME = {
  background: '#0b0e14',
  foreground: '#d7dae0',
  cursor: '#7aa2f7',
  selectionBackground: '#2a3450',
};

export function Terminal({ open, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>('connecting');

  const send = useCallback(
    (frame: { t: 'stdin'; d: string } | { t: 'resize'; cols: number; rows: number } | { t: 'end' }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    },
    [],
  );

  // Explicit teardown — the session otherwise PERSISTS across reloads/hide, so
  // this is the only thing that actually ends it.
  const endSession = useCallback(() => {
    send({ t: 'end' });
    onClose();
  }, [send, onClose]);

  const fitAndResize = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      send({ t: 'resize', cols: term.cols, rows: term.rows });
    } catch {
      /* container not measurable yet (drawer still hidden) — a later fit fixes it */
    }
  }, [send]);

  // One-time setup: create the terminal, connect the socket, wire both ways. The
  // component is only mounted once the drawer has been opened, so this runs when
  // the user actually wants a session — not on page load.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: THEME,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    setTimeout(fitAndResize, 0);

    let ws: WebSocket;
    try {
      ws = new WebSocket(ptyWsUrl());
    } catch {
      setStatus('error');
      term.writeln('\r\n\x1b[31mCould not open the terminal socket.\x1b[0m');
      return () => term.dispose();
    }
    wsRef.current = ws;

    ws.onopen = () => setStatus('connecting');
    ws.onmessage = (ev: MessageEvent) => {
      let frame: PtyServerFrame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as PtyServerFrame;
      } catch {
        return;
      }
      switch (frame.t) {
        case 'ready':
          setStatus('live');
          fitAndResize();
          break;
        case 'data':
          term.write(frame.d);
          break;
        case 'exit':
          setStatus('ended');
          term.writeln(`\r\n\x1b[90m— session ended (exit ${frame.code ?? 0}) —\x1b[0m`);
          break;
        case 'error':
          setStatus('error');
          term.writeln(`\r\n\x1b[31m${frame.message}\x1b[0m`);
          break;
      }
    };
    ws.onclose = () => setStatus((s) => (s === 'ended' ? s : 'ended'));
    ws.onerror = () => setStatus('error');

    const onData = term.onData((d) => send({ t: 'stdin', d }));
    const ro = new ResizeObserver(() => fitAndResize());
    ro.observe(host);

    return () => {
      onData.dispose();
      ro.disconnect();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      term.dispose();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
    // Setup is intentionally once-per-mount; `fitAndResize`/`send` are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refit + refocus when the drawer becomes visible (a hidden container measures
  // as 0×0, so xterm needs a nudge once it has real dimensions again).
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      fitAndResize();
      termRef.current?.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [open, fitAndResize]);

  const statusLabel: Record<Status, string> = {
    connecting: 'connecting…',
    live: 'live',
    ended: 'ended',
    error: 'error',
  };

  return (
    <div
      className={[
        'fixed inset-x-0 bottom-0 z-50 flex flex-col border-t border-border bg-[#0b0e14] shadow-2xl',
        'transition-transform duration-150',
        open ? 'translate-y-0' : 'translate-y-full',
      ].join(' ')}
      style={{ height: '45vh' }}
      aria-hidden={!open}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="text-[12px] font-semibold text-fg">Claude Code</span>
        <span
          className={[
            'rounded px-1.5 py-0.5 text-[10px]',
            status === 'live'
              ? 'bg-ok/15 text-ok'
              : status === 'error'
                ? 'bg-danger/15 text-danger'
                : 'bg-bg-3 text-fg-mute',
          ].join(' ')}
        >
          {statusLabel[status]}
        </span>
        <span className="text-[11px] text-fg-mute">
          runs as you · session persists across reloads
        </span>
        <button
          type="button"
          onClick={endSession}
          title="End the session (kills the Claude process)"
          className="ml-auto rounded px-2 py-0.5 text-[12px] text-fg-mute hover:bg-danger/15 hover:text-danger"
        >
          End
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Hide the drawer (the session keeps running)"
          className="rounded px-2 py-0.5 text-[12px] text-fg-mute hover:bg-bg-3 hover:text-fg"
        >
          Hide ⌄
        </button>
      </div>
      {/* xterm renders into this host; it owns its own scrolling. */}
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 py-1" />
    </div>
  );
}
