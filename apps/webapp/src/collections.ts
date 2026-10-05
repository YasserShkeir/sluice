// SPDX-License-Identifier: AGPL-3.0-or-later
/** Small pure collection helpers the components share. */

/** A copy of `set` with `value` flipped: removed when present, added when not. */
export function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/**
 * Group `items` by `key`, keeping first-seen key order and in-group order.
 * Hand-written rather than `Map.groupBy`, which Node 20 (an allowed engine, and
 * where the tests run) lacks.
 */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}
