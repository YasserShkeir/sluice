// SPDX-License-Identifier: Apache-2.0
/**
 * Helpers for store-backed app MCP tools: the store or a named refusal, the page
 * an agent asked for, an ISO time a model can read, and a one-line preview.
 */
import type { AppToolContext, ReadOnlyStore } from '@sluice/core';
import { num } from './coerce.js';

/**
 * The store, or a refusal that names what is missing.
 *
 * `AppToolContext.store` is optional, so a tool that needs it must check. Throwing is
 * right: the MCP server turns it into a tool error the operator can act on, unlike an empty list.
 */
export function requireStore(ctx?: AppToolContext): ReadOnlyStore {
  if (!ctx?.store) {
    throw new Error(
      'This tool reads the Sluice capture store, and the host did not provide one. Run it through `sluice-mcp`.',
    );
  }
  return ctx.store;
}

export interface PageArgs {
  limit: number;
  offset: number;
}

/**
 * The page an agent asked for: a positive `limit` floored and clamped to
 * `[1, maxLimit]` (else `defaultLimit`, 50), a positive `offset` floored (else 0).
 * `maxLimit` defaults to 500. Numeric strings count, via `num`.
 *
 * @example
 * const { limit, offset } = pageArgs(args, { defaultLimit: 20, maxLimit: 100 });
 */
export function pageArgs(
  args: Record<string, unknown>,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): PageArgs {
  const { defaultLimit = 50, maxLimit = 500 } = opts;
  const limit = num(args.limit);
  const offset = num(args.offset);
  return {
    limit: limit !== undefined && limit > 0 ? Math.max(1, Math.min(Math.floor(limit), maxLimit)) : defaultLimit,
    offset: offset !== undefined && offset > 0 ? Math.floor(offset) : 0,
  };
}

/**
 * The epoch alongside an ISO string, because deciding "is this stale?" from a
 * millisecond integer is arithmetic a model should not have to do — and
 * `new Date(NaN).toISOString()` THROWS, so the guard is not decoration.
 */
export function isoTime(ts: number | null | undefined): string | null {
  if (ts === null || ts === undefined) return null;
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** A one-line preview: whitespace collapsed, trimmed, then clipped to `maxChars` with `…`. */
export function previewText(text: string, maxChars = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}
