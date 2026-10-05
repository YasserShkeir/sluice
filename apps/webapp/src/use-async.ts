// SPDX-License-Identifier: AGPL-3.0-or-later
/** One cancellable fetch-on-deps hook, so a page's data loading is not hand-rolled per effect. */
import { useEffect, useState } from 'react';
import type { DependencyList } from 'react';
import { errorMessage } from './format.js';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
}

/**
 * Run `load` when `deps` change, and ignore anything it settles after cleanup —
 * so a slow answer for the previous deps cannot overwrite the current one. Keeps
 * the previous data while reloading and clears the error; a `null` load resets.
 */
export function useAsync<T>(load: () => Promise<T> | null, deps: DependencyList): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, error: null });
  useEffect(() => {
    const pending = load();
    if (pending === null) {
      setState((s) => (s.data === undefined && s.error === null ? s : { data: undefined, error: null }));
      return;
    }
    let live = true;
    setState((s) => (s.error === null ? s : { data: s.data, error: null }));
    pending.then(
      (data) => {
        if (live) setState({ data, error: null });
      },
      (e: unknown) => {
        if (live) setState({ data: undefined, error: errorMessage(e) });
      },
    );
    return () => {
      live = false;
    };
  }, deps);
  return state;
}
