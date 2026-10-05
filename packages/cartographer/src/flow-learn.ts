// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Learn multi-step flow templates from observed InteractionFlow rows.
 *
 * Single-request learning (`learnRequestTemplate`) diffs method+path captures.
 * This module diffs whole bursts that share a primary operation: which companions
 * ride along, in what order, with what support, and which body/query values are
 * flow params vs frozen literals vs cross-step binds.
 *
 * Sibling timing: for each companion we also record the median offset from the
 * primary capture's wall clock (`offsetFromPrimaryMsP50`) and how tight that
 * cluster is (`offsetSpreadMs`). Replay uses those so "call history, then members
 * ~40ms later, emoji ~80ms later" matches the observed deltas — not only the
 * chained gap from whichever step ran last (which drifts when a soft step skips).
 *
 * Observation-only: only flows with `source: 'observed' | 'pinned'` contribute.
 * Prior `replay` flows are ignored so templates never train on our own traffic.
 *
 * Honest limits (same spirit as faithful.ts):
 *   - Redacted secrets are never stored on the template.
 *   - Values that only appear in a prior response and cannot be bound by a
 *     simple equality match are left as unreproducible rather than invented.
 *   - Write/admin-shaped ops are refused at learn time (deny-list probe).
 *   - A step whose method is not GET/HEAD is never learned from an extension
 *     capture (a page can forge those), and, when the caller passes the
 *     adapters, only when it matches one of the adapter's replay actions — the
 *     same positive rail flow build enforces.
 */

import type {
  Adapter,
  Capture,
  FlowParamSource,
  FlowStep,
  FlowStepRole,
  FlowTemplate,
  FlowTemplateInput,
  FlowTemplateStep,
  InteractionFlow,
  SqliteStore,
} from '@sluice/core';
import { looksLikeDeniedWrite, MASK, safeJsonObject, safeJsonParse } from '@sluice/core';
import { learnRequestTemplate } from './faithful.js';
import { FLOW_TEMPLATE_VERSION, isVettedRead } from './flow-build.js';
import type { ReadAction } from './flow-build.js';
import { isAssetCapture } from './flows.js';

/** Companion must appear in at least this fraction of samples to be required. */
const REQUIRED_SUPPORT = 0.85;

/** Minimum observed flows of a primary before we emit a template. */
const MIN_SAMPLES = 1;

/** Body/query keys that are always session-injected, never learned as literals. */
const SESSION_KEYS = new Set([
  'token',
  'auth',
  'authorization',
  'access_token',
  'accessToken',
  'api_key',
  'apiKey',
  'key',
  'cookie',
]);

export interface LearnFlowTemplatesOptions {
  adapterId?: string;
  /** Override min samples per primary (default 1 — useful with sparse stores). */
  minSamples?: number;
  /** When true, persist each template via store.upsertFlowTemplate. Default true. */
  persist?: boolean;
  /**
   * The installed adapters. When given, a non-GET/HEAD step is learned only if
   * it matches one of its adapter's replay actions (an adapter not listed has
   * none), so templates never carry a step flow build would refuse. Omitted,
   * such steps are kept and flow build refuses them.
   */
  adapters?: ReadonlyArray<Pick<Adapter, 'id' | 'listReplayActions'>>;
}

/**
 * Cluster is assumed done — this reads stored flows and produces templates.
 * Returns the learned templates (also persisted when `persist` is not false).
 */
export function learnFlowTemplates(
  store: SqliteStore,
  opts: LearnFlowTemplatesOptions = {},
): FlowTemplate[] {
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  const flows = store
    .listFlows({ adapterId: opts.adapterId, limit: 50_000 })
    .filter((f) => f.source === 'observed' || f.source === 'pinned');

  const readActionCache = new Map<string, readonly ReadAction[]>();
  const readActionsFor = (adapterId: string): readonly ReadAction[] | undefined => {
    if (!opts.adapters) return undefined;
    const actions =
      readActionCache.get(adapterId) ?? opts.adapters.find((a) => a.id === adapterId)?.listReplayActions() ?? [];
    readActionCache.set(adapterId, actions);
    return actions;
  };

  // Group by adapter + primary operation key.
  const groups = new Map<string, InteractionFlow[]>();
  for (const f of flows) {
    const primary = f.steps.find((s) => s.captureId === f.primaryCaptureId) ?? f.steps[0];
    if (!primary) continue;
    const cap = store.getCapture(f.primaryCaptureId);
    if (!cap) continue;
    const primaryKey = primaryKeyOf(primary.operation, cap);
    if (isDenied(primaryKey, cap) || !isLearnableRequest(cap, readActionsFor(f.adapterId))) continue;
    const gkey = `${f.adapterId}\0${primaryKey}`;
    const list = groups.get(gkey);
    if (list) list.push(f);
    else groups.set(gkey, [f]);
  }

  const out: FlowTemplate[] = [];
  for (const [, group] of groups) {
    if (group.length < minSamples) continue;
    const tmpl = learnOnePrimary(store, group, readActionsFor(group[0]!.adapterId));
    if (!tmpl) continue;
    out.push(opts.persist === false ? { ...tmpl, id: 'ephemeral' } : store.upsertFlowTemplate(tmpl));
  }
  out.sort((a, b) => b.sampleCount - a.sampleCount || a.primaryKey.localeCompare(b.primaryKey));

  // Drop superseded rows: asset primaries, unnormalized shortLink keys left from
  // older ingest (card/AbCd1234) once card/:id exists, and templates from an
  // older learner that were not re-learned (their primary no longer qualifies,
  // so they would only keep failing). Only when persisting.
  if (opts.persist !== false) {
    const keep = new Set(out.map((t) => `${t.adapterId}\0${t.primaryKey}`));
    for (const old of store.listFlowTemplates({ adapterId: opts.adapterId, limit: 50_000 })) {
      const key = `${old.adapterId}\0${old.primaryKey}`;
      if (keep.has(key)) continue;
      if (
        isAssetOp(old.primaryKey) ||
        normalizeOp(old.primaryKey) !== old.primaryKey ||
        old.version < FLOW_TEMPLATE_VERSION
      ) {
        store.deleteFlowTemplate(old.id);
      }
    }
  }

  return out;
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Whether a captured request may train a template step. A non-read method is
 * never learned from an extension capture (a page can forge those) and, when
 * the adapter's replay actions are known, only when it matches one of them.
 */
function isLearnableRequest(cap: Capture, readActions: readonly ReadAction[] | undefined): boolean {
  if (cap.source === 'ext') return isVettedRead(cap, []); // a page can forge any non-GET/HEAD
  return readActions === undefined || isVettedRead(cap, readActions);
}

/** Whether an observed step becomes a template step: no asset companion, no denied or unvetted request. */
function becomesTemplateStep(step: FlowStep, cap: Capture, readActions: readonly ReadAction[] | undefined): boolean {
  if (step.role !== 'primary' && isAssetCapture(cap)) return false;
  return !isDenied(step.operation ?? '', cap) && isLearnableRequest(cap, readActions);
}

type StepCapture = { step: FlowStep; cap: Capture };

/** A flow's steps in seq order paired with their stored captures; missing captures are skipped. */
function stepCaptures(flow: InteractionFlow, store: SqliteStore): StepCapture[] {
  const out: StepCapture[] = [];
  for (const step of flow.steps.slice().sort((a, b) => a.seq - b.seq)) {
    const cap = store.getCapture(step.captureId);
    if (cap) out.push({ step, cap });
  }
  return out;
}

function primaryKeyOf(operation: string | undefined, cap: Capture): string {
  const op = operation?.trim() || cap.classification?.trim();
  if (op) return normalizeOp(op);
  return normalizeOp(`${cap.method} ${cap.path}`.replace(/^\w+\s+/, '')) || `${cap.method} ${normalizePath(cap.path)}`;
}

function isDenied(primaryKey: string, cap: Capture): boolean {
  return looksLikeDeniedWrite(cap.method, primaryKey, cap.path, cap.url, cap.classification, cap.reqBody);
}

function learnOnePrimary(
  store: SqliteStore,
  flows: InteractionFlow[],
  readActions: readonly ReadAction[] | undefined,
): FlowTemplateInput | undefined {
  const first = flows[0]!;
  const primaryCap = store.getCapture(first.primaryCaptureId);
  if (!primaryCap || !first.adapterId) return undefined;

  // Asset-seeded primaries (hashed SPA bundles) produce noise templates and
  // must not train — pickPrimary should already avoid this; belt-and-suspenders.
  const primaryStep = first.steps.find((s) => s.captureId === first.primaryCaptureId);
  const primaryKey = primaryKeyOf(primaryStep?.operation, primaryCap);
  if (isAssetCapture(primaryCap) || isAssetOp(primaryKey)) return undefined;

  // Collect every step observation: key = role|method|operationOrPath
  type StepObs = {
    key: string;
    role: FlowStepRole;
    method: string;
    path: string;
    operation?: string;
    capture: Capture;
    /** ms after previous step within its flow */
    delayMs: number;
    /** ms from this flow's primary capture ts (negative if before primary) */
    offsetFromPrimaryMs: number;
    /** seq within its flow */
    seq: number;
  };

  const byKey = new Map<string, StepObs[]>();
  const flowParamNames = new Set<string>();

  for (const flow of flows) {
    const ordered = stepCaptures(flow, store);

    const primaryInFlow =
      ordered.find((o) => o.step.captureId === flow.primaryCaptureId)?.cap ??
      ordered.find((o) => o.step.role === 'primary')?.cap ??
      ordered[0]?.cap;
    const primaryTs = primaryInFlow?.ts ?? flow.startedAt;

    let prevTs = ordered[0]?.cap.ts ?? flow.startedAt;
    for (let i = 0; i < ordered.length; i++) {
      const { step, cap } = ordered[i]!;
      // Denied and unvetted requests never become template steps, and neither
      // do soft static assets — they bloat GraphQL boot storms and are not
      // replayable as meaningful API companions.
      if (!becomesTemplateStep(step, cap, readActions)) continue;
      const delayMs = i === 0 ? 0 : Math.max(0, cap.ts - prevTs);
      prevTs = cap.ts;
      const opRaw = step.operation ?? cap.classification ?? undefined;
      const op = opRaw ? normalizeOp(opRaw) : undefined;
      const key =
        step.role === 'primary'
          ? `primary|${cap.method}|${primaryKey}`
          : `${step.role}|${cap.method}|${op ?? normalizePath(cap.path)}`;
      const obs: StepObs = {
        key,
        role: step.role,
        method: cap.method,
        // Keep the observed path for request-template learning; collapse ids
        // only when emitting the template step (mostCommon of normalized).
        path: cap.path,
        operation: op,
        capture: cap,
        delayMs,
        offsetFromPrimaryMs: cap.ts - primaryTs,
        seq: step.seq,
      };
      const list = byKey.get(key);
      if (list) list.push(obs);
      else byKey.set(key, [obs]);
    }
  }

  const n = flows.length;
  const templateSteps: FlowTemplateStep[] = [];

  // Order steps by median seq across observations.
  const keysOrdered = [...byKey.entries()].sort((a, b) => {
    const medA = median(a[1].map((o) => o.seq));
    const medB = median(b[1].map((o) => o.seq));
    return medA - medB || a[0].localeCompare(b[0]);
  });

  // Primary capture bodies across flows — used to detect flow params.
  const primaryBodies = flows
    .map((f) => store.getCapture(f.primaryCaptureId))
    .filter(Boolean)
    .map((c) => parseParams(c!));

  const primaryVaryingKeys = varyingKeys(primaryBodies);
  for (const k of primaryVaryingKeys) {
    if (!SESSION_KEYS.has(k) && !isRedactedAcross(primaryBodies, k)) {
      flowParamNames.add(k);
    }
  }

  let seq = 0;
  for (const [, obsList] of keysOrdered) {
    const support = obsList.length / n;
    const sample = obsList[0]!;
    const role: FlowStepRole = sample.role;
    const required = role === 'primary' || (role !== 'auth' && support >= REQUIRED_SUPPORT);

    // Learn per-endpoint fingerprint from the store (mitm/cdp only).
    const reqTmpl = learnRequestTemplate(store, sample.method, sample.path, sample.capture.host);

    // Param sourcing: compare this step's bodies against primary + earlier steps.
    const stepBodies = obsList.map((o) => parseParams(o.capture));
    const params: Record<string, FlowParamSource> = {};
    const allKeys = new Set<string>();
    for (const b of stepBodies) for (const k of Object.keys(b)) allKeys.add(k);

    let unreproducible = false;
    let unreproducibleReason: string | undefined;

    for (const k of allKeys) {
      if (SESSION_KEYS.has(k) || isRedactedAcross(stepBodies, k)) {
        params[k] = { kind: 'session' };
        continue;
      }
      const values = stepBodies.map((b) => b[k]).filter((v): v is string => v !== undefined);
      if (values.length === 0) continue;

      const stable = values.every((v) => v === values[0]);
      if (stable && !primaryVaryingKeys.has(k)) {
        // Stable and not a primary-varying key → literal OK (also in request tmpl).
        params[k] = { kind: 'literal', value: values[0]! };
        continue;
      }

      // Matches a primary-varying key with the same values → flow param.
      if (primaryVaryingKeys.has(k) || flowParamNames.has(k)) {
        const aligned = alignsWithPrimary(flows, obsList, k, store);
        if (aligned) {
          params[k] = { kind: 'flowParam', name: k };
          flowParamNames.add(k);
          continue;
        }
      }

      // Cross-step bind: value appears in an earlier step's response JSON.
      const bind = findBind(flows, obsList, k, store, templateSteps, readActions);
      if (bind) {
        params[k] = bind;
        continue;
      }

      // Varies, not bindable, not a known flow param → unreproducible for this key.
      // Soft companions can still run without it; required steps get flagged.
      if (!stable) {
        if (required) {
          unreproducible = true;
          unreproducibleReason = `param ${k} varies and has no observed bind`;
        }
        params[k] = {
          kind: 'unreproducible',
          reason: `varies across observations; no bind found`,
        };
      } else {
        params[k] = { kind: 'literal', value: values[0]! };
      }
    }

    // If the request template itself is missing and this is required, still emit
    // the step — build time will fall back to capture reconstruction.
    const offsets = obsList.map((o) => o.offsetFromPrimaryMs);
    const offsetP50 = Math.round(median(offsets));
    const offsetSpread = Math.round(percentile(offsets, 0.9) - percentile(offsets, 0.1));

    // Named path placeholders (`/1/cards/{cardId}`) + flowParam sources so build
    // can substitute without leaving literal `:id` on the wire.
    const pathParamSources: Record<string, FlowParamSource> = {};
    const pathTemplate = mostCommon(
      obsList.map((o) => templatizePath(o.path, pathParamSources)),
    );

    for (const [name, src] of Object.entries(pathParamSources)) {
      if (params[name]) continue;
      params[name] = src;
      if (src.kind === 'flowParam') flowParamNames.add(name);
    }

    templateSteps.push({
      seq: seq++,
      role,
      method: sample.method,
      path: pathTemplate,
      host: mostCommon(obsList.map((o) => o.capture.host).filter(Boolean)) || undefined,
      operation: sample.operation,
      required: required && !unreproducible,
      support: Math.round(support * 100) / 100,
      // Chained gap (previous template step) — fallback when primary anchor N/A.
      delayMsP50: Math.round(median(obsList.map((o) => o.delayMs))),
      // Sibling spacing from the main call — preferred at replay.
      offsetFromPrimaryMsP50: offsetP50,
      offsetSpreadMs: Math.max(0, offsetSpread),
      request: reqTmpl,
      params: Object.keys(params).length > 0 ? params : undefined,
      unreproducible: unreproducible || undefined,
      unreproducibleReason,
    });
  }

  if (templateSteps.length === 0) return undefined;
  // Ensure exactly one primary.
  if (!templateSteps.some((s) => s.role === 'primary')) {
    const firstStep = templateSteps[0]!;
    firstStep.role = 'primary';
    firstStep.required = !firstStep.unreproducible;
  }

  return {
    adapterId: first.adapterId,
    primaryKey,
    label: primaryKey,
    sampleCount: n,
    version: FLOW_TEMPLATE_VERSION,
    learnedAt: Date.now(),
    steps: templateSteps,
    flowParams: [...flowParamNames].sort().map((name) => ({ name, required: true })),
  };
}

function normalizePath(path: string): string {
  // Collapse id-like segments so companions with different board/card ids group.
  // Align with core operationName: hex, uuid, Slack C-ids, Trello shortLinks.
  // Also fold singular REST resources onto the plural form classify prefers.
  // Grouping key uses `:id`; build-facing templates use named `{param}` via templatizePath.
  return path
    .split('?')[0]!
    .split('/')
    .map((seg) => (isIdLikeSegment(seg) ? ':id' : pluralSeg(seg)))
    .join('/');
}

function pluralSeg(seg: string): string {
  return RESOURCE_PLURAL[seg.toLowerCase()] ?? seg;
}

/**
 * Build-facing path: id-like segments become `{resourceId}` (or `{id}`, `{id2}`…)
 * and matching flowParam sources are recorded. Concrete non-id segments are kept
 * (with singular→plural fold for REST resources).
 */
function templatizePath(
  path: string,
  outParams: Record<string, FlowParamSource>,
): string {
  const segs = (path.split('?')[0] ?? path).split('/');
  const used = new Set<string>();
  let anon = 0;
  return segs
    .map((seg, i) => {
      if (!isIdLikeSegment(seg)) return pluralSeg(seg);
      // Prefer parent resource name: /1/cards/XYZ → {cardId}
      let baseName = 'id';
      for (let j = i - 1; j >= 0; j--) {
        const prev = segs[j];
        if (!prev || isIdLikeSegment(prev)) continue;
        const base = singularResource(prev);
        if (base) {
          baseName = `${base}Id`;
          break;
        }
      }
      if (baseName === 'id') {
        anon += 1;
        baseName = anon === 1 ? 'id' : `id${anon}`;
      }
      let finalName = baseName;
      if (used.has(finalName)) {
        let n = 2;
        while (used.has(`${baseName}${n}`)) n++;
        finalName = `${baseName}${n}`;
      }
      used.add(finalName);
      if (!outParams[finalName]) {
        outParams[finalName] = { kind: 'flowParam', name: finalName };
      }
      return `{${finalName}}`;
    })
    .join('/');
}

function isIdLikeSegment(seg: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/^\d{6,}$/.test(seg)) return true;
  if (/^[A-Z][A-Z0-9]{7,}$/.test(seg)) return true; // Slack-ish C0123AB…
  if (/^[a-f0-9]{16,}$/i.test(seg)) return true;
  // Trello shortLink: 8 alnum with both a letter and a digit
  if (/^(?=[a-zA-Z0-9]*\d)(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{8}$/.test(seg)) return true;
  return false;
}

function singularResource(seg: string): string | undefined {
  const plural = pluralSeg(seg.toLowerCase());
  // boards → board, cards → card, members → member
  if (plural.endsWith('ies') && plural.length > 3) return `${plural.slice(0, -3)}y`;
  if (plural.endsWith('s') && plural.length > 1) return plural.slice(0, -1);
  return plural || undefined;
}

function normalizeOp(op: string): string {
  // Same collapse on op tokens so card/AbCd1234 merges with cards/:id when mixed.
  return normalizePath(op.startsWith('/') ? op : `/${op}`).replace(/^\//, '');
}

function isAssetOp(key: string): boolean {
  const k = key.trim().toLowerCase();
  return k === 'asset' || k.startsWith('assets/') || /\.(js|css|png|jpe?g|gif|svg|woff2?|map)(\?|$)/i.test(k);
}

function parseParams(c: Capture): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const u = new URL(c.url);
    for (const [k, v] of u.searchParams) out[k] = v;
  } catch {
    /* ignore */
  }
  const body = c.reqBody ?? '';
  if (body.trimStart().startsWith('{')) {
    for (const [k, v] of Object.entries(safeJsonObject(body) ?? {})) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
  } else if (body) {
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  }
  return out;
}

function varyingKeys(bodies: Array<Record<string, string>>): Set<string> {
  const keys = new Set<string>();
  const all = new Set<string>();
  for (const b of bodies) for (const k of Object.keys(b)) all.add(k);
  for (const k of all) {
    const defined = bodies.map((b) => b[k]).filter((v) => v !== undefined);
    if (defined.some((v) => v !== defined[0])) keys.add(k);
  }
  return keys;
}

function isRedactedAcross(bodies: Array<Record<string, string>>, k: string): boolean {
  return bodies.some((b) => typeof b[k] === 'string' && b[k]!.includes(MASK));
}

function alignsWithPrimary(
  flows: InteractionFlow[],
  obsList: Array<{ capture: Capture }>,
  key: string,
  store: SqliteStore,
): boolean {
  // For each observation of this step, does param[key] equal the primary's param[key]?
  let hits = 0;
  let n = 0;
  for (const flow of flows) {
    const primary = store.getCapture(flow.primaryCaptureId);
    if (!primary) continue;
    const p = parseParams(primary)[key];
    if (p === undefined) continue;
    const inFlow = obsList.find((o) => flow.steps.some((s) => s.captureId === o.capture.id));
    if (!inFlow) continue;
    const s = parseParams(inFlow.capture)[key];
    if (s === undefined) continue;
    n++;
    if (s === p) hits++;
  }
  return n > 0 && hits / n >= 0.8;
}

function findBind(
  flows: InteractionFlow[],
  obsList: Array<{ capture: Capture }>,
  key: string,
  store: SqliteStore,
  earlierSteps: FlowTemplateStep[],
  readActions: readonly ReadAction[] | undefined,
): FlowParamSource | undefined {
  // Look for the value in earlier step responses within the same flow.
  // Only records a bind when the same earlier template seq + path works for most flows.
  // Map by capture identity → template seq (not raw burst index): assets/denied
  // captures are dropped from templates, so array index would mis-align fromStep.
  if (earlierSteps.length === 0) return undefined;

  type Cand = { fromStep: number; jsonPath: string };
  const votes = new Map<string, number>();

  for (const flow of flows) {
    const stepCap = obsList.find((o) => flow.steps.some((s) => s.captureId === o.capture.id));
    if (!stepCap) continue;
    const want = parseParams(stepCap.capture)[key];
    if (want === undefined || want.includes(MASK) || want.length < 2) continue;

    const ordered = stepCaptures(flow, store);

    const idx = ordered.findIndex((o) => o.cap.id === stepCap.capture.id);
    const before = idx >= 0 ? ordered.slice(0, idx) : ordered.slice(0, -1);

    for (let i = before.length - 1; i >= 0; i--) {
      const { step, cap } = before[i]!;
      // Skip captures that never become template steps (assets / denied / unvetted).
      if (!becomesTemplateStep(step, cap, readActions)) continue;

      const path = walk(safeJsonParse(cap.resBody), '', want, 0);
      if (!path) continue;

      const fromStep = templateSeqForCapture(step, cap, earlierSteps);
      if (fromStep === undefined) continue;

      const ck = `${fromStep}|${path}`;
      votes.set(ck, (votes.get(ck) ?? 0) + 1);
      break; // one bind candidate per flow (nearest earlier match)
    }
  }

  let best: Cand | undefined;
  let bestN = 0;
  for (const [ck, n] of votes) {
    if (n > bestN) {
      bestN = n;
      const [from, ...rest] = ck.split('|');
      best = { fromStep: Number(from), jsonPath: rest.join('|') };
    }
  }
  if (!best || bestN < Math.max(1, Math.ceil(flows.length * 0.5))) return undefined;
  return { kind: 'bind', fromStep: best.fromStep, jsonPath: best.jsonPath };
}

/**
 * Map an observed flow step capture onto an already-emitted template step seq
 * by role+method+normalized operation/path — never by raw burst index.
 */
function templateSeqForCapture(
  step: { role: string; operation?: string },
  cap: Capture,
  earlierSteps: FlowTemplateStep[],
): number | undefined {
  const rawOp = step.operation || cap.classification;
  const op = rawOp ? normalizeOp(rawOp) : undefined;
  const pathNorm = normalizePath(cap.path);

  // Prefer exact role+method+op, then method+op, then method+path.
  const scored = earlierSteps.map((t) => {
    let score = 0;
    if (t.method === cap.method) score += 2;
    if (t.role === step.role) score += 2;
    if (op && t.operation && normalizeOp(t.operation) === op) score += 4;
    else if (normalizePath(t.path) === pathNorm || pathNormMatchesTemplate(pathNorm, t.path))
      score += 3;
    return { seq: t.seq, score };
  });
  scored.sort((a, b) => b.score - a.score || a.seq - b.seq);
  const best = scored[0];
  if (!best || best.score < 4) return undefined;
  return best.seq;
}

/** True when a normalized `:id` path matches a `{param}` template path. */
function pathNormMatchesTemplate(pathNorm: string, templatePath: string): boolean {
  const a = pathNorm.split('/');
  const b = templatePath.split('?')[0]!.split('/');
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (x === ':id' && /^\{[^}]+\}$/.test(y)) continue;
    if (y === ':id' && /^\{[^}]+\}$/.test(x)) continue;
    return false;
  }
  return true;
}

function walk(node: unknown, path: string, want: string, depth: number): string | undefined {
  if (depth > 8) return undefined;
  if (node === want || ((typeof node === 'number' || typeof node === 'boolean') && String(node) === want)) return path || '$';
  if (Array.isArray(node)) {
    for (let i = 0; i < Math.min(node.length, 50); i++) {
      const p = walk(node[i], `${path}[${i}]`, want, depth + 1);
      if (p) return p;
    }
    return undefined;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const next = path ? `${path}.${k}` : k;
      const p = walk(v, next, want, depth + 1);
      if (p) return p;
    }
  }
  return undefined;
}

function median(nums: number[]): number {
  return percentile(nums, 0.5);
}

/** Inclusive percentile on a copy (p in 0..1). Empty → 0. */
function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const idx = (s.length - 1) * clamped;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo]!;
  const w = idx - lo;
  return s[lo]! * (1 - w) + s[hi]! * w;
}

function mostCommon(vals: string[]): string {
  const counts = new Map<string, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = vals[0] ?? '';
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}

/** REST resource singulars that adapters spell plural in classify (Trello). */
const RESOURCE_PLURAL: Record<string, string> = {
  card: 'cards',
  board: 'boards',
  member: 'members',
  list: 'lists',
  organization: 'organizations',
  checklist: 'checklists',
  label: 'labels',
  action: 'actions',
};
