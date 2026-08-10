// SPDX-License-Identifier: Apache-2.0
/**
 * Coercion helpers for adapter parsers.
 *
 * Every parser in the repo grew its own near-identical copy of these, because
 * they all obey the same hard rule: `parse()` runs inside the ingest funnel for
 * EVERY capture, so a throw does not fail one row — it poisons the pipeline for
 * all of them. The discipline that enforces it is total functions: an
 * unrecognized shape yields `undefined` and the entity is simply omitted, never
 * an exception.
 *
 * These are deliberately not validators. An adapter parses a response shape it
 * does not control and that changes without notice; "reject the payload" is
 * never the right answer, "take what I recognise" always is.
 */

/** A string, or undefined for anything else (including a number). */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A finite number. Numeric STRINGS are coerced — APIs send ids both ways. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A boolean, or undefined. Deliberately NOT truthiness. */
export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** An array, or undefined. Never throws on a non-array. */
export function arr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/** A plain object — arrays and null excluded, which `typeof` alone allows. */
export function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Parse JSON that may be null, empty, truncated or not JSON at all. */
export function safeJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse a JSON *object* body; undefined for anything that is not one. */
export function safeJsonObject(text: string | null | undefined): Record<string, unknown> | undefined {
  return obj(safeJson(text));
}

/** Drop undefined values so an entity does not carry explicit `undefined` keys. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
