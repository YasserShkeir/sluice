// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cluster captures into interaction flows.
 *
 * A flow is one primary capture plus the companions that rode with it in the
 * same burst — the multi-request shape a real client fires when opening a
 * channel, loading a board, or refreshing mail. Clustering is observational:
 * only real traffic sources (mitm/cdp/ext) are considered, and only captures
 * already in the store are grouped. Nothing is invented.
 *
 * Heuristics v1 (cheap, reviewable):
 *   1. Group by adapter, then by tabId when present, else by host family.
 *   2. Split a group into bursts where consecutive Δt ≤ windowMs (default 1000).
 *   3. Pick the primary: prefer a capture whose classification looks like a
 *      user-facing API op; fall back to the earliest non-asset-looking row.
 *   4. Mark auth-shaped rows as role `auth`; everything else in the burst is
 *      a soft companion (required=false). The primary is always required.
 *
 * Output is proposed FlowInput rows — call store.upsertFlow to persist. Auto-
 * write is intentionally not the default; a later CLI/MCP step can batch that.
 */

import type { Capture, FlowInput, FlowStep, FlowStepRole } from '@sluice/core';

/** Capture sources that reflect live client traffic (not our own replays). */
const OBSERVED_SOURCES = new Set(['mitm', 'cdp', 'ext']);

/** Default max gap between consecutive captures still counted as one burst. */
export const DEFAULT_FLOW_WINDOW_MS = 1000;

/**
 * Paths / ops that look like sign-in or token plumbing rather than the user
 * gesture. Matched case-insensitively against classification and path.
 */
const AUTH_HINT =
  /(?:^|[./_-])(auth|oauth|login|signin|token|session|csrf|bootstrap|identity|sso)(?:$|[./_-])/i;

/**
 * Static / non-API noise that should never seed a primary. Clustering still
 * keeps them as companions when they sit inside a burst (some SPAs hitch a
 * script fetch to the same gesture); they just never win primary selection.
 *
 * Also matches adapter-collapsed asset ops (`classification === 'asset'`) and
 * hashed SPA bundles under `/assets/…` without a file extension in the op name.
 */
const ASSET_HINT =
  /\.(?:js|css|png|jpe?g|gif|svg|woff2?|ttf|map|ico)(?:\?|$)/i;

/** True when a capture is static/bundle noise and must not seed a primary. */
export function isAssetCapture(c: Capture): boolean {
  const op = (c.classification ?? '').trim().toLowerCase();
  if (op === 'asset' || op.startsWith('assets/')) return true;
  if (ASSET_HINT.test(c.path)) return true;
  if (/^\/assets\//i.test(c.path)) return true;
  return false;
}

export interface ClusterFlowsOptions {
  /** Max inter-arrival gap inside one burst. Default {@link DEFAULT_FLOW_WINDOW_MS}. */
  windowMs?: number;
  /**
   * Only consider captures for this adapter. When omitted, every capture with a
   * non-null adapterId is eligible (grouped per adapter).
   */
  adapterId?: string;
  /**
   * Restrict to captures at or after this epoch ms. Useful for "re-cluster the
   * last hour" without re-walking the whole store.
   */
  sinceTs?: number;
  /**
   * Drop singleton bursts (primary with zero companions). Default true — a
   * flow of one is just a capture, and listing thousands of them drowns the
   * multi-step ones clustering is for.
   */
  minSteps?: number;
}

/**
 * Cluster an in-memory capture list into proposed flows. Pure: no store I/O.
 * Prefer {@link clusterCapturesIntoFlows} when you already have a store handle.
 */
export function clusterCaptureList(
  captures: readonly Capture[],
  opts: ClusterFlowsOptions = {},
): FlowInput[] {
  const windowMs = opts.windowMs ?? DEFAULT_FLOW_WINDOW_MS;
  const minSteps = opts.minSteps ?? 2;

  const eligible = captures.filter((c) => {
    if (!c.adapterId) return false;
    if (opts.adapterId && c.adapterId !== opts.adapterId) return false;
    if (opts.sinceTs !== undefined && c.ts < opts.sinceTs) return false;
    if (!OBSERVED_SOURCES.has(c.source)) return false;
    // WebSocket frames are a different model; leave them out of HTTP bursts.
    if (c.method === 'WS' || c.direction) return false;
    return true;
  });

  // Bucket: adapterId + (pageLoadId | tabId | host family).
  // F0.3: same document load is a stronger burst boundary than wall-clock alone.
  const buckets = new Map<string, Capture[]>();
  for (const c of eligible) {
    const family = hostFamily(c.host);
    const corr = c.pageLoadId ?? c.loaderId ?? c.navigationId;
    const key = corr
      ? `${c.adapterId}\0load:${corr}`
      : `${c.adapterId}\0${c.tabId ?? `host:${family}`}`;
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }

  const out: FlowInput[] = [];
  for (const group of buckets.values()) {
    group.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    for (const burst of splitBursts(group, windowMs)) {
      const flow = burstToFlow(burst);
      if (!flow) continue;
      if (flow.steps.length < minSteps) continue;
      out.push(flow);
    }
  }

  // Newest first — matches listFlows ordering and "what just happened".
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

/**
 * Read captures from the store and cluster them. Returns proposed FlowInput
 * rows; does not write. Callers persist with `store.upsertFlow`.
 *
 * `store` is typed loosely so this package does not take a hard dependency on
 * the full SqliteStore surface beyond listCaptures — tests can pass a stub.
 */
export function clusterCapturesIntoFlows(
  store: { listCaptures: (q?: { adapterId?: string; sinceTs?: number; limit?: number }) => Capture[] },
  opts: ClusterFlowsOptions & { limit?: number } = {},
): FlowInput[] {
  const captures = store.listCaptures({
    adapterId: opts.adapterId,
    sinceTs: opts.sinceTs,
    // Wide default: clustering needs the burst neighbours, not a tiny page.
    limit: opts.limit ?? 50_000,
  });
  return clusterCaptureList(captures, opts);
}

// ── internals ────────────────────────────────────────────────────────────────

function hostFamily(host: string): string {
  // strip leading www. so www.slack.com and slack.com share a bucket when
  // tabId is missing. Keep the rest intact — api.slack.com stays distinct from
  // app.slack.com only if we ever need that; for v1 same registrable-ish host
  // family is enough, and most adapters already pin one API host.
  return host.replace(/^www\./i, '').toLowerCase();
}

function splitBursts(sorted: Capture[], windowMs: number): Capture[][] {
  if (sorted.length === 0) return [];
  const bursts: Capture[][] = [];
  let cur: Capture[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const c = sorted[i]!;
    if (c.ts - prev.ts <= windowMs) {
      cur.push(c);
    } else {
      bursts.push(cur);
      cur = [c];
    }
  }
  bursts.push(cur);
  return bursts;
}

function burstToFlow(burst: Capture[]): FlowInput | undefined {
  if (burst.length === 0) return undefined;
  const adapterId = burst[0]!.adapterId;
  if (!adapterId) return undefined;

  const primary = pickPrimary(burst);
  if (!primary) return undefined;

  const steps: FlowStep[] = burst.map((c, seq) => {
    const role = stepRole(c, primary.id);
    return {
      captureId: c.id,
      seq,
      role,
      operation: operationOf(c),
      required: role === 'primary',
    };
  });

  // Ensure the primary is first in seq only if it already was; we keep time
  // order so later binding (F2) can walk response→request chronologically.
  return {
    adapterId,
    label: labelFor(primary),
    primaryCaptureId: primary.id,
    startedAt: burst[0]!.ts,
    endedAt: burst[burst.length - 1]!.ts,
    source: 'observed',
    steps,
  };
}

function pickPrimary(burst: Capture[]): Capture | undefined {
  // Prefer a classified, non-auth, non-asset API-looking capture. Among ties,
  // earliest wins — the gesture usually starts with the primary, companions
  // fan out after.
  const scored = burst
    .map((c) => ({ c, score: primaryScore(c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.ts - b.c.ts);

  if (scored[0]) return scored[0].c;

  // Nothing scored: take the earliest non-asset row, else the earliest row.
  return (
    burst.find((c) => !isAssetCapture(c) && !isAuthShaped(c)) ?? burst[0]
  );
}

function primaryScore(c: Capture): number {
  if (isAssetCapture(c)) return 0;
  if (isAuthShaped(c)) return 0;
  let score = 1;
  const op = operationOf(c);
  if (op) score += 5;
  // Prefer POST/GET API-ish paths over bare document navigations.
  if (c.method === 'POST' || c.method === 'GET') score += 1;
  if (c.path.includes('/api/') || c.path.includes('/graphql') || c.path.includes('/gateway/')) {
    score += 2;
  }
  // Prefer classic REST resource paths (card/board/member) over generic batch.
  if (/^\/1\//.test(c.path) || /^(cards?|boards?|members?|lists?)\b/i.test(op ?? '')) {
    score += 3;
  }
  // HTTP success is a weak positive; errors still can be primary of a failed gesture.
  if (c.status !== null && c.status >= 200 && c.status < 400) score += 1;
  return score;
}

function stepRole(c: Capture, primaryId: string): FlowStepRole {
  if (c.id === primaryId) return 'primary';
  if (isAuthShaped(c)) return 'auth';
  return 'companion';
}

function isAuthShaped(c: Capture): boolean {
  const op = operationOf(c) ?? '';
  return AUTH_HINT.test(op) || AUTH_HINT.test(c.path);
}

function operationOf(c: Capture): string | undefined {
  // `classification` holds the semantic op name when set at ingest
  // (conversations.history, boards/:id/cards, …). See Capture.classification.
  const op = c.classification?.trim();
  return op && op.length > 0 ? op : undefined;
}

function labelFor(primary: Capture): string {
  const op = operationOf(primary);
  if (op) return op;
  return `${primary.method} ${primary.path}`;
}
