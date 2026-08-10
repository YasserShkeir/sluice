// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The shell's persistent nav.
 *
 * Connection state, engine state and the app version live here rather than in
 * the traffic toolbar, which is where they were. They describe the RUNNER, not
 * the table: "is anything connected, and is the proxy up?" is the same question
 * on the apps page as on the traffic page, and a status that vanishes when you
 * navigate reads as a status that changed.
 *
 * The paused pill is here for the same reason but a sharper one — this is a
 * capture tool, and "am I recording right now?" must be answerable from every
 * page, not only from the page that owns the button. It renders only while
 * paused: a permanent "recording" chip is the state you stop seeing.
 */
import type { EngineStatus } from '@sluice/core';
import type { ConnectionState } from '../ws.js';
import { useLink } from '../router.js';
import type { Route } from '../router.js';

const CONN_LABEL: Record<ConnectionState, string> = {
  connecting: 'connecting…',
  open: 'connected',
  closed: 'disconnected',
};

const ITEMS: Array<{ route: Route; label: string }> = [
  { route: { name: 'overview' }, label: 'Overview' },
  { route: { name: 'traffic' }, label: 'Traffic' },
  { route: { name: 'apps' }, label: 'Apps' },
  { route: { name: 'explore' }, label: 'Explore' },
  { route: { name: 'replay' }, label: 'Replay' },
  { route: { name: 'data' }, label: 'Data' },
];

/** `/apps/slack` is still the Apps tab — a detail page under a tab is that tab. */
function isActive(item: Route, current: Route): boolean {
  if (item.name === 'apps') return current.name === 'apps' || current.name === 'app';
  return item.name === current.name;
}

import { CaptureToggle } from './CaptureToggle.js';
import type { EnvironmentState } from '../ws.js';

interface Props {
  route: Route;
  connection: ConnectionState;
  retries: number;
  appVersion: string;
  engines: EngineStatus[];
  capturePaused: boolean;
  environment?: EnvironmentState;
  /** Whether this runner exposes the embedded terminal (`--terminal`). */
  terminalEnabled: boolean;
  /** Whether the terminal drawer is currently shown. */
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}

export function NavBar({
  route,
  connection,
  retries,
  appVersion,
  engines,
  capturePaused,
  environment,
  terminalEnabled,
  terminalOpen,
  onToggleTerminal,
}: Props) {
  const link = useLink();
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-bg-1 px-3 py-1.5">
      <a {...link({ name: 'overview' })} className="brand no-underline text-fg hover:text-accent">
        ⛆ Sluice
      </a>

      <nav aria-label="Sections" className="flex items-center gap-0.5">
        {ITEMS.map((item) => {
          const active = isActive(item.route, route);
          return (
            <a
              key={item.label}
              {...link(item.route)}
              aria-current={active ? 'page' : undefined}
              className={[
                'rounded px-2.5 py-1 text-[12.5px] no-underline transition-colors',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                active
                  ? 'bg-accent-dim text-fg shadow-[inset_0_-2px_0_0_var(--color-accent)]'
                  : 'text-fg-dim hover:bg-bg-3 hover:text-fg',
              ].join(' ')}
            >
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {terminalEnabled ? (
          <button
            type="button"
            onClick={onToggleTerminal}
            aria-pressed={terminalOpen}
            title="Embedded Claude Code terminal"
            className={[
              'rounded border px-2 py-0.5 text-[11px] transition-colors',
              terminalOpen
                ? 'border-accent bg-accent-dim text-fg'
                : 'border-border text-fg-dim hover:bg-bg-3 hover:text-fg',
            ].join(' ')}
          >
            {'>_'} Terminal
          </button>
        ) : null}
        {environment ? <CaptureToggle engines={engines} environment={environment} /> : null}
        {capturePaused ? (
          <span className="rounded border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
            ❚❚ capture paused
          </span>
        ) : null}
        <span className={`conn-pill conn-${connection}`}>
          <span className="dot" />
          {CONN_LABEL[connection]}
          {connection !== 'open' && retries > 0 ? ` · retry ${retries}` : ''}
        </span>
        {engines.length > 0 ? (
          <span className="engines">
            {engines.map((e) => (
              <span key={e.engine} className={`engine engine-${e.state}`} title={e.detail ?? ''}>
                {e.engine}
                {e.proxyPort ? `:${e.proxyPort}` : ''}
              </span>
            ))}
          </span>
        ) : null}
        {appVersion ? <span className="muted small">v{appVersion}</span> : null}
      </div>
    </header>
  );
}
