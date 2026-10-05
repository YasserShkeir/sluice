// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client-side helpers for F7 traffic "group by flow".
 *
 * Flows arrive from GET /api/flows (secret-free summaries). The traffic table
 * still owns Capture rows from the WS ring; this module only indexes which
 * captures belong to which observed/pinned burst so the UI can collapse
 * companions under a primary without inventing structure the store does not have.
 */
import type { Capture, FlowStepSummary } from '@sluice/core';
import type { FlowSummary, FlowTemplateSummary } from './api.js';
import { groupBy } from './collections.js';

export interface CaptureFlowMembership {
  flow: FlowSummary;
  step: FlowStepSummary & { flowId: string };
  /** True when this capture is the flow's primary seed. */
  isPrimary: boolean;
}

/** captureId → every flow step that references it (a capture can sit in >1 flow). */
export function indexFlowsByCapture(flows: FlowSummary[]): Map<string, CaptureFlowMembership[]> {
  const entries = flows.flatMap((flow) =>
    (flow.steps ?? []).map(
      (s): CaptureFlowMembership => ({
        flow,
        step: { ...s, flowId: flow.id },
        isPrimary: s.captureId === flow.primaryCaptureId || s.role === 'primary',
      }),
    ),
  );
  return groupBy(entries, (e) => e.step.captureId);
}

/** Prefer pinned, then observed, then others — for badges on a single row. */
export function primaryMembership(memberships?: CaptureFlowMembership[]): CaptureFlowMembership | undefined {
  return memberships?.find((m) => m.flow.source === 'pinned') ?? memberships?.find((m) => m.flow.source === 'observed') ?? memberships?.[0];
}

export type FlowDisplayRow =
  | {
      kind: 'flow';
      flow: FlowSummary;
      /** Captures from the live ring that belong to this flow, ordered by step seq. */
      members: Capture[];
      expanded: boolean;
    }
  | {
      kind: 'capture';
      capture: Capture;
      /** Indent under an expanded flow group. */
      nested: boolean;
      membership?: CaptureFlowMembership;
    }
  | {
      kind: 'ungrouped-header';
      count: number;
    };

/**
 * Build virtualizer rows for "group by flow" mode.
 *
 * Only flows that intersect the already-filtered capture list appear. Captures
 * not in any flow go under a trailing ungrouped section (still filter-respecting).
 */
export function buildFlowGroupedRows(
  filtered: Capture[],
  flows: FlowSummary[],
  expanded: ReadonlySet<string>,
): FlowDisplayRow[] {
  const byId = new Map(filtered.map((c) => [c.id, c]));
  const membership = indexFlowsByCapture(flows);
  const claimed = new Set<string>();
  const out: FlowDisplayRow[] = [];

  // Stable order: newest flow first (endedAt desc), matching "what just happened".
  const ordered = [...flows].sort((a, b) => b.endedAt - a.endedAt);

  for (const flow of ordered) {
    const steps = [...(flow.steps ?? [])].sort((a, b) => a.seq - b.seq);
    const members: Capture[] = [];
    for (const s of steps) {
      const c = byId.get(s.captureId);
      if (c) {
        members.push(c);
        claimed.add(c.id);
      }
    }
    if (members.length === 0) continue;

    const isOpen = expanded.has(flow.id);
    out.push({ kind: 'flow', flow, members, expanded: isOpen });
    // Collapsed: still surface the primary (or first present member) as a peek.
    const shown = isOpen ? members : [members.find((c) => c.id === flow.primaryCaptureId) ?? members[0]!];
    for (const c of shown) out.push({ kind: 'capture', capture: c, nested: true, membership: membership.get(c.id)?.find((m) => m.flow.id === flow.id) });
  }

  const ungrouped = filtered.filter((c) => !claimed.has(c.id));
  if (ungrouped.length > 0) {
    out.push({ kind: 'ungrouped-header', count: ungrouped.length });
    for (const c of ungrouped) {
      out.push({ kind: 'capture', capture: c, nested: false, membership: primaryMembership(membership.get(c.id)) });
    }
  }

  return out;
}

/** Best-effort template match for a flow's primary operation key. */
export function matchTemplateForFlow(
  flow: FlowSummary,
  templates: FlowTemplateSummary[],
): FlowTemplateSummary | undefined {
  const op = flow.primaryOp;
  if (!op) return undefined;
  return (
    templates.find((t) => t.adapterId === flow.adapterId && t.primaryKey === op) ??
    templates.find((t) => t.primaryKey === op)
  );
}
