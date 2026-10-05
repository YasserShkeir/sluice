// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How the CLI reads a replayed response: whether it failed, and — for the cursor
 * drain — whether the work item is finished at all.
 *
 * Its own module because cli.ts runs `main()` at import, so nothing exported from
 * it can be unit-tested.
 */
import { serviceError } from '@sluice/core';
import type { Capture } from '@sluice/core';

/** Surface an app-style {ok:false,error} body (or an HTTP error) so failures are visible. */
export function apiErrorText(capture: Pick<Capture, 'status' | 'resBody'>): string | null {
  const e = serviceError(capture.resBody);
  if (e) return `${e.error ?? 'error'}${e.needed ? ` (needed: ${e.needed}; provided: ${e.provided ?? '-'})` : ''}`;
  return capture.status != null && capture.status >= 400 ? `HTTP ${capture.status}` : null;
}

type DrainOutcome = { kind: 'done' } | { kind: 'failed'; error: string } | { kind: 'retry-later' };

/**
 * What one drained item's response means for the worklist.
 *
 * A 429 is "ask again later", not a failure: the item is left claimed and the
 * drainer returns it to pending at the end of the run (`releaseCursors`).
 * Re-enqueueing it instead would be a no-op — `enqueueCursors` dedupes on the same key across
 * every state, including the claimed item's own row — and settling it as failed
 * lost the page for good.
 */
export function drainOutcome(capture: Pick<Capture, 'status' | 'resBody'>): DrainOutcome {
  if (capture.status === 429) return { kind: 'retry-later' };
  const error = apiErrorText(capture);
  return error === null ? { kind: 'done' } : { kind: 'failed', error };
}
