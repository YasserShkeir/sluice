// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one "pinned for comparison" slot, shared across inspector instances.
 *
 * The inspector is remounted (`key={capture.id}`) on every selection, so a pin
 * kept in its own state would vanish the moment you clicked the capture you want
 * to compare against. It lives here as a module-level value with a
 * `useSyncExternalStore` hook — the same shape the WS store uses — so pinning one
 * capture and then selecting another keeps the pin.
 */
import { useSyncExternalStore } from 'react';

export interface Pinned {
  id: string;
  label: string;
  /** The response body captured at pin time — what a later capture diffs against. */
  body: string;
}

let pinned: Pinned | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setPin(p: Pinned | null): void {
  pinned = p;
  emit();
}

export function usePin(): Pinned | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pinned,
    () => pinned,
  );
}
