// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Everything Sluice knows about ONE app, on one page.
 *
 * The catalog card answers "how far is this built"; four ticks and a count. It
 * cannot answer the question people actually arrive with — what did Sluice
 * collect for this app, and what can I now do with it — so that question gets a
 * page, and the MCP tools are its centre because they are the answer to the
 * second half. Everything else on the page is context for them: the hosts say
 * what was decrypted to make them possible, the endpoints say what was seen, the
 * replay actions say what can be sent back.
 *
 * All of it comes from the catalog entry the runner already broadcasts, plus the
 * live capture window for the endpoint table. No fetch: a page that had to load
 * would be blank for exactly as long as the interesting part takes to arrive.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Check, ChevronLeft, Circle } from 'lucide-react';
import type { AppCatalogEntry, Capture } from '@sluice/core';
import { appEndpoints, capturesForApp } from '../analytics.js';
import type { AppEndpointRow } from '../analytics.js';
import { formatClock } from '../format.js';
import { Button } from '../ui/button.js';
import { useLink } from '../router.js';

interface Props {
  id: string;
  /** the runner's catalog; empty until the first `apps` broadcast lands */
  apps: AppCatalogEntry[];
  /** the live window, for the endpoints actually observed */
  captures: Capture[];
  /** scope the traffic table to this app and go there */
  onFilterTraffic: (id: string) => void;
}

export function AppDetail({ id, apps, captures, onFilterTraffic }: Props) {
  const link = useLink();
  const app = apps.find((a) => a.id === id);

  const endpoints = useMemo(
    () => (app ? appEndpoints(capturesForApp(captures, app)) : []),
    [captures, app],
  );

  // An empty catalog means the first broadcast has not arrived, which is not the
  // same as "no such app" — saying so would accuse the user of a typo during
  // every page load.
  if (!app) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-fg-dim">
        <p>{apps.length === 0 ? 'Waiting for the app catalog…' : `No app called “${id}”.`}</p>
        <a {...link({ name: 'apps' })} className="text-accent">
          ← All apps
        </a>
      </div>
    );
  }

  const built = app.build.adapter;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-5 px-5 py-4 pb-10">
        <header className="flex flex-col gap-2">
          <a
            {...link({ name: 'apps' })}
            className="inline-flex w-fit items-center gap-1 text-[11.5px] text-fg-dim no-underline hover:text-fg"
          >
            <ChevronLeft className="h-3 w-3" aria-hidden />
            Apps &amp; sites
          </a>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-[22px] font-semibold text-fg">{app.displayName}</h1>
            {app.capturing ? (
              <span className="badge-live">● capturing</span>
            ) : built ? (
              <span className="badge-idle">idle</span>
            ) : (
              <span className="badge-planned">planned</span>
            )}
            <span className="font-mono text-[11.5px] text-fg-mute">{app.id}</span>
            <div className="ml-auto flex gap-2">
              <Button onClick={() => onFilterTraffic(app.id)} disabled={!built}>
                Filter traffic by this app
              </Button>
            </div>
          </div>
        </header>

        <BuildStrip app={app} />

        {/* ── The point of the page ──────────────────────────────────────── */}
        <Panel
          title="MCP tools"
          meta={`${app.mcpTools.length} exposed`}
          lede="What an MCP client — Claude, say — can call against this app once the Sluice MCP server is connected. Parameters are the tool's own; the data behind them is what you captured locally."
        >
          {app.mcpTools.length === 0 ? (
            <Empty>
              {built
                ? 'This adapter contributes no MCP tools yet. The core store tools (search captures, list endpoints) still reach its traffic.'
                : 'No adapter yet — an app contributes MCP tools through its adapter package.'}
            </Empty>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {app.mcpTools.map((t) => (
                <article
                  key={t.name}
                  className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-bg-1 p-4"
                >
                  <h3 className="m-0 font-mono text-[14px] font-semibold break-all text-fg">{t.name}</h3>
                  <p className="m-0 text-[12.5px] leading-relaxed text-fg-dim">{t.description}</p>
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    {t.params.length === 0 ? (
                      <span className="text-[11px] text-fg-mute">no parameters</span>
                    ) : (
                      t.params.map((p) => <Chip key={p}>{p}</Chip>)
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <div className="grid gap-5 lg:grid-cols-2">
          <Panel
            title="Replay actions"
            meta={`${app.replayActions.length} available`}
            lede="Requests Sluice can rebuild and send again with your live session, without you writing the call."
          >
            {app.replayActions.length === 0 ? (
              <Empty>This adapter exposes no replay actions.</Empty>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {app.replayActions.map((r) => (
                  <li key={r.id} className="rounded-lg border border-border bg-bg-1 p-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono text-[11px] text-fg-dim">{r.method}</span>
                      <span className="text-[13px] font-medium text-fg">{r.label}</span>
                      <span className="ml-auto font-mono text-[11px] text-fg-mute">{r.id}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.params.length === 0 ? (
                        <span className="text-[11px] text-fg-mute">no parameters</span>
                      ) : (
                        r.params.map((p) => (
                          <Chip key={p.name} title={`${p.kind}${p.required ? ' · required' : ''}`}>
                            {p.name}
                            <span className="text-fg-mute">:{p.kind}</span>
                            {p.required ? <span className="text-warn">*</span> : null}
                          </Chip>
                        ))
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Intercepted hosts"
            meta={`${app.hosts.length} claimed`}
            lede="Exactly what the proxy decrypts for this app — nothing else on this machine is intercepted on its behalf."
          >
            {app.hosts.length === 0 ? (
              <Empty>No adapter, so no host is decrypted for this app.</Empty>
            ) : (
              <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                {app.hosts.map((h) => (
                  <li key={h}>
                    <Chip>{h}</Chip>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <Panel
          title="Observed endpoints"
          meta={`${endpoints.length} in view · ${app.stats.endpoints.toLocaleString()} all-time`}
          lede="Grouped from the live capture window. The runner's SQLite store holds the full history — the all-time figure comes from there."
        >
          {endpoints.length === 0 ? (
            <Empty>Nothing captured for this app in the live window yet.</Empty>
          ) : (
            <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
              <table className="w-full border-collapse font-mono text-[11.5px] [&_th]:sticky [&_th]:top-0 [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:border-border-2 [&_th]:bg-bg-2 [&_th]:px-2.5 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium [&_th]:text-fg-dim [&_td]:max-w-[260px] [&_td]:overflow-hidden [&_td]:text-ellipsis [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:border-border [&_td]:px-2.5 [&_td]:py-0.5">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Host</th>
                    <th>Path</th>
                    <th>Status</th>
                    <th>Calls</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((e) => (
                    <EndpointRow key={e.key} row={e} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ── Build status + stats ─────────────────────────────────────────────────────

function BuildStrip({ app }: { app: AppCatalogEntry }) {
  const steps = [
    { on: app.build.adapter, label: 'Adapter' },
    { on: app.build.data, label: 'Captured data' },
    { on: app.build.db, label: 'Local DB' },
    { on: app.build.mcp, label: 'MCP tools' },
  ];
  const stats: Array<[string, number]> = [
    ['Captures', app.stats.captures],
    ['Endpoints', app.stats.endpoints],
    ['Workspaces', app.stats.workspaces],
    ['Channels', app.stats.containers],
    ['Users', app.stats.actors],
    ['Messages', app.stats.items],
  ];
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4">
        {steps.map((s) => (
          <li
            key={s.label}
            className={[
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]',
              s.on ? 'border-ok/40 bg-ok/5 text-fg' : 'border-border bg-bg-1 text-fg-mute',
            ].join(' ')}
          >
            {s.on ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
            {s.label}
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {stats.map(([label, value]) => (
          <div key={label} className="kpi">
            <div className="kpi-val tabnum">{value.toLocaleString()}</div>
            <div className="kpi-label">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Endpoint row ─────────────────────────────────────────────────────────────

function EndpointRow({ row }: { row: AppEndpointRow }) {
  return (
    <tr>
      <td>{row.method}</td>
      <td title={row.host}>{row.host}</td>
      <td title={row.path}>{row.path}</td>
      <td className={row.errors > 0 ? 'text-warn' : ''} title={row.errors > 0 ? `${row.errors} failed` : ''}>
        {row.statuses.length === 0 ? '—' : row.statuses.join(', ')}
      </td>
      <td className="tabnum">{row.count.toLocaleString()}</td>
      <td className="tabnum">{formatClock(row.lastTs)}</td>
    </tr>
  );
}

// ── Small shared pieces ──────────────────────────────────────────────────────

function Panel({
  title,
  meta,
  lede,
  children,
}: {
  title: string;
  meta?: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-3 border-b border-border pb-1.5">
        <h2 className="m-0 text-[13px] font-semibold tracking-wide text-fg uppercase">{title}</h2>
        {meta ? <span className="font-mono text-[11px] text-fg-mute">{meta}</span> : null}
      </div>
      {lede ? <p className="m-0 max-w-[70ch] text-[12px] leading-relaxed text-fg-dim">{lede}</p> : null}
      {children}
    </section>
  );
}

function Chip({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center rounded border border-border-2 bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg"
    >
      {children}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 rounded-lg border border-dashed border-border px-3 py-4 text-[12.5px] text-fg-mute">
      {children}
    </p>
  );
}
