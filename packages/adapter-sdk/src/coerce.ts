// SPDX-License-Identifier: Apache-2.0
/**
 * Coercion helpers for adapter parsers.
 *
 * Every parser obeys the same hard rule: `parse()` runs inside the ingest funnel
 * for EVERY capture, so a throw does not fail one row — it poisons the pipeline for
 * all of them. The discipline that enforces it is total functions: an
 * unrecognized shape yields `undefined` and the entity is simply omitted, never
 * an exception.
 *
 * These are deliberately not validators. An adapter parses a response shape it
 * does not control and that changes without notice; "reject the payload" is
 * never the right answer, "take what I recognise" always is.
 */

/** `safeJson` parses any JSON value; `safeJsonObject` only a plain object. Never throw. */
export { safeJsonParse as safeJson, safeJsonObject } from '@sluice/core';

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

/** Drop undefined values so an entity does not carry explicit `undefined` keys. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
