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
 *
 * Includes Trello shortLinks (8-char base62 with both a letter and a digit,
 * e.g. `AAAA1111`, `aB3dE5gH`) so unattributed traffic still groups. Pure
 * words like `messages` stay names.
 */
const LOOKS_LIKE_ID =
  /^(\d+|[0-9a-f]{8,}|[0-9a-fA-F-]{32,}|[A-Z][0-9A-Z]{6,}|[\w-]{22,}|(?=[a-zA-Z0-9]*\d)(?=[a-zA-Z0-9]*[a-zA-Z])[a-zA-Z0-9]{8})$/;

/**
 * A stable, human-readable operation name derived from a path — the fallback when
 * an adapter's `classify` names none. Every call to one endpoint collapses to one
 * string: `/api/conversations.history` -> `conversations.history`,
 * `/1/boards/{id}/cards` -> `boards/:id/cards`.
 */
export function operationName(path: string): string {
  const segments = path.split('/').filter((s) => s.length > 0);
  while (segments.length > 1 && PREFIX_NOISE.test(segments[0] ?? '')) segments.shift();
  const named = segments.map((s) => (LOOKS_LIKE_ID.test(s) ? ':id' : s));
  return named.join('/') || '/';
}

/** The message of anything thrown: `Error.message`, else its string form. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Case-insensitive header lookup; first matching key wins; non-string values are ignored. */
export function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want && typeof v === 'string') return v;
  }
  return undefined;
}

/** Parse any JSON value; undefined when the text is null, empty or invalid. Never throws. */
export function safeJsonParse(text: string | null | undefined): unknown {
  if (text === null || text === undefined || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse a JSON *object*; undefined for null/empty/invalid text, arrays and primitives. Never throws. */
export function safeJsonObject(text: string | null | undefined): Record<string, unknown> | undefined {
  const v = safeJsonParse(text);
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Resolve a flow-learn bind path (`a.b[0].c`; '' or '$' = root) against parsed JSON.
 * Returns the leaf as a string when it is a string/number/boolean, else undefined.
 */
export function resolveJsonPath(data: unknown, path: string): string | undefined {
  let cur: unknown = data;
  // Tokenize: split on . but keep [n] indices.
  for (const raw of !path || path === '$' ? [] : (path.match(/[^.[\]]+|\[\d+\]/g) ?? [])) {
    if (cur == null) return undefined;
    if (raw.startsWith('[')) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(raw.slice(1, -1))];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[raw];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? String(cur) : undefined;
}
