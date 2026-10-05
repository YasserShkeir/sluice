// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react';
import { fetchApiDoc, fetchTable, listTables } from '../api.js';
import { StoragePanel } from './StoragePanel.js';
import { Button } from '../ui/button.js';
import { cn } from '../ui/cn.js';
import { useAsync } from '../use-async.js';

/**
 * The Cartographer's output, made visible.
 *
 * Typed per-app tables (`slack_channel`, `trello_card`, …) and the endpoint catalog
 * the Cartographer derives. Fetched when the route opens and never polled (tables
 * are rewritten continuously during a live capture).
 */
type Mode = 'storage' | 'tables' | 'apidoc';

const PAGE = 50;

const thClass =
  'sticky top-0 whitespace-nowrap border-b border-border-2 bg-bg-2 px-2.5 py-1 text-left font-medium text-fg-dim';
const tdClass =
  'max-w-[260px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-border px-2.5 py-0.5';

export function DataBrowser() {
  const [mode, setMode] = useState<Mode>('storage');

  return (
    <section className="flex h-full min-h-0 flex-col bg-bg-1">
      <header className="flex items-center gap-3.5 px-3 py-1.5">
        <span className="p-0.5 text-[length:var(--fs)] text-fg">Data &amp; storage</span>
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
      </header>
      {mode === 'storage' ? <StoragePanel /> : mode === 'tables' ? <Tables /> : <ApiDoc />}
    </section>
  );
}

function Tables() {
  // The table list once on mount — see the component docstring.
  const { data: list, error: listError } = useAsync(listTables, []);
  const tables = list?.tables;
  const [selected, setSelected] = useState('');
  const [offset, setOffset] = useState(0);
  const current = selected || tables?.[0]?.name || '';
  // Keyed on table AND offset, so a slow page for the previous table cannot land
  // over the current one.
  const { data: page, error: pageError } = useAsync(
    () => (current ? fetchTable(current, PAGE, offset) : null),
    [current, offset],
  );
  const error = listError ?? pageError;

  if (error) return <p className="px-3.5 py-4 text-[12.5px] text-err">Could not load tables: {error}</p>;
  if (tables === undefined) return <p className="px-3.5 py-4 text-[12.5px] text-fg-mute">Loading…</p>;
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
              t.name === current ? 'bg-accent-dim text-fg' : 'text-fg-dim hover:bg-bg-2',
            )}
            onClick={() => {
              setSelected(t.name);
              setOffset(0);
            }}
            title={`${t.columns.length} columns`}
          >
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{t.name}</span>
            <span className="tabnum flex-none text-fg-mute">{t.rows}</span>
          </button>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {page !== undefined ? (
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
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                ← prev
              </Button>
              <Button
                size="sm"
                disabled={offset + PAGE >= page.total}
                onClick={() => setOffset(offset + PAGE)}
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

function ApiDoc() {
  const { data: map, error } = useAsync(fetchApiDoc, []);

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
