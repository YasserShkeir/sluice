// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';
import { fetchApiDoc, fetchTable, listTables } from '../api.js';
import { StoragePanel } from './StoragePanel.js';
import type { TableInfo, TablePage } from '../api.js';
import { Button } from '../ui/button.js';
import { cn } from '../ui/cn.js';

/**
 * The Cartographer's output, made visible.
 *
 * Sluice has always derived two useful artifacts from captured traffic — typed
 * per-app tables (`slack_channel`, `trello_card`, …) and an endpoint catalog —
 * and neither was reachable from the product: the tables were written on every
 * capture and only readable via the `sqlite3` CLI, and the catalog only via
 * `sluice apidoc`. That made the whole materialize step read as dead weight.
 *
 * Fetching is still lazy, but the gate moved: it used to be a pane collapsed by
 * default inside the single dashboard, so opening it was the signal to fetch.
 * It is a route now, and navigating to it IS that signal — during a live capture
 * these tables are rewritten continuously, and there is still no reason to poll
 * them from a page nobody is looking at.
 */
type Mode = 'storage' | 'tables' | 'apidoc';

const PAGE = 50;

const thClass =
  'sticky top-0 whitespace-nowrap border-b border-border-2 bg-bg-2 px-2.5 py-1 text-left font-medium text-fg-dim';
const tdClass =
  'max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-border px-2.5 py-0.5';

export function DataBrowser() {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<Mode>('storage');

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-1">
      <header className="flex items-center gap-3.5 px-3 py-1.5">
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0.5 text-[length:var(--fs)] text-fg"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? '▾' : '▸'} Data & storage
        </button>
        {open ? (
          <div className="flex gap-1">
            {(
              [
                ['storage', 'Storage'],
                ['tables', 'Per-app tables'],
                ['apidoc', 'API catalog'],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                size="sm"
                variant={mode === id ? 'primary' : 'default'}
                aria-pressed={mode === id}
                onClick={() => setMode(id)}
              >
                {label}
              </Button>
            ))}
          </div>
        ) : (
          <span className="text-[11.5px] text-fg-mute">
            typed tables + the endpoint catalog built from what you captured
          </span>
        )}
      </header>
      {open ? mode === 'storage' ? <StoragePanel /> : mode === 'tables' ? <Tables /> : <ApiDoc /> : null}
    </section>
  );
}

function Tables() {
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [page, setPage] = useState<TablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    listTables()
      .then((r) => {
        setTables(r.tables);
        if (r.tables.length > 0 && !selected) setSelected(r.tables[0]!.name);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    // Intentionally once on mount — see the component docstring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback((name: string, off: number) => {
    if (!name) return;
    fetchTable(name, PAGE, off)
      .then(setPage)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    setOffset(0);
    load(selected, 0);
  }, [selected, load]);

  if (error) return <p className="px-3.5 py-4 text-[12.5px] text-err">Could not load tables: {error}</p>;
  if (!tables) return <p className="px-3.5 py-4 text-[12.5px] text-fg-mute">Loading…</p>;
  if (tables.length === 0) {
    return (
      <p className="px-3.5 py-4 text-[12.5px] text-fg-mute">
        No per-app tables yet. They are derived from captured responses — capture some traffic, or
        run <code className="font-mono text-fg">sluice build-db</code>.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-0 border-t border-border">
      <aside className="w-[210px] flex-none overflow-y-auto border-r border-border">
        {tables.map((t) => (
          <button
            type="button"
            key={t.name}
            className={cn(
              'flex w-full cursor-pointer items-center justify-between gap-2 border-0 border-b border-border bg-transparent px-2.5 py-1.5 text-left font-mono text-[11.5px]',
              t.name === selected ? 'bg-accent-dim text-fg' : 'text-fg-dim hover:bg-bg-2',
            )}
            onClick={() => setSelected(t.name)}
            title={`${t.columns.length} columns`}
          >
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{t.name}</span>
            <span className="tabnum flex-none text-fg-mute">{t.rows}</span>
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {page ? (
          <>
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full border-collapse font-mono text-[11.5px]">
                <thead>
                  <tr>
                    {page.columns.map((c) => (
                      <th key={c} className={thClass}>
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, i) => (
                    // Materialized rows have no guaranteed stable key — some tables are
                    // content-hashed rather than id-keyed — and the list is replaced
                    // wholesale on every page change, so the index is the honest key.
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are replaced wholesale per page
                    <tr key={i}>
                      {page.columns.map((c) => (
                        <td key={c} className={tdClass} title={cellText(row[c])}>
                          {cellText(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="flex items-center gap-2.5 border-t border-border px-2.5 py-1.5">
              <span className="tabnum text-fg-mute">
                {page.total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, page.total)} of {page.total}
              </span>
              <Button
                size="sm"
                disabled={offset === 0}
                onClick={() => {
                  const next = Math.max(0, offset - PAGE);
                  setOffset(next);
                  load(selected, next);
                }}
              >
                ← prev
              </Button>
              <Button
                size="sm"
                disabled={offset + PAGE >= page.total}
                onClick={() => {
                  const next = offset + PAGE;
                  setOffset(next);
                  load(selected, next);
                }}
              >
                next →
              </Button>
            </footer>
          </>
        ) : (
          <p className="px-3.5 py-4 text-[12.5px] text-fg-mute">Loading rows…</p>
        )}
      </div>
    </div>
  );
}

/** SQLite gives back primitives; render them compactly and never as "[object Object]". */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Mirrors `ApiEndpoint` from @sluice/cartographer, narrowed to what's rendered. */
interface ApiEndpointShape {
  key: string;
  method: string;
  path: string;
  hosts: string[];
  statuses: number[];
  requestParams: string[];
  sampleCount: number;
}
interface ApiMapShape {
  endpoints?: ApiEndpointShape[];
}

function ApiDoc() {
  const [map, setMap] = useState<ApiMapShape | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchApiDoc()
      .then((m) => setMap(m as ApiMapShape))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="px-3.5 py-4 text-[12.5px] text-err">Could not load the catalog: {error}</p>;
  if (!map) return <p className="px-3.5 py-4 text-[12.5px] text-fg-mute">Loading…</p>;

  const endpoints = map.endpoints ?? [];
  if (endpoints.length === 0) {
    return (
      <p className="px-3.5 py-4 text-[12.5px] text-fg-mute">
        Nothing captured yet — the catalog is built from real traffic.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse font-mono text-[11.5px]">
          <thead>
            <tr>
              <th className={thClass}>Method</th>
              <th className={thClass}>Host</th>
              <th className={thClass}>Path</th>
              <th className={thClass}>Status</th>
              <th className={thClass}>Params</th>
              <th className={thClass}>Seen</th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((e) => (
              <tr key={e.key}>
                <td className={tdClass}>{e.method}</td>
                <td className={tdClass} title={e.hosts.join(', ')}>
                  {e.hosts[0] ?? '—'}
                </td>
                <td className={tdClass} title={e.path}>
                  {e.path}
                </td>
                <td className={cn(tdClass, 'tabnum')}>{e.statuses.join(', ') || '—'}</td>
                <td className={tdClass} title={e.requestParams.join(', ')}>
                  {e.requestParams.length > 0 ? `${e.requestParams.length}` : '—'}
                </td>
                <td className={cn(tdClass, 'tabnum')}>{e.sampleCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="flex items-center gap-2.5 border-t border-border px-2.5 py-1.5">
        <span className="tabnum text-fg-mute">{endpoints.length} endpoints</span>
      </footer>
    </div>
  );
}
