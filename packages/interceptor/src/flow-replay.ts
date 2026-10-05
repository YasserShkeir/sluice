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
 * Pacing: see {@link nextPaceWaitMs}.
 *
 * `FlowReplayResult.error` and `steps[].detail` come back redacted: every free
 * text (a build or run error, an unreproducible reason) passes `redactText` in
 * `stepFailed`, so no host has to remember to.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage, isAuthFailure, newId, redactText, safeJsonParse } from '@sluice/core';
import type {
  Capture,
  FlowRunStepMsg,
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

/** The error (and step detail) of an auth failure — also what triggers the restart. */
const AUTH_FAILURE = 'auth failure';

export type FlowStepStatus =
  | 'ok'
  | 'skipped'
  | 'soft_fail'
  | 'denied'
  | 'error'
  | 'auth_fail';

export interface FlowStepResult extends FlowRunStepMsg {
  role: FlowTemplateStep['role'];
  status: FlowStepStatus;
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

  let session = opts.session;
  let refreshed = false;

  const attempt = async (): Promise<FlowReplayResult> => {
    const steps: FlowStepResult[] = [];
    const priorResponses = new Map<number, unknown>();
    const priorCaptures: Capture[] = [];
    const captureIds: string[] = [];
    let primaryCaptureId: string | undefined;
    const ordered = opts.template.steps.slice().sort((a, b) => a.seq - b.seq);
    const flowStartedAt = Date.now();
    let flowEndedAt = flowStartedAt;
    /** Wall clock when the primary step began — anchor for sibling offsets. */
    let primaryStartedAt: number | undefined;
    const delayCap = opts.delayCapMs ?? FLOW_DELAY_CAP_MS;
    const pace = opts.pace !== false;

    // Reads primaryCaptureId / flowEndedAt / refreshed at call time.
    const fail = (error: string): FlowReplayResult => ({
      ok: false,
      refreshed,
      steps,
      error,
      flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
    });
    /** Record a failed step (redacted); a required one fails the flow, a soft one continues. */
    const stepFailed = (
      step: FlowTemplateStep,
      status: FlowStepStatus,
      detail: string,
      error = detail,
    ): FlowReplayResult | undefined => {
      steps.push(stepResult(step, status, redactText(detail)));
      return step.required ? fail(redactText(error)) : undefined;
    };

    for (const step of ordered) {
      if (Date.now() - started > timeoutMs) return fail(`flow timed out after ${timeoutMs}ms`);

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
        const r = stepFailed(
          step,
          'skipped',
          step.unreproducibleReason ?? 'unreproducible',
          `required step ${step.seq} is unreproducible`,
        );
        if (r) return r;
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
        const r = stepFailed(step, isBuildDenied(e) ? 'denied' : 'error', errorMessage(e));
        if (r) return r;
        continue;
      }

      if (req === null) {
        const r = stepFailed(step, 'skipped', 'build returned null', `required step ${step.seq} could not be built`);
        if (r) return r;
        continue;
      }

      // Anchor sibling schedule at the moment we issue the primary — matches
      // capture `ts` (request start), not response completion.
      if (step.role === 'primary') primaryStartedAt ??= Date.now();

      let capture: Capture;
      try {
        capture = await opts.io.run(req);
      } catch (e) {
        // Narrower than isBuildDenied: only the runtime rails deny here.
        const r = stepFailed(step, e instanceof ReplayDeniedError ? 'denied' : 'error', errorMessage(e));
        if (r) return r;
        continue;
      }

      opts.io.record?.(capture, step);
      priorCaptures.push(capture);
      captureIds.push(capture.id);
      flowEndedAt = capture.ts + (capture.durationMs ?? 0);
      if (step.role === 'primary') primaryCaptureId = capture.id;

      const bodyJson = safeJsonParse(capture.resBody);
      if (bodyJson !== undefined) priorResponses.set(step.seq, bodyJson);

      if (isAuthFailure(capture)) {
        steps.push(captureStepResult(step, 'auth_fail', capture, AUTH_FAILURE));
        return fail(AUTH_FAILURE);
      }

      if (opts.failOnHttpError !== false && capture.status !== null && capture.status >= 400) {
        const status: FlowStepStatus = step.required ? 'error' : 'soft_fail';
        steps.push(captureStepResult(step, status, capture, `HTTP ${capture.status}`));
        if (step.required) return fail(`required step ${step.seq} returned HTTP ${capture.status}`);
        continue;
      }

      steps.push(captureStepResult(step, 'ok', capture));
    }

    return {
      ok: steps.some((s) => s.status === 'ok' && s.role === 'primary') ||
        (steps.some((s) => s.status === 'ok') && !ordered.some((s) => s.role === 'primary')),
      refreshed,
      steps,
      flow: maybeFlow(opts, primaryCaptureId, captureIds, flowStartedAt, flowEndedAt, steps),
    };
  };

  const result = await attempt();
  if (result.error !== AUTH_FAILURE || opts.allowRefreshRestart === false || !opts.io.refresh) return result;
  let fresh: Session | undefined;
  try {
    fresh = await opts.io.refresh();
  } catch {
    return result;
  }
  if (!fresh) return result;
  session = fresh;
  refreshed = true;
  return attempt();
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

function stepResult(step: FlowTemplateStep, status: FlowStepStatus, detail?: string): FlowStepResult {
  const { seq, role, operation, method, path } = step;
  return { seq, role, operation, method, path, status, detail };
}

/** A step row for an exchange that happened, carrying its capture's id, status and timing. */
function captureStepResult(
  step: FlowTemplateStep,
  status: FlowStepStatus,
  capture: Capture,
  detail?: string,
): FlowStepResult {
  return {
    ...stepResult(step, status, detail),
    captureId: capture.id,
    httpStatus: capture.status,
    durationMs: capture.durationMs ?? undefined,
  };
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
  const offset = step.offsetFromPrimaryMsP50;
  // Negative offsets are pre-primary companions; a late target fires immediately.
  const wait = ctx.primaryStartedAt !== undefined && typeof offset === 'number' && Number.isFinite(offset) ? ctx.primaryStartedAt + offset - now : step.delayMsP50 || 0;
  return Math.max(0, Math.min(wait, ctx.delayCapMs, ctx.flowDeadlineAt - now));
}

/** Build-time rails from cartographer throw FlowBuildError (name+code); treat as denied. */
function isBuildDenied(e: unknown): e is Error {
  return e instanceof ReplayDeniedError || (e instanceof Error && e.name === 'FlowBuildError');
}
