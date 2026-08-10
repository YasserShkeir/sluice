// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from 'react';
import { fetchApiDoc, fetchTable, listTables } from '../api.js';
import { StoragePanel } from './StoragePanel.js';
import type { TableInfo, TablePage } from '../api.js';

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

export function DataBrowser() {
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<Mode>('storage');

  return (
    <section className="databrowser">
      <header className="db-head">
        <button type="button" className="db-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? '▾' : '▸'} Data & storage
        </button>
        {open ? (
          <div className="db-modes">
            <button type="button" className={mode === 'storage' ? 'on' : ''} onClick={() => setMode('storage')}>
              Storage
            </button>
            <button type="button" className={mode === 'tables' ? 'on' : ''} onClick={() => setMode('tables')}>
              Per-app tables
            </button>
            <button type="button" className={mode === 'apidoc' ? 'on' : ''} onClick={() => setMode('apidoc')}>
              API catalog
            </button>
          </div>
        ) : (
          <span className="muted db-hint">
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

  if (error) return <p className="db-empty err">Could not load tables: {error}</p>;
  if (!tables) return <p className="db-empty muted">Loading…</p>;
  if (tables.length === 0) {
    return (
      <p className="db-empty muted">
        No per-app tables yet. They are derived from captured responses — capture some traffic, or
        run <code>sluice build-db</code>.
      </p>
    );
  }

  return (
    <div className="db-body">
      <aside className="db-tablelist">
        {tables.map((t) => (
          <button type="button"
            key={t.name}
            className={t.name === selected ? 'on' : ''}
            onClick={() => setSelected(t.name)}
            title={`${t.columns.length} columns`}
          >
            <span className="db-tname">{t.name}</span>
            <span className="db-trows tabnum">{t.rows}</span>
          </button>
        ))}
      </aside>

      <div className="db-grid">
        {page ? (
          <>
            <div className="db-gridscroll">
              <table className="db-table">
                <thead>
                  <tr>
                    {page.columns.map((c) => (
                      <th key={c}>{c}</th>
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
                        <td key={c} title={cellText(row[c])}>
                          {cellText(row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="db-pager">
              <span className="muted tabnum">
                {page.total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE, page.total)} of {page.total}
              </span>
              <button type="button"
                disabled={offset === 0}
                onClick={() => {
                  const next = Math.max(0, offset - PAGE);
                  setOffset(next);
                  load(selected, next);
                }}
              >
                ← prev
              </button>
              <button type="button"
                disabled={offset + PAGE >= page.total}
                onClick={() => {
                  const next = offset + PAGE;
                  setOffset(next);
                  load(selected, next);
                }}
              >
                next →
              </button>
            </footer>
          </>
        ) : (
          <p className="db-empty muted">Loading rows…</p>
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

  if (error) return <p className="db-empty err">Could not load the catalog: {error}</p>;
  if (!map) return <p className="db-empty muted">Loading…</p>;

  const endpoints = map.endpoints ?? [];
  if (endpoints.length === 0) {
    return <p className="db-empty muted">Nothing captured yet — the catalog is built from real traffic.</p>;
  }

  return (
    <div className="db-body">
      <div className="db-grid">
        <div className="db-gridscroll">
          <table className="db-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Host</th>
                <th>Path</th>
                <th>Status</th>
                <th>Params</th>
                <th>Seen</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={e.key}>
                  <td>{e.method}</td>
                  <td title={e.hosts.join(', ')}>{e.hosts[0] ?? '—'}</td>
                  <td title={e.path}>{e.path}</td>
                  <td className="tabnum">{e.statuses.join(', ') || '—'}</td>
                  <td title={e.requestParams.join(', ')}>
                    {e.requestParams.length > 0 ? `${e.requestParams.length}` : '—'}
                  </td>
                  <td className="tabnum">{e.sampleCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="db-pager">
          <span className="muted tabnum">{endpoints.length} endpoints</span>
        </footer>
      </div>
    </div>
  );
}
