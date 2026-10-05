// SPDX-License-Identifier: AGPL-3.0-or-later
/** SQL identifier helpers shared across the cartographer. */

/** Quote a SQL identifier (table/column) and escape embedded double quotes. */
export function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** Sanitize a name into a bare `[a-z0-9_]` token for use in a table name. */
export function sanitizeName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return s.length ? s : 'x';
}
