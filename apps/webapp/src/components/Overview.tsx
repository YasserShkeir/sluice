// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Capture } from '@sluice/core';
import { formatBytes, formatClock, formatDuration, statusClass } from '../format.js';
import {
  computeKpis,
  recentErrors,
  requestSeries,
  slowestEndpoints,
  statusDistribution,
  topEndpoints,
} from '../analytics.js';
import type { EndpointCount, StatusDist, TimeSeries } from '../analytics.js';

interface Props {
  /** oldest → newest, straight from the store (capped at 8000) */
  captures: Capture[];
  /** open a capture in the inspector drawer */
  onSelect: (c: Capture) => void;
}

const fmtInt = (n: number): string => n.toLocaleString();
const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const hms = (ms: number): string => formatClock(ms).slice(0, 8);

function formatPct(x: number): string {
  const p = x * 100;
  if (p === 0) return '0%';
  if (p < 10) return `${p.toFixed(1)}%`;
  return `${Math.round(p)}%`;
}

/**
 * Live overview built entirely from the store's capture window. Three bands:
 * a KPI tile row, a charts row (hand-rolled inline SVG), and two smart cards.
 * Recomputed against the frozen per-frame snapshot plus a 5s tick so time-window
 * figures (req/min) decay honestly even when traffic stalls.
 */
export function Overview({ captures, onSelect }: Props) {
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const kpis = useMemo(() => computeKpis(captures, nowTick), [captures, nowTick]);
  const series = useMemo(() => requestSeries(captures, 30, nowTick), [captures, nowTick]);
  const dist = useMemo(() => statusDistribution(captures), [captures]);
  const tops = useMemo(() => topEndpoints(captures, 6), [captures]);
  const errs = useMemo(() => recentErrors(captures, 6), [captures]);
  const slow = useMemo(() => slowestEndpoints(captures, 6), [captures]);

  const byId = useMemo(() => {
    const m = new Map<string, Capture>();
    for (const c of captures) m.set(c.id, c);
    return m;
  }, [captures]);
  const pick = (id: string): void => {
    const c = byId.get(id);
    if (c) onSelect(c);
  };

  const errSev = kpis.errorRate >= 0.05 ? 'err' : kpis.errorRate >= 0.01 ? 'warn' : 'ok';

  return (
    <section className="flex flex-col gap-2.5 px-3 pb-3.5 pt-2.5" aria-label="Traffic overview">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-fg">Overview</span>
        <span className="text-[11px] text-fg-mute">
          live · derived from the last {fmtInt(captures.length)} captures (SQLite is the full record)
        </span>
      </div>

      {/* ── KPI tiles ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-7 gap-2 max-[1100px]:grid-cols-[repeat(auto-fit,minmax(130px,1fr))]">
        <Kpi value={fmtInt(kpis.total)} label="Total requests" />
        <Kpi value={fmtInt(kpis.reqPerMin)} label="Req / min" hint="last 60s" />
        <Kpi value={fmtInt(kpis.distinctEndpoints)} label="Endpoints" hint="method+host+path" />
        <Kpi value={fmtInt(kpis.distinctApps)} label="Apps" hint="adapters" />
        <Kpi value={formatPct(kpis.errorRate)} label="Error rate" hint="≥ 400" sev={errSev} />
        <Kpi value={kpis.p95Ms === null ? '—' : formatDuration(kpis.p95Ms)} label="p95 latency" />
        <Kpi value={formatBytes(kpis.bytes)} label="Data" hint="response bodies" />
      </div>

      {/* ── Charts ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-[1.5fr_1.3fr_1.5fr] gap-2 max-[1000px]:grid-cols-[repeat(auto-fit,minmax(250px,1fr))]">
        <ChartCard title="Requests over time">
          <RequestsChart series={series} />
        </ChartCard>
        <ChartCard title="Status distribution">
          <StatusDonut dist={dist} />
        </ChartCard>
        <ChartCard title="Top endpoints">
          <EndpointBars tops={tops} />
        </ChartCard>
      </div>

      {/* ── Smart cards ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-2">
        <SmartCard title="Recent errors" hint="status ≥ 400 or ok:false">
          {errs.length === 0 ? (
            <div className="px-0.5 py-2.5 text-[11px] text-fg-mute">No errors in view.</div>
          ) : (
            <ul className="m-0 list-none p-0">
              {errs.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => pick(e.id)}
                    className="flex w-full items-center gap-2 border-b border-bg-2 px-1 py-0.5 font-mono text-[11.5px] last:border-b-0 hover:bg-bg-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-accent"
                  >
                    <span className={`status-badge ${statusClass(e.status)}`}>{e.status ?? 'ERR'}</span>
                    <span className="min-w-0 flex-1 truncate text-fg" title={`${e.host}${e.path}`}>
                      {e.host}
                      {e.path}
                    </span>
                    <span className="max-w-[42%] shrink truncate text-fg-mute" title={e.reason}>
                      {e.reason}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SmartCard>

        <SmartCard title="Slowest endpoints" hint="by max duration">
          {slow.length === 0 ? (
            <div className="px-0.5 py-2.5 text-[11px] text-fg-mute">No timings yet.</div>
          ) : (
            <ul className="m-0 list-none p-0">
              {slow.map((s) => (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => pick(s.id)}
                    className="flex w-full items-center gap-2 border-b border-bg-2 px-1 py-0.5 font-mono text-[11.5px] last:border-b-0 hover:bg-bg-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-accent"
                  >
                    <span className="w-10 shrink-0 text-fg-dim">{s.method}</span>
                    <span className="min-w-0 flex-1 truncate text-fg" title={s.hostPath}>
                      {s.hostPath}
                    </span>
                    {s.count > 1 ? (
                      <span className="shrink-0 tabular-nums text-[11px] text-fg-mute">×{s.count}</span>
                    ) : null}
                    <span className="shrink-0 tabular-nums text-fg-dim">{formatDuration(s.durationMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SmartCard>
      </div>
    </section>
  );
}

// ── KPI tile ───────────────────────────────────────────────────────────────

interface KpiProps {
  value: string;
  label: string;
  hint?: string;
  sev?: 'ok' | 'warn' | 'err';
}
function Kpi({ value, label, hint, sev }: KpiProps) {
  const sevCls =
    sev === 'ok' ? 'text-ok' : sev === 'warn' ? 'text-warn' : sev === 'err' ? 'text-err' : 'text-fg';
  return (
    <div className="min-w-0 rounded-md border border-border bg-bg-1 px-2.5 py-2">
      <div className={`truncate text-[20px] font-semibold leading-tight tabular-nums ${sevCls}`}>{value}</div>
      <div className="mt-0.5 truncate text-[10.5px] uppercase tracking-wide text-fg-dim">
        {label}
        {hint ? <span className="normal-case tracking-normal text-fg-mute"> · {hint}</span> : null}
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-md border border-border bg-bg-1 px-2.5 py-2">
      <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-fg-dim">{title}</div>
      {children}
    </div>
  );
}

function SmartCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-md border border-border bg-bg-1 px-2.5 py-2">
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[10.5px] uppercase tracking-wider text-fg-dim">
        <span>{title}</span>
        <span className="normal-case tracking-normal text-fg-mute">{hint}</span>
      </div>
      {children}
    </div>
  );
}

// ── Chart: requests over time (area + line) ──────────────────────────────────

function RequestsChart({ series }: { series: TimeSeries }) {
  const W = 320;
  const H = 120;
  const padL = 6;
  const padR = 6;
  const padT = 14;
  const padB = 16;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const { buckets, max, start, end } = series;
  const n = buckets.length;

  if (n === 0 || max === 0) return <div className="px-0.5 py-5 text-[11px] text-fg-mute">No requests yet.</div>;

  const x = (i: number): number => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number): number => padT + plotH - (v / max) * plotH;
  const base = padT + plotH;
  const pts = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.count).toFixed(1)}`);
  const line = `M ${pts.join(' L ')}`;
  const area = `M ${x(0).toFixed(1)},${base.toFixed(1)} L ${pts.join(' L ')} L ${x(n - 1).toFixed(1)},${base.toFixed(1)} Z`;

  return (
    <svg
      className="block h-auto w-full"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Requests over time; peak ${max} per bucket`}
    >
      <line x1={padL} y1={base} x2={W - padR} y2={base} style={{ stroke: 'var(--border-2)' }} strokeWidth={1} />
      <path d={area} style={{ fill: 'var(--accent)' }} opacity={0.16} />
      <path
        d={line}
        style={{ stroke: 'var(--accent)' }}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <text x={padL} y={10} style={{ fill: 'var(--fg-dim)' }} fontSize={9}>
        peak {max}/bkt
      </text>
      <text x={padL} y={H - 4} style={{ fill: 'var(--fg-dim)' }} fontSize={9}>
        {hms(start)}
      </text>
      <text x={W - padR} y={H - 4} style={{ fill: 'var(--fg-dim)' }} fontSize={9} textAnchor="end">
        {hms(end)}
      </text>
    </svg>
  );
}

// ── Chart: status distribution donut + legend ────────────────────────────────

function StatusDonut({ dist }: { dist: StatusDist }) {
  const segs = [
    { key: '2xx', value: dist.c2, color: 'var(--ok)' },
    { key: '3xx', value: dist.c3, color: 'var(--info)' },
    { key: '4xx', value: dist.c4, color: 'var(--warn)' },
    { key: '5xx', value: dist.c5, color: 'var(--err)' },
    { key: 'pending', value: dist.pending, color: 'var(--none)' },
  ];
  const total = dist.total;
  let acc = 0; // cumulative percent, for dash offsets

  return (
    <div className="flex items-center gap-3">
      <svg className="h-24 w-24 shrink-0" viewBox="0 0 42 42" role="img" aria-label="Status code distribution">
        <circle cx={21} cy={21} r={15.915} fill="none" style={{ stroke: 'var(--bg-3)' }} strokeWidth={6} />
        {total > 0 &&
          segs.map((s) => {
            if (s.value === 0) return null;
            const pct = (s.value / total) * 100;
            const dash = `${pct.toFixed(2)} ${(100 - pct).toFixed(2)}`;
            const offset = 25 - acc; // start at 12 o'clock, sweep clockwise
            acc += pct;
            return (
              <circle
                key={s.key}
                cx={21}
                cy={21}
                r={15.915}
                fill="none"
                style={{ stroke: s.color }}
                strokeWidth={6}
                strokeDasharray={dash}
                strokeDashoffset={offset}
              />
            );
          })}
        <text x={21} y={20.5} textAnchor="middle" style={{ fill: 'var(--fg)' }} fontSize={7} className="tabnum">
          {fmtInt(total)}
        </text>
        <text x={21} y={25.5} textAnchor="middle" style={{ fill: 'var(--fg-dim)' }} fontSize={3.6}>
          requests
        </text>
      </svg>
      <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-0.5 p-0 text-[11px]">
        {segs.map((s) => (
          <li key={s.key} className="grid grid-cols-[10px_auto_1fr_auto] items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
            <span className="text-fg">{s.key}</span>
            <span className="tabular-nums text-fg">{fmtInt(s.value)}</span>
            <span className="text-right tabular-nums text-fg-mute">
              {total > 0 ? `${Math.round((s.value / total) * 100)}%` : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Chart: top endpoints (horizontal bars) ───────────────────────────────────

function EndpointBars({ tops }: { tops: EndpointCount[] }) {
  const W = 320;
  const rowH = 20;
  const gap = 3;
  const padT = 2;

  if (tops.length === 0) return <div className="px-0.5 py-5 text-[11px] text-fg-mute">No endpoints yet.</div>;

  const H = padT + tops.length * rowH + 2;
  const max = tops[0]!.count;

  return (
    <svg className="block h-auto w-full" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Top endpoints by request count">
      {tops.map((e, i) => {
        const yTop = padT + i * rowH;
        const barH = rowH - gap;
        const cy = yTop + barH / 2;
        const bw = Math.max(2, (e.count / max) * W);
        const label = truncate(`${e.method} ${e.hostPath}`, 42);
        return (
          <g key={e.key}>
            <rect x={0} y={yTop} width={W} height={barH} rx={2} style={{ fill: 'var(--bg-3)' }} />
            <rect x={0} y={yTop} width={bw} height={barH} rx={2} style={{ fill: 'var(--info)' }} opacity={0.5} />
            <text x={5} y={cy} dominantBaseline="central" style={{ fill: 'var(--fg)' }} fontSize={9.5}>
              {label}
            </text>
            <text
              x={W - 4}
              y={cy}
              dominantBaseline="central"
              textAnchor="end"
              style={{ fill: 'var(--fg-dim)' }}
              fontSize={9.5}
              className="tabnum"
            >
              {e.count}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
