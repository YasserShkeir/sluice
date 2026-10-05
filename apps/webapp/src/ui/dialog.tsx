// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The modal overlay shell and its Escape key, shared by every dialog.
 *
 * Escape is a window listener rather than a backdrop click handler: it is the
 * keyboard equivalent of dismissing the dialog, and the reason the backdrop does
 * not need a (non-accessible) click handler of its own.
 */
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { cn } from './cn.js';

/** Call `onEscape` on the Escape key while `active`. */
export function useEscapeKey(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onEscape]);
}

/** A full-screen dimmed overlay announced as a modal dialog; `className` places it. */
export function DialogShell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn('fixed inset-0 flex justify-center bg-black/50 p-4', className)}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      {children}
    </div>
  );
}
