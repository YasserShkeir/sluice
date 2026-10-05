// SPDX-License-Identifier: Apache-2.0
/**
 * Secret-free projections of flows and flow templates — what the MCP, the
 * runner's `/api/flows` + `/api/flow-templates` and the CLI show.
 *
 * A template step can carry a request fingerprint (header values, body params)
 * and `literal` param values baked in from real traffic. None of that is ever
 * copied here: every field below is named, never spread, so a field added to
 * the stored shape does not start leaving through these views on its own.
 */
import type {
  FlowParamSource,
  FlowStep,
  FlowStepRole,
  FlowTemplate,
  FlowTemplateStep,
  InteractionFlow,
} from './types.js';

export interface FlowSummary {
  id: string;
  adapterId: string;
  label?: string;
  source: InteractionFlow['source'];
  primaryCaptureId: string;
  primaryOp?: string;
  stepCount: number;
  startedAt: number;
  endedAt: number;
}

export interface FlowStepSummary {
  seq: number;
  role: FlowStepRole;
  operation?: string;
  required: boolean;
  captureId: string;
}

export interface FlowTemplateSummary {
  id: string;
  adapterId: string;
  primaryKey: string;
  label?: string;
  sampleCount: number;
  version: number;
  learnedAt: number;
  flowParams: FlowTemplate['flowParams'];
  stepCount: number;
}

export interface FlowTemplateStepSummary {
  seq: number;
  role: FlowStepRole;
  method: string;
  path: string;
  operation?: string;
  required: boolean;
  support: number;
  delayMsP50: number;
  /** Median ms from primary start (negative for pre-primary auth/bootstrap). */
  offsetFromPrimaryMsP50?: number;
  offsetSpreadMs?: number;
  unreproducible?: true;
  unreproducibleReason?: string;
}

/** How a param is filled, minus any value: a `literal`'s text never appears. */
export interface ParamSourceSummary {
  kind: FlowParamSource['kind'];
  name?: string;
  fromStep?: number;
  jsonPath?: string;
  reason?: string;
}

/**
 * The flow's primary operation: the step that IS the primary capture, else the
 * step marked primary. The fallback is on the operation — a primary-capture
 * step with no operation falls through to the role.
 */
export function primaryOperation(f: InteractionFlow): string | undefined {
  return (
    f.steps.find((s) => s.captureId === f.primaryCaptureId)?.operation ??
    f.steps.find((s) => s.role === 'primary')?.operation
  );
}

export function flowSummary(f: InteractionFlow): FlowSummary {
  return {
    id: f.id,
    adapterId: f.adapterId,
    label: f.label,
    source: f.source,
    primaryCaptureId: f.primaryCaptureId,
    primaryOp: primaryOperation(f),
    stepCount: f.steps.length,
    startedAt: f.startedAt,
    endedAt: f.endedAt,
  };
}

export function flowStepSummary(s: FlowStep): FlowStepSummary {
  return { seq: s.seq, role: s.role, operation: s.operation, required: s.required, captureId: s.captureId };
}

export function templateSummary(t: FlowTemplate): FlowTemplateSummary {
  return {
    id: t.id,
    adapterId: t.adapterId,
    primaryKey: t.primaryKey,
    label: t.label,
    sampleCount: t.sampleCount,
    version: t.version,
    learnedAt: t.learnedAt,
    flowParams: t.flowParams,
    stepCount: t.steps.length,
  };
}

/** A template step without its request fingerprint or params. */
export function templateStepSummary(s: FlowTemplateStep): FlowTemplateStepSummary {
  return {
    seq: s.seq,
    role: s.role,
    method: s.method,
    path: s.path,
    operation: s.operation,
    required: s.required,
    support: s.support,
    delayMsP50: s.delayMsP50,
    offsetFromPrimaryMsP50: s.offsetFromPrimaryMsP50,
    offsetSpreadMs: s.offsetSpreadMs,
    unreproducible: s.unreproducible || undefined,
    unreproducibleReason: s.unreproducibleReason,
  };
}

export function paramSourceSummary(src: FlowParamSource): ParamSourceSummary {
  switch (src.kind) {
    case 'flowParam':
      return { kind: src.kind, name: src.name };
    case 'bind':
      return { kind: src.kind, fromStep: src.fromStep, jsonPath: src.jsonPath };
    case 'unreproducible':
      return { kind: src.kind, reason: src.reason };
    default:
      // `literal` (whose value is captured text), `session`, and any kind added
      // later: the kind alone, until someone decides what of it is safe to show.
      return { kind: src.kind };
  }
}

export function paramSourcesSummary(
  p?: Record<string, FlowParamSource>,
): Record<string, ParamSourceSummary> | undefined {
  return p ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, paramSourceSummary(v)])) : undefined;
}
