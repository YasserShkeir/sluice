// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sequential multi-step flow replay.
 *
 * Each step goes through the same rails as a single replay: the caller supplies
 * `build` + `run` (typically faithfulReplayRequest → runReplay), so there is no
 * bulk bypass of method/operation policy or the process budget. Budget is
 * charged once per step inside `run`.
 *
 * Stop policy:
 *   - required step fails (throw or non-2xx when `failOnHttpError`) → stop
 *   - soft companion fails → record warning, continue
 *   - unreproducible required step with no build → fail the flow
 *   - unreproducible soft step → skip
 *
 * Auth refresh: on auth failure of any step, optional `refresh` re-extracts once
 * and the whole flow restarts once (simpler and safer than mid-flow resume when
 * bindings may already have consumed the stale session).
 *
 * Pacing: prefer each step's `offsetFromPrimaryMsP50` (median ms from the
 * primary's start) so siblings keep the same deltas as the observed burst even
 * when an earlier soft companion is skipped. Fall back to chained `delayMsP50`
 * for steps without a primary anchor (or templates learned before offsets).
 * Hard-capped per wait; overall schedule still respects the flow timeout.
 */

import { isAuthFailure, newId } from '@sluice/core';
import type {
  Capture,
  FlowTemplate,
  FlowTemplateStep,
  InteractionFlow,
  ReplayRequest,
  Session,
} from '@sluice/core';
import { ReplayDeniedError } from './replay-policy.js';

/** Hard cap on learned inter-step delay (observational pacing only). */
export const FLOW_DELAY_CAP_MS = 2_000;

/** Default overall wall-clock budget for one flow run. */
export const DEFAULT_FLOW_TIMEOUT_MS = 120_000;

export type FlowStepStatus =
  | 'ok'
  | 'skipped'
  | 'soft_fail'
  | 'denied'
  | 'error'
  | 'auth_fail';

export interface FlowStepResult {
  seq: number;
  role: FlowTemplateStep['role'];
  operation?: string;
  method: string;
  path: string;
  status: FlowStepStatus;
  captureId?: string;
  httpStatus?: number | null;
  detail?: string;
  durationMs?: number;
}

export interface FlowReplayResult {
  ok: boolean;
  /** Populated when the caller asked us to assemble a parent InteractionFlow. */
  flow?: InteractionFlow;
  steps: FlowStepResult[];
  /** True when the flow was restarted once after a credential refresh. */
  refreshed: boolean;
  error?: string;
}

export interface FlowReplayIO {
  /**
   * Build the outbound request for one template step.
   * Return null to skip (soft) or signal unreproducible.
   * Must derive auth from the session argument — closures over a stale session
   * break the refresh restart path.
   */
  build(step: FlowTemplateStep, session: Session, ctx: FlowBuildContext): ReplayRequest | null;
  /** Usually `runReplay`. Called sequentially, never nested. */
  run(req: ReplayRequest): Promise<Capture>;
  /** Persist each step capture (failed attempts included). */
  record?(capture: Capture, step: FlowTemplateStep): void;
  /** Re-extract credentials once for a full flow restart. */
  refresh?(): Promise<Session | undefined>;
}

export interface FlowBuildContext {
  /** Caller-supplied flow params (channel id, cursor, …). */
  params: Record<string, string>;
  /** Response JSON (parsed) per completed template seq, for binds. */
  priorResponses: Map<number, unknown>;
  /** Captures completed so far in this attempt. */
  priorCaptures: Capture[];
}

export interface RunFlowReplayOptions {
  template: FlowTemplate;
  params?: Record<string, string>;
  session: Session;
  io: FlowReplayIO;
  /** Cap on inter-step sleep. Default {@link FLOW_DELAY_CAP_MS}. */
  delayCapMs?: number;
  /** When false, skip learned delays. Default true. */
  pace?: boolean;
  /** Overall deadline. Default {@link DEFAULT_FLOW_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * Treat HTTP >= 400 on a required step as failure. Default true.
   * Auth failures are always special-cased via isAuthFailure.
   */
  failOnHttpError?: boolean;
  /** Allow one full restart after refresh. Default true. */
  allowRefreshRestart?: boolean;
}

/**
 * Run a learned flow template sequentially through the supplied IO hooks.
 */
export async function runFlowReplay(opts: RunFlowReplayOptions): Promise<FlowReplayResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS;
  const allowRestart = opts.allowRefreshRestart !== false;

  let session = opts.session;
  let refreshed = false;

  const attempt = async (): Promise<FlowReplayResult> => {
    const steps: FlowStepResult[] = [];
    const priorResponses = new Map<number, unknown>();
    const priorCaptures: Capture[] = [];
    const captureIds: string[] = [];
    let primaryCaptureId: string | undefined;
    const ordered = opts.template.steps.slice().sort((a, b) => a.seq - b.seq);
    let flowStartedAt = Date.now();
    let flowEndedAt = flowStartedAt;
    /** Wall clock when the primary step began — anchor for sibling offsets. */
    let primaryStartedAt: number | undefined;
    const delayCap = opts.delayCapMs ?? FLOW_DELAY_CAP_MS;
    const pace = opts.pace !== false;

    for (let i = 0; i < ordered.length; i++) {
      if (Date.now() - started > timeoutMs) {
        return {
          ok: false,
          refreshed,
          steps,
          error: `flow timed out after ${timeoutMs}ms`,
          flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
        };
      }

      const step = ordered[i]!;

      // Sibling pacing: hold until the learned offset from primary (or chained
      // gap before the primary is known). Never sleep past the overall deadline.
      if (pace) {
        const wait = nextPaceWaitMs(step, {
          primaryStartedAt,
          delayCapMs: delayCap,
          flowDeadlineAt: started + timeoutMs,
        });
        if (wait > 0) await sleep(wait);
      }

      if (step.unreproducible) {
        const row: FlowStepResult = {
          seq: step.seq,
          role: step.role,
          operation: step.operation,
          method: step.method,
          path: step.path,
          status: 'skipped',
          detail: step.unreproducibleReason ?? 'unreproducible',
        };
        steps.push(row);
        if (step.required) {
          return {
            ok: false,
            refreshed,
            steps,
            error: `required step ${step.seq} is unreproducible`,
            flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
          };
        }
        continue;
      }

      let req: ReplayRequest | null;
      try {
        req = opts.io.build(step, session, {
          params: opts.params ?? {},
          priorResponses,
          priorCaptures,
        });
      } catch (e) {
        if (isBuildDenied(e)) {
          steps.push(stepResult(step, 'denied', errMsg(e)));
          if (step.required) {
            return {
              ok: false,
              refreshed,
              steps,
              error: errMsg(e),
              flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
            };
          }
          continue;
        }
        const msg = errMsg(e);
        steps.push(stepResult(step, 'error', msg));
        if (step.required) {
          return {
            ok: false,
            refreshed,
            steps,
            error: msg,
            flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
          };
        }
        continue;
      }

      if (req === null) {
        steps.push(
          stepResult(step, 'skipped', 'build returned null'),
        );
        if (step.required) {
          return {
            ok: false,
            refreshed,
            steps,
            error: `required step ${step.seq} could not be built`,
            flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
          };
        }
        continue;
      }

      // Anchor sibling schedule at the moment we issue the primary — matches
      // capture `ts` (request start), not response completion.
      if (step.role === 'primary' && primaryStartedAt === undefined) {
        primaryStartedAt = Date.now();
      }

      let capture: Capture;
      try {
        capture = await opts.io.run(req);
      } catch (e) {
        if (e instanceof ReplayDeniedError) {
          steps.push(stepResult(step, 'denied', e.message));
          if (step.required) {
            return {
              ok: false,
              refreshed,
              steps,
              error: e.message,
              flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
            };
          }
          continue;
        }
        const msg = errMsg(e);
        steps.push(stepResult(step, 'error', msg));
        if (step.required) {
          return {
            ok: false,
            refreshed,
            steps,
            error: msg,
            flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
          };
        }
        continue;
      }

      opts.io.record?.(capture, step);
      priorCaptures.push(capture);
      captureIds.push(capture.id);
      flowEndedAt = capture.ts + (capture.durationMs ?? 0);
      if (step.role === 'primary') primaryCaptureId = capture.id;

      const bodyJson = tryParseJson(capture.resBody);
      if (bodyJson !== undefined) priorResponses.set(step.seq, bodyJson);

      if (isAuthFailure(capture)) {
        steps.push({
          ...stepResult(step, 'auth_fail', 'auth failure'),
          captureId: capture.id,
          httpStatus: capture.status,
          durationMs: capture.durationMs ?? undefined,
        });
        return {
          ok: false,
          refreshed,
          steps,
          error: 'auth failure',
          flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
        };
      }

      const failHttp = opts.failOnHttpError !== false;
      const badHttp =
        failHttp && capture.status !== null && capture.status >= 400;

      if (badHttp) {
        const status: FlowStepStatus = step.required ? 'error' : 'soft_fail';
        steps.push({
          ...stepResult(step, status, `HTTP ${capture.status}`),
          captureId: capture.id,
          httpStatus: capture.status,
          durationMs: capture.durationMs ?? undefined,
        });
        if (step.required) {
          return {
            ok: false,
            refreshed,
            steps,
            error: `required step ${step.seq} returned HTTP ${capture.status}`,
            flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
          };
        }
        continue;
      }

      steps.push({
        ...stepResult(step, 'ok'),
        captureId: capture.id,
        httpStatus: capture.status,
        durationMs: capture.durationMs ?? undefined,
      });
    }

    return {
      ok: steps.some((s) => s.status === 'ok' && s.role === 'primary') ||
        (steps.some((s) => s.status === 'ok') && !ordered.some((s) => s.role === 'primary')),
      refreshed,
      steps,
      flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
    };
  };

  let result = await attempt();

  if (
    !result.ok &&
    result.error === 'auth failure' &&
    allowRestart &&
    !refreshed &&
    opts.io.refresh
  ) {
    let fresh: Session | undefined;
    try {
      fresh = await opts.io.refresh();
    } catch {
      return result;
    }
    if (!fresh) return result;
    session = fresh;
    refreshed = true;
    result = await attempt();
    result.refreshed = true;
  }

  return result;
}

/**
 * Resolve a JSON path produced by flow-learn (`a.b[0].c`) against a response
 * body. Returns string form of the leaf, or undefined.
 */
export function resolveJsonPath(data: unknown, path: string): string | undefined {
  if (!path || path === '$') {
    return primitiveToString(data);
  }
  let cur: unknown = data;
  // Tokenize: split on . but keep [n] indices.
  const tokens = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (const raw of tokens) {
    if (cur == null) return undefined;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const idx = Number(raw.slice(1, -1));
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[raw];
    } else {
      return undefined;
    }
  }
  return primitiveToString(cur);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function maybeFlow(
  opts: RunFlowReplayOptions,
  primaryCaptureId: string | undefined,
  captureIds: string[],
  startedAt: number,
  endedAt: number,
  stepResults: FlowStepResult[],
): InteractionFlow | undefined {
  if (!primaryCaptureId || captureIds.length === 0) return undefined;
  const steps = stepResults
    .filter((s) => s.captureId)
    .map((s, seq) => ({
      captureId: s.captureId!,
      seq,
      role: s.role,
      operation: s.operation,
      required: opts.template.steps.find((t) => t.seq === s.seq)?.required ?? s.role === 'primary',
    }));
  if (steps.length === 0) return undefined;
  return {
    id: newId('flow'),
    adapterId: opts.template.adapterId,
    label: opts.template.label ?? opts.template.primaryKey,
    primaryCaptureId,
    startedAt,
    endedAt,
    source: 'replay',
    steps,
  };
}

function stepResult(
  step: FlowTemplateStep,
  status: FlowStepStatus,
  detail?: string,
): FlowStepResult {
  return {
    seq: step.seq,
    role: step.role,
    operation: step.operation,
    method: step.method,
    path: step.path,
    status,
    detail,
  };
}

function tryParseJson(body: string | null): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function primitiveToString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * How long to wait before issuing `step`, using learned sibling timing.
 *
 * Prefer `offsetFromPrimaryMsP50` once the primary has started: the companion
 * fires at primaryStart + offset, so skipping an earlier soft step does not
 * collapse or stretch later siblings. Until the primary runs (bootstrap/auth
 * steps, or templates without offsets), fall back to chained `delayMsP50`.
 *
 * Each wait is capped by `delayCapMs` and by the remaining flow deadline.
 */
export function nextPaceWaitMs(
  step: FlowTemplateStep,
  ctx: {
    primaryStartedAt: number | undefined;
    delayCapMs: number;
    flowDeadlineAt: number;
    now?: number;
  },
): number {
  const now = ctx.now ?? Date.now();
  const remaining = Math.max(0, ctx.flowDeadlineAt - now);
  if (remaining <= 0) return 0;

  const cap = Math.max(0, ctx.delayCapMs);

  if (
    ctx.primaryStartedAt !== undefined &&
    typeof step.offsetFromPrimaryMsP50 === 'number' &&
    Number.isFinite(step.offsetFromPrimaryMsP50)
  ) {
    // Negative offsets are pre-primary companions — they should already have
    // run. A late negative target means "fire immediately".
    const target = ctx.primaryStartedAt + step.offsetFromPrimaryMsP50;
    const raw = Math.max(0, target - now);
    return Math.min(raw, cap, remaining);
  }

  const chained = Math.max(0, step.delayMsP50 || 0);
  if (chained <= 0) return 0;
  return Math.min(chained, cap, remaining);
}

/** Build-time rails from cartographer throw FlowBuildError (name+code); treat as denied. */
function isBuildDenied(e: unknown): e is Error {
  if (e instanceof ReplayDeniedError) return true;
  return e instanceof Error && e.name === 'FlowBuildError';
}
