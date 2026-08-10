// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pure, client-side selectors for the overview dashboard.
 *
 * Everything here is derived from the in-memory `captures[]` the webapp already
 * holds (a ring buffer capped at 8000 in ws.ts). This overview is therefore a
 * live, approximate view of the *recent* window only — the runner's SQLite store
 * is the real source of truth for full history. All functions are pure so they
 * memoize cleanly against the frozen per-frame snapshot.
 */
import type { Capture } from '@sluice/core';

/** "App" = the adapter that claimed the capture, or a stable 'unclassified' bucket. */
export function appOf(c: Capture): string {
  return c.adapterId ?? 'unclassified';
}

/** Stable identity of an endpoint: METHOD + host + path (query/order ignored). */
export function endpointKey(c: Capture): string {
  return `${c.method} ${c.host}${c.path}`;
}

// ── KPI tiles ────────────────────────────────────────────────────────────────

export interface Kpis {
  total: number;
  /** requests observed in the last 60s */
  reqPerMin: number;
  /** distinct METHOD+host+path */
  distinctEndpoints: number;
  /** distinct adapterId ?? 'unclassified' */
  distinctApps: number;
  /** 0..1, over captures that actually got a status (pending excluded) */
  errorRate: number;
  /** 95th-percentile duration in whole ms, or null when nothing timed yet */
  p95Ms: number | null;
  /** summed decoded response-body sizes, in bytes (≈ chars) */
  bytes: number;
}

export function computeKpis(captures: Capture[], now = Date.now()): Kpis {
  const endpoints = new Set<string>();
  const apps = new Set<string>();
  const durations: number[] = [];
  const since = now - 60_000;
  let reqLastMin = 0;
  let responded = 0;
  let errors = 0;
  let bytes = 0;

  for (const c of captures) {
    endpoints.add(endpointKey(c));
    apps.add(appOf(c));
    if (c.ts >= since) reqLastMin += 1;
    if (c.status !== null) {
      responded += 1;
      if (c.status >= 400) errors += 1;
    }
    if (c.durationMs !== null) durations.push(c.durationMs);
    if (c.resBody) bytes += c.resBody.length;
  }

  return {
    total: captures.length,
    reqPerMin: reqLastMin,
    distinctEndpoints: endpoints.size,
    distinctApps: apps.size,
    errorRate: responded === 0 ? 0 : errors / responded,
    p95Ms: percentile(durations, 0.95),
    bytes,
  };
}

/** Nearest-rank percentile (p in 0..1). Sorts a copy; returns null when empty. */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  const idx = Math.max(0, Math.min(sorted.length - 1, rank));
  return Math.round(sorted[idx]!);
}

// ── Requests-over-time series ────────────────────────────────────────────────

export interface TimeBucket {
  t0: number;
  t1: number;
  count: number;
}
export interface TimeSeries {
  buckets: TimeBucket[];
  /** tallest bucket, for y-scaling */
  max: number;
  start: number;
  end: number;
}

/** Bucket captures into `bucketCount` even slices over the observed time span. */
export function requestSeries(captures: Capture[], bucketCount = 30, now = Date.now()): TimeSeries {
  if (captures.length === 0) return { buckets: [], max: 0, start: now, end: now };

  let start = Infinity;
  let end = -Infinity;
  for (const c of captures) {
    if (c.ts < start) start = c.ts;
    if (c.ts > end) end = c.ts;
  }
  if (end <= start) end = start + 1; // degenerate single-instant span

  const span = end - start;
  const width = span / bucketCount;
  const buckets: TimeBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({ t0: start + i * width, t1: start + (i + 1) * width, count: 0 });
  }

  for (const c of captures) {
    let i = Math.floor((c.ts - start) / width);
    if (i < 0) i = 0;
    if (i >= bucketCount) i = bucketCount - 1;
    buckets[i]!.count += 1;
  }

  let max = 0;
  for (const b of buckets) if (b.count > max) max = b.count;
  return { buckets, max, start, end };
}

// ── Status-code distribution ─────────────────────────────────────────────────

export interface StatusDist {
  c2: number;
  c3: number;
  c4: number;
  c5: number;
  /** no status yet (in-flight) */
  pending: number;
  /** 1xx or other odd codes */
  other: number;
  total: number;
}

export function statusDistribution(captures: Capture[]): StatusDist {
  const d: StatusDist = { c2: 0, c3: 0, c4: 0, c5: 0, pending: 0, other: 0, total: captures.length };
  for (const c of captures) {
    if (c.status === null) {
      d.pending += 1;
      continue;
    }
    const k = Math.floor(c.status / 100);
    if (k === 2) d.c2 += 1;
    else if (k === 3) d.c3 += 1;
    else if (k === 4) d.c4 += 1;
    else if (k === 5) d.c5 += 1;
    else d.other += 1;
  }
  return d;
}

// ── Top endpoints by request count ───────────────────────────────────────────

export interface EndpointCount {
  key: string;
  method: string;
  hostPath: string;
  count: number;
}

export function topEndpoints(captures: Capture[], limit = 6): EndpointCount[] {
  const map = new Map<string, EndpointCount>();
  for (const c of captures) {
    const key = endpointKey(c);
    const e = map.get(key);
    if (e) e.count += 1;
    else map.set(key, { key, method: c.method, hostPath: `${c.host}${c.path}`, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

// ── Smart card: recent errors ────────────────────────────────────────────────

export interface ErrorRow {
  id: string;
  host: string;
  path: string;
  status: number | null;
  /** best-effort human reason parsed from the response body */
  reason: string;
}

/**
 * Per-capture "did this fail?" cache, keyed by capture id.
 *
 * Deciding this means JSON.parsing the response body, and the scan below walks
 * backwards until it finds `limit` errors — so on a healthy stream (fewer than
 * `limit` errors anywhere) it reached the entire ring buffer, parsing up to 8000
 * bodies of up to 5 MB each. And it re-ran on every animation frame, because the
 * snapshot hands out a fresh array identity per flush. Captures are immutable
 * once stored, so the verdict is safe to remember.
 */
const errorVerdict = new Map<string, { failed: boolean; reason: string }>();
/** Bound the cache so a long capture session can't grow it without limit. */
const VERDICT_CAP = 20_000;

function verdictFor(c: Capture): { failed: boolean; reason: string } {
  const hit = errorVerdict.get(c.id);
  if (hit) return hit;
  const httpErr = c.status !== null && c.status >= 400;
  const failed = httpErr || isNotOk(c.resBody);
  const v = { failed, reason: failed ? errorReason(c) : '' };
  if (errorVerdict.size >= VERDICT_CAP) errorVerdict.clear();
  errorVerdict.set(c.id, v);
  return v;
}

/** Latest `limit` captures that failed: HTTP >= 400, or a JSON `{ok:false}` body. */
export function recentErrors(captures: Capture[], limit = 6): ErrorRow[] {
  const out: ErrorRow[] = [];
  for (let i = captures.length - 1; i >= 0 && out.length < limit; i--) {
    const c = captures[i]!;
    const v = verdictFor(c);
    if (!v.failed) continue;
    out.push({ id: c.id, host: c.host, path: c.path, status: c.status, reason: v.reason });
  }
  return out;
}

// ── Smart card: slowest endpoints ────────────────────────────────────────────

export interface SlowRow {
  key: string;
  /** id of the single slowest capture for this endpoint (for click-to-inspect) */
  id: string;
  method: string;
  hostPath: string;
  /** the max observed duration for this endpoint, ms */
  durationMs: number;
  /** how many timed calls this endpoint has */
  count: number;
}

/** Endpoints ranked by their slowest observed call. */
export function slowestEndpoints(captures: Capture[], limit = 6): SlowRow[] {
  const map = new Map<string, SlowRow>();
  for (const c of captures) {
    if (c.durationMs === null) continue;
    const key = endpointKey(c);
    const e = map.get(key);
    if (!e) {
      map.set(key, {
        key,
        id: c.id,
        method: c.method,
        hostPath: `${c.host}${c.path}`,
        durationMs: c.durationMs,
        count: 1,
      });
    } else {
      e.count += 1;
      if (c.durationMs > e.durationMs) {
        e.durationMs = c.durationMs;
        e.id = c.id;
      }
    }
  }
  return [...map.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, limit);
}

// ── Per-app detail: attribution + observed endpoints ─────────────────────────

/**
 * What attribution needs from a catalog entry. Structural rather than the whole
 * `AppCatalogEntry` so this stays callable with a literal.
 */
export interface AppIdentity {
  id: string;
  hosts: readonly string[];
}

/** True when `host` is the claimed host or a subdomain of it. */
function onClaimedHost(host: string, claimed: readonly string[]): boolean {
  for (const h of claimed) {
    if (host === h || host.endsWith(`.${h}`)) return true;
  }
  return false;
}

/**
 * The captures that belong to one app.
 *
 * Two rules, not one, because the two facts mean different things. `adapterId`
 * is set by the adapter's `matchRequest`, which is deliberately narrow — Slack's
 * claims `/api/` and nothing else — while the proxy decrypts and records
 * EVERYTHING on the hosts that adapter names. Attributing by adapterId alone
 * gives an app page reporting no endpoints next to a traffic table full of that
 * app's hosts; attributing by host alone silently drops a capture the adapter
 * itself claimed on a host the catalog does not list. So: either one.
 */
export function capturesForApp(captures: Capture[], app: AppIdentity): Capture[] {
  const out: Capture[] = [];
  for (const c of captures) {
    if (c.adapterId === app.id || onClaimedHost(c.host, app.hosts)) out.push(c);
  }
  return out;
}

export interface AppEndpointRow {
  key: string;
  method: string;
  host: string;
  path: string;
  count: number;
  /** distinct statuses seen, ascending; pending and WS frames contribute none */
  statuses: number[];
  /** how many of those calls came back >= 400 */
  errors: number;
  /** ts of the most recent call, for "last seen" */
  lastTs: number;
}

/**
 * Observed endpoints, grouped by METHOD + host + path.
 *
 * Not `topEndpoints` with more columns: that one feeds a bar chart and is
 * recomputed on every frame for the whole ring buffer, so it stays as cheap as a
 * counter. This runs for one app's slice and carries what a capabilities page
 * has to answer — did these calls work, and when did we last see one.
 */
export function appEndpoints(captures: Capture[], limit = 200): AppEndpointRow[] {
  const map = new Map<string, AppEndpointRow & { seen: Set<number> }>();
  for (const c of captures) {
    const key = endpointKey(c);
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        method: c.method,
        host: c.host,
        path: c.path,
        count: 0,
        statuses: [],
        errors: 0,
        lastTs: c.ts,
        seen: new Set<number>(),
      };
      map.set(key, row);
    }
    row.count += 1;
    if (c.ts > row.lastTs) row.lastTs = c.ts;
    if (c.status !== null) {
      row.seen.add(c.status);
      if (c.status >= 400) row.errors += 1;
    }
  }
  const rows = [...map.values()].map(({ seen, ...row }) => ({
    ...row,
    statuses: [...seen].sort((a, b) => a - b),
  }));
  return rows.sort((a, b) => b.count - a.count || b.lastTs - a.lastTs).slice(0, limit);
}

// ── Body parsing helpers ─────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function parseBody(body: string | null): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** True when the response body is JSON with `ok: false` (Slack-style failure). */
function isNotOk(body: string | null): boolean {
  const o = asRecord(parseBody(body));
  return o !== null && o.ok === false;
}

/** Best-effort short reason: `error` / `error.message` / `message` / `ok:false` / HTTP. */
function errorReason(c: Capture): string {
  const o = asRecord(parseBody(c.resBody));
  if (o) {
    if (typeof o.error === 'string' && o.error) return o.error;
    const err = asRecord(o.error);
    if (err && typeof err.message === 'string' && err.message) return err.message;
    if (typeof o.message === 'string' && o.message) return o.message;
    if (o.ok === false) return 'ok: false';
  }
  if (c.status !== null && c.status >= 400) return `HTTP ${c.status}`;
  return 'error';
}
