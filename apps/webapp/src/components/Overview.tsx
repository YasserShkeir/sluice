// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useState } from 'react';
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
    <section className="overview" aria-label="Traffic overview">
      <div className="ov-head">
        <span className="ov-title">Overview</span>
        <span className="muted small">
          live · derived from the last {fmtInt(captures.length)} captures (SQLite is the full record)
        </span>
      </div>

      {/* ── KPI tiles ─────────────────────────────────────────────────────── */}
      <div className="kpi-row">
        <Kpi value={fmtInt(kpis.total)} label="Total requests" />
        <Kpi value={fmtInt(kpis.reqPerMin)} label="Req / min" hint="last 60s" />
        <Kpi value={fmtInt(kpis.distinctEndpoints)} label="Endpoints" hint="method+host+path" />
        <Kpi value={fmtInt(kpis.distinctApps)} label="Apps" hint="adapters" />
        <Kpi value={formatPct(kpis.errorRate)} label="Error rate" hint="≥ 400" sev={errSev} />
        <Kpi value={kpis.p95Ms === null ? '—' : formatDuration(kpis.p95Ms)} label="p95 latency" />
        <Kpi value={formatBytes(kpis.bytes)} label="Data" hint="response bodies" />
      </div>

      {/* ── Charts ────────────────────────────────────────────────────────── */}
      <div className="charts-row">
        <div className="chart-card">
          <div className="chart-title">Requests over time</div>
          <RequestsChart series={series} />
        </div>
        <div className="chart-card">
          <div className="chart-title">Status distribution</div>
          <StatusDonut dist={dist} />
        </div>
        <div className="chart-card">
          <div className="chart-title">Top endpoints</div>
          <EndpointBars tops={tops} />
        </div>
      </div>

      {/* ── Smart cards ───────────────────────────────────────────────────── */}
      <div className="cards-row">
        <div className="ov-card">
          <div className="ov-card-head">
            <span>Recent errors</span>
            <span className="muted small">status ≥ 400 or ok:false</span>
          </div>
          {errs.length === 0 ? (
            <div className="ov-card-empty">No errors in view.</div>
          ) : (
            <ul className="ov-list">
              {errs.map((e) => (
                <li key={e.id}>
                  <button type="button" className="ov-list-row" onClick={() => pick(e.id)}>
                    <span className={`status-badge ${statusClass(e.status)}`}>{e.status ?? 'ERR'}</span>
                    <span className="ov-ep mono" title={`${e.host}${e.path}`}>
                      {e.host}
                      {e.path}
                    </span>
                    <span className="ov-reason muted" title={e.reason}>
                      {e.reason}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ov-card">
          <div className="ov-card-head">
            <span>Slowest endpoints</span>
            <span className="muted small">by max duration</span>
          </div>
          {slow.length === 0 ? (
            <div className="ov-card-empty">No timings yet.</div>
          ) : (
            <ul className="ov-list">
              {slow.map((s) => (
                <li key={s.key}>
                  <button type="button" className="ov-list-row" onClick={() => pick(s.id)}>
                    <span className="ov-method mono">{s.method}</span>
                    <span className="ov-ep mono" title={s.hostPath}>
                      {s.hostPath}
                    </span>
                    {s.count > 1 ? <span className="ov-count muted small tabnum">×{s.count}</span> : null}
                    <span className="ov-dur tabnum">{formatDuration(s.durationMs)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
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
  return (
    <div className="kpi">
      <div className={`kpi-val tabnum${sev ? ` kpi-sev-${sev}` : ''}`}>{value}</div>
      <div className="kpi-label">
        {label}
        {hint ? <span className="kpi-hint"> · {hint}</span> : null}
      </div>
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

  if (n === 0 || max === 0) return <div className="chart-empty">No requests yet.</div>;

  const x = (i: number): number => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number): number => padT + plotH - (v / max) * plotH;
  const base = padT + plotH;
  const pts = buckets.map((b, i) => `${x(i).toFixed(1)},${y(b.count).toFixed(1)}`);
  const line = `M ${pts.join(' L ')}`;
  const area = `M ${x(0).toFixed(1)},${base.toFixed(1)} L ${pts.join(' L ')} L ${x(n - 1).toFixed(1)},${base.toFixed(1)} Z`;

  return (
    <svg
      className="chart-svg"
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
    <div className="donut-wrap">
      <svg className="donut" viewBox="0 0 42 42" role="img" aria-label="Status code distribution">
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
      <ul className="donut-legend">
        {segs.map((s) => (
          <li key={s.key}>
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            <span className="lg-label">{s.key}</span>
            <span className="lg-val tabnum">{fmtInt(s.value)}</span>
            <span className="lg-pct muted tabnum">{total > 0 ? `${Math.round((s.value / total) * 100)}%` : '—'}</span>
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

  if (tops.length === 0) return <div className="chart-empty">No endpoints yet.</div>;

  const H = padT + tops.length * rowH + 2;
  const max = tops[0]!.count;

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Top endpoints by request count">
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
