// SPDX-License-Identifier: Apache-2.0
import { nanoid } from 'nanoid';

/** Prefixed, sortable-enough id for locally-generated records (captures, sessions). */
export function newId(prefix = 'c'): string {
  return `${prefix}_${nanoid(16)}`;
}

/** Split a URL into host + path, tolerant of malformed input. */
export function splitUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname };
  } catch {
    return { host: '', path: url };
  }
}

/** Segments that carry no meaning in an operation name — every path has one. */
const PREFIX_NOISE = /^(api|v\d+|\d+)$/i;
/**
 * Segments that are an identity rather than a name. Deliberately conservative:
 * mistaking a real path segment for an id merges two distinct operations into
 * one row, which is a worse failure than leaving an id in the name.
 */
const LOOKS_LIKE_ID =
  /^(\d+|[0-9a-f]{8,}|[0-9a-fA-F-]{32,}|[A-Z][0-9A-Z]{6,}|[\w-]{22,})$/;

/**
 * A stable, human-readable name for what an endpoint DOES, derived from its path.
 *
 * This is the traffic table's Operation column and what `op:` filters match. The
 * useful property is that every call to the same endpoint collapses to the same
 * string, so `/1/boards/5f3a91c.../cards` and `/1/boards/60b2e4d.../cards` are
 * one operation with two instances rather than two operations.
 *
 * Adapters will be able to override this with something service-accurate; until
 * then it is derived generically, which already reads well for both common API
 * shapes — RPC-style (`/api/conversations.history` -> `conversations.history`)
 * and REST-style (`/1/boards/{id}/cards` -> `boards/:id/cards`).
 */
export function operationName(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  while (segments.length > 1 && PREFIX_NOISE.test(segments[0] ?? '')) segments.shift();
  const named = segments.map((s) => (LOOKS_LIKE_ID.test(s) ? ':id' : s));
  return named.join('/') || '/';
}
