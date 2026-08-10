// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Small, dependency-free helpers shared across the cartographer. Nothing here
 * ever reads a header *value* that could be a secret — we only ever look up
 * `content-type` (to decide how to parse a body) and collect header/param
 * *names*.
 */

/** Parse any JSON value; returns `undefined` when the text is empty or invalid. */
export function parseJsonValue(text: string | null | undefined): unknown | undefined {
  if (text === null || text === undefined || text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse a JSON *object* body; returns null for empty / array / non-object / invalid. */
export function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  const v = parseJsonValue(text);
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Case-insensitive header lookup over an already-redacted header map. */
export function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return headers[key];
  }
  return undefined;
}

/** Quote a SQL identifier (table/column) and escape embedded double quotes. */
export function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** Sanitize a name into a bare `[a-z0-9_]` token for use in a table name. */
export function sanitizeName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return s.length ? s : 'x';
}
