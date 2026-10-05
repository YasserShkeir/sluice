// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The activity surface — running and recently-finished operations, bottom-right.
 *
 * One card per requestId, updated in place (running → ok/error): `running` shows a
 * spinner and cannot be dismissed, `error` stays until dismissed, `ok` fades on
 * its own.
 */
import { useEffect } from 'react';
import { Loader2, X } from 'lucide-react';
import type { OpProgress } from '@sluice/core';
import { dismissOp } from '../ws.js';

/** How long a successful op lingers before it auto-dismisses. */
const OK_LINGER_MS = 6000;

export function ActivityLog({ operations }: { operations: OpProgress[] }) {
  if (operations.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-3 right-3 z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2"
      aria-live="polite"
    >
      {operations.map((op) => (
        <OpCard key={op.requestId} op={op} />
      ))}
    </div>
  );
}

function OpCard({ op }: { op: OpProgress }) {
  // Auto-dismiss a success after it has been seen; errors and running ops stay.
  // Keyed on state so a running→ok transition starts the timer exactly once.
  useEffect(() => {
    if (op.state !== 'ok') return;
    const t = setTimeout(() => dismissOp(op.requestId), OK_LINGER_MS);
    return () => clearTimeout(t);
  }, [op.state, op.requestId]);

  const tone =
    op.state === 'error'
      ? 'border-danger/40 bg-danger/10'
      : op.state === 'ok'
        ? 'border-ok/40 bg-ok/10'
        : 'border-border bg-bg-2';

  return (
    <div
      className={`pointer-events-auto rounded-md border ${tone} px-3 py-2 text-[12px] shadow-lg`}
      role={op.state === 'error' ? 'alert' : 'status'}
    >
      <div className="flex items-center gap-2">
        {op.state === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-mute" aria-hidden />
        ) : (
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${op.state === 'ok' ? 'bg-ok' : 'bg-danger'}`}
          />
        )}
        <span className="font-medium text-fg">{op.kind}</span>
        {op.count !== undefined ? (
          <span className="text-fg-mute tabular-nums">{op.count}</span>
        ) : null}
        {op.state !== 'running' ? (
          <button
            type="button"
            onClick={() => dismissOp(op.requestId)}
            className="ml-auto shrink-0 rounded p-0.5 text-fg-mute hover:bg-bg-3 hover:text-fg"
            aria-label={`Dismiss ${op.kind}`}
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
      {op.detail ? (
        // Multi-line: a failed sync lists every failed action here, all of which
        // survive — the point of the model. Scrolls rather than growing without
        // bound.
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-fg-dim">
          {op.detail}
        </pre>
      ) : null}
    </div>
  );
}
