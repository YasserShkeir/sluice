// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Capture } from '@sluice/core';
import { useStore } from './ws.js';
import { navigate, useRoute } from './router.js';
import { ActivityLog } from './components/ActivityLog.js';
import { NavBar } from './components/NavBar.js';
import { Terminal } from './components/Terminal.js';
import { CommandPalette, KeyCheatsheet, useGlobalHotkeys } from './components/keyboard.js';
import type { Command } from './components/keyboard.js';
import { Overview } from './components/Overview.js';
import { FirstRunConsent, hasConsented } from './components/FirstRunConsent.js';
import { AppCatalog } from './components/AppCatalog.js';
import { DataBrowser } from './components/DataBrowser.js';
import { AppDetail } from './pages/AppDetail.js';
import { ExplorePage } from './pages/ExplorePage.js';
import { ReplayPage } from './pages/ReplayPage.js';
import { TrafficPage } from './pages/TrafficPage.js';

/**
 * The shell: a persistent nav over one routed page.
 *
 * This replaces a single screen that stacked all four regions in collapsible
 * panels. Splitting the panels was the right fix for the panels; it was the
 * wrong fix for the product, because the interesting things about an app — its
 * MCP tools, its replay actions, the hosts the proxy decrypts for it — cannot be
 * said in a card in a panel that is 26% of a viewport, and there is nowhere else
 * to say them. Pages give each thing a whole screen and a URL.
 *
 * The shell owns exactly the state that must outlive a navigation: the selected
 * capture and the app the traffic table is scoped to. Everything else belongs to
 * the page that renders it. The store is a module-level WebSocket subscription,
 * so it is untouched by routing.
 */
export function App() {
  const s = useStore();
  const route = useRoute();
  const [consented, setConsented] = useState(hasConsented);
  const [selected, setSelected] = useState<Capture | null>(null);
  const [appFilter, setAppFilter] = useState<string>('');
  const [toast, setToast] = useState<{ id: number; level: 'info' | 'error'; text: string } | null>(null);
  // The terminal drawer: `mounted` flips true on first open and stays true, so the
  // xterm + `/pty` socket survive hide/show (toggling does not kill claude); `open`
  // controls only visibility. The session ends when the tab closes.
  const [termMounted, setTermMounted] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  const toggleTerminal = useCallback(() => {
    setTermMounted(true);
    setTermOpen((v) => !v);
  }, []);

  // The keyboard registry — one list drives both ⌘K and the ? cheatsheet.
  const commands = useMemo<Command[]>(() => {
    const nav = (id: string, label: string, keys: string, r: Parameters<typeof navigate>[0]): Command => ({
      id,
      label,
      group: 'Go to',
      keys: [keys],
      run: () => navigate(r),
    });
    const list: Command[] = [
      nav('go-overview', 'Overview', 'g o', { name: 'overview' }),
      nav('go-traffic', 'Traffic', 'g t', { name: 'traffic' }),
      nav('go-apps', 'Apps', 'g a', { name: 'apps' }),
      nav('go-explore', 'Explore', 'g e', { name: 'explore' }),
      nav('go-replay', 'Replay', 'g r', { name: 'replay' }),
      nav('go-data', 'Data', 'g d', { name: 'data' }),
    ];
    if (s.terminalEnabled) {
      list.push({
        id: 'toggle-terminal',
        label: 'Toggle Claude Code terminal',
        group: 'Actions',
        keys: ['mod+j'],
        run: toggleTerminal,
      });
    }
    return list;
  }, [s.terminalEnabled, toggleTerminal]);
  const hotkeys = useGlobalHotkeys(commands);

  // Re-resolve the selection from the live store so the inspector shows the freshest
  // copy (e.g. a response that filled in), falling back to the frozen snapshot if the
  // capture has since aged out of the store window.
  const selectedCapture = useMemo(() => {
    if (!selected) return null;
    return s.captures.find((c) => c.id === selected.id) ?? selected;
  }, [s.captures, selected]);

  // Surface each new notice as a toast, auto-dismissing after a few seconds.
  const noticeId = s.notice?.id ?? 0;
  useEffect(() => {
    const n = s.notice;
    if (!n) return;
    setToast(n);
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
    // Keyed on the notice id so it fires once per notice, not once per frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeId]);

  /** Open a capture found somewhere else (the overview) where it can be read. */
  const inspect = useCallback((c: Capture) => {
    setSelected(c);
    navigate({ name: 'traffic' });
  }, []);

  /** Scope the traffic table to one app and show the result. */
  const scopeTraffic = useCallback((id: string) => {
    setAppFilter(id);
    navigate({ name: 'traffic' });
  }, []);

  /**
   * The catalog card's secondary action. Turning a filter ON navigates to what
   * it filtered; turning it off leaves you on the catalog, because "clear" is
   * not a request to go somewhere.
   */
  const toggleAppFilter = useCallback(
    (id: string) => {
      const next = appFilter === id ? '' : id;
      setAppFilter(next);
      if (next) navigate({ name: 'traffic' });
    },
    [appFilter],
  );

  // Gate the whole app. The caveats have to be seen before any captured traffic
  // is, which means before the shell renders — not tucked behind a help link.
  if (!consented) return <FirstRunConsent onAccept={() => setConsented(true)} />;

  let page: ReactNode;
  switch (route.name) {
    case 'overview':
      page = <Overview captures={s.captures} onSelect={inspect} />;
      break;
    case 'traffic':
      page = (
        <TrafficPage
          captures={s.captures}
          connection={s.connection}
          capturePaused={s.capturePaused}
          noticeId={noticeId}
          appFilter={appFilter}
          selected={selectedCapture}
          onSelect={setSelected}
        />
      );
      break;
    case 'apps':
      page = <AppCatalog apps={s.apps} filteredId={appFilter} onFilter={toggleAppFilter} />;
      break;
    case 'app':
      page = (
        <AppDetail id={route.id} apps={s.apps} captures={s.captures} onFilterTraffic={scopeTraffic} />
      );
      break;
    case 'explore':
      page = <ExplorePage containerId={route.containerId} />;
      break;
    case 'replay':
      page = (
        <ReplayPage
          actionId={route.actionId}
          apps={s.apps}
          replays={s.replays}
          budget={s.replayBudget}
        />
      );
      break;
    case 'data':
      page = <DataBrowser />;
      break;
    default: {
      const _never: never = route;
      void _never;
      page = null;
    }
  }

  return (
    <div className="app">
      <NavBar
        route={route}
        connection={s.connection}
        retries={s.retries}
        appVersion={s.appVersion}
        engines={s.engines}
        capturePaused={s.capturePaused}
        environment={s.environment}
        terminalEnabled={s.terminalEnabled}
        terminalOpen={termOpen}
        onToggleTerminal={toggleTerminal}
      />

      <main className="min-h-0 flex-1 overflow-hidden">{page}</main>

      {toast ? (
        <div className={`toast toast-${toast.level}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      ) : null}

      <ActivityLog operations={s.operations} />

      {/* Mounted once opened, then kept alive so hide/show does not end the session. */}
      {termMounted ? <Terminal open={termOpen} onClose={() => setTermOpen(false)} /> : null}

      <CommandPalette commands={commands} open={hotkeys.paletteOpen} onClose={() => hotkeys.setPaletteOpen(false)} />
      <KeyCheatsheet commands={commands} open={hotkeys.cheatOpen} onClose={() => hotkeys.setCheatOpen(false)} />
    </div>
  );
}
