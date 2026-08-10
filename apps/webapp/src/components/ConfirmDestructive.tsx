// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one confirm gate every destructive data action goes through.
 *
 * The codebase's rule is that captures are the evidence and the only copy, so
 * anything that deletes them must be deliberate and must say what it will do. One
 * component enforces that consistently: it names the exact count being removed
 * (so a button can never claim one number and delete another), distinguishes
 * derived-and-rebuildable from your-only-copy in its wording, and — for the
 * heaviest actions — requires typing a phrase, so a stray click cannot empty the
 * store.
 */
import { useEffect, useState } from 'react';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';

interface Props {
  open: boolean;
  title: string;
  /** What exactly will be removed — usually a count from the delete's own query. */
  body: React.ReactNode;
  /** True when this destroys captures (irreversible) vs derived data (rebuildable). */
  irreversible?: boolean;
  /** When set, the user must type this exact phrase to enable the action. */
  requirePhrase?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDestructive({
  open,
  title,
  body,
  irreversible,
  requirePhrase,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState('');
  // Reset the typed phrase whenever the dialog opens, so a previous confirmation
  // cannot carry over and pre-arm the next one.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  // Escape cancels — the keyboard equivalent of dismissing the dialog, and the
  // reason the backdrop does not need a (non-accessible) click handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);
  if (!open) return null;

  const armed = requirePhrase === undefined || typed === requirePhrase;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-bg-1 p-4 shadow-2xl">
        <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
        <div className="mt-2 text-[12.5px] leading-relaxed text-fg-dim">{body}</div>
        {irreversible ? (
          <p className="mt-2 text-[12px] text-danger">
            This deletes captured data — your only copy. It cannot be undone.
          </p>
        ) : (
          <p className="mt-2 text-[12px] text-fg-mute">
            This removes derived data only; it rebuilds from the captures on demand.
          </p>
        )}
        {requirePhrase !== undefined ? (
          <div className="mt-3">
            <label htmlFor="confirm-phrase" className="text-[12px] text-fg-dim">
              Type <code className="text-fg">{requirePhrase}</code> to confirm
            </label>
            <Input
              id="confirm-phrase"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1"
              autoFocus
            />
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={irreversible ? 'danger' : 'primary'}
            disabled={!armed}
            onClick={() => {
              onConfirm();
              onCancel();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
