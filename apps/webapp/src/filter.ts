// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The traffic filter language.
 *
 * What it replaces: six fixed `<select>` dropdowns plus one substring box, each
 * dimension an exact-equality `continue` in a hand-written loop. That design
 * could express "app = slack" and nothing else — not "429s", not "slower than a
 * second and a half", not "anything but client.counts", and not two values for
 * the same field. Every new dimension cost a dropdown, a state key and a branch.
 *
 * The language:
 *
 *   status:429              a field equals a value
 *   status:4xx              status classes, because that is how anyone thinks
 *   op:conversations.*      globs, for a family of endpoints
 *   dur:>1500               comparisons on the numeric fields
 *   body:"not_in_channel"   quoted, so a value may contain spaces
 *   -op:client.counts       negation, to subtract noise
 *   not_in_channel          a bare word searches everything
 *
 * Terms are ANDed. That is the behaviour a search box trains people to expect,
 * and OR is representable through a glob for the case that actually comes up
 * (`status:4xx`, `op:conversations.*`).
 *
 * PARSING NEVER FAILS. This runs on every keystroke, so half-typed input is the
 * normal state, not an error: `dur:>` and `body:"unclosed` must narrow nothing
 * rather than throw or blank the table. Anything unparseable is reported in
 * `errors` for the UI to show as a hint, and otherwise ignored.
 *
 * Kept free of React and of the store so it can be tested at all — the webapp
 * has no component-test infrastructure, only plain node:test over pure modules.
 */
import type { Capture } from '@sluice/core';

/** Fields a term can address. `text` is the bare-word case: match anything. */
export type FilterField =
  | 'text'
  | 'app'
  | 'source'
  | 'method'
  | 'host'
  | 'path'
  | 'op'
  | 'status'
  | 'dur'
  | 'size'
  | 'tab'
  | 'body';

export type Comparator = '=' | '>' | '<' | '>=' | '<=';

export interface FilterTerm {
  field: FilterField;
  value: string;
  comparator: Comparator;
  negated: boolean;
}

export interface FilterQuery {
  terms: FilterTerm[];
  /** Human-readable notes about input that was ignored. Never blocks matching. */
  errors: string[];
}

/** Fields compared as numbers; everything else is compared as text. */
const NUMERIC: ReadonlySet<FilterField> = new Set<FilterField>(['status', 'dur', 'size']);

const FIELDS: ReadonlySet<string> = new Set<FilterField>([
  'text',
  'app',
  'source',
  'method',
  'host',
  'path',
  'op',
  'status',
  'dur',
  'size',
  'tab',
  'body',
]);

/** Field names people reach for that are not the canonical one. */
const ALIASES: Readonly<Record<string, FilterField>> = {
  adapter: 'app',
  operation: 'op',
  duration: 'dur',
  ms: 'dur',
  bytes: 'size',
  code: 'status',
  url: 'path',
  engine: 'source',
};

export const EMPTY_QUERY: FilterQuery = { terms: [], errors: [] };

/**
 * Split on whitespace, except inside double quotes.
 *
 * An unterminated quote takes the rest of the line as one token rather than
 * discarding it — the user is mid-type, and dropping their text would make the
 * table flash empty on the way to a valid query.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of input) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Parse filter text. Total: any string yields a usable query. */
export function parseFilter(input: string): FilterQuery {
  const terms: FilterTerm[] = [];
  const errors: string[] = [];

  for (const raw of tokenize(input)) {
    let token = raw;
    const negated = token.startsWith('-') && token.length > 1;
    if (negated) token = token.slice(1);

    const colon = token.indexOf(':');
    if (colon <= 0) {
      // No field given — a bare word searches everything. A leading colon is
      // treated the same way rather than reported: `:` alone is what someone
      // has typed a moment before they type the field name.
      if (token.length > 0) terms.push({ field: 'text', value: token, comparator: '=', negated });
      continue;
    }

    const name = token.slice(0, colon).toLowerCase();
    let value = token.slice(colon + 1);
    const field = (FIELDS.has(name) ? (name as FilterField) : ALIASES[name]) ?? undefined;
    if (field === undefined) {
      errors.push(`Unknown field "${name}" — try ${[...FIELDS].filter((f) => f !== 'text').join(', ')}`);
      continue;
    }

    let comparator: Comparator = '=';
    for (const op of ['>=', '<=', '>', '<'] as const) {
      if (value.startsWith(op)) {
        comparator = op;
        value = value.slice(op.length);
        break;
      }
    }

    if (value.length === 0) continue; // mid-type (`status:`, `dur:>`) — not an error
    if (comparator !== '=' && !NUMERIC.has(field)) {
      errors.push(`"${field}" is text — ${comparator} only applies to ${[...NUMERIC].join(', ')}`);
      continue;
    }
    if (NUMERIC.has(field) && comparator !== '=' && !Number.isFinite(Number(value))) {
      errors.push(`"${value}" is not a number`);
      continue;
    }

    terms.push({ field, value, comparator, negated });
  }

  return { terms, errors };
}

/** Does the query constrain anything? An empty query matches every row. */
export function isEmptyQuery(q: FilterQuery): boolean {
  return q.terms.length === 0;
}

/**
 * Terms the client cannot answer alone.
 *
 * `body:` is the one predicate whose data is not in the row the table holds:
 * the WS backfill is a bounded window, so a body search restricted to it
 * silently answers a different question than the user asked. Those terms go to
 * the server's FTS-backed search instead.
 */
export function serverSideTerms(q: FilterQuery): FilterTerm[] {
  return q.terms.filter((t) => t.field === 'body' && !t.negated);
}

/**
 * Convert a glob (`conversations.*`) to an anchored, case-insensitive regexp.
 *
 * Split on `*` FIRST, then escape each literal chunk. Escaping first and
 * substituting `*` afterwards needs a placeholder, and any placeholder can also
 * occur inside a quoted value — with a space, `body:"a b*c"` compiles to
 * `^a.*b.*c$`, so the user's literal space silently becomes a second wildcard.
 */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * Text comparison: a glob when the value contains `*`, otherwise a substring
 * match. Substring is the friendlier default for a search box — someone typing
 * `host:slack` means "slack somewhere in the host", not "the host is exactly
 * slack" — and `*` is there for when they want to be precise.
 */
function textMatches(actual: string | null | undefined, value: string): boolean {
  if (actual === null || actual === undefined) return false;
  if (value.includes('*')) return globToRegExp(value).test(actual);
  return actual.toLowerCase().includes(value.toLowerCase());
}

/** `4xx` / `5XX` style status classes, which is how people describe them. */
function statusMatches(status: number | null, value: string): boolean {
  if (status === null) return false;
  const klass = /^([1-5])xx$/i.exec(value);
  if (klass) return Math.floor(status / 100) === Number(klass[1]);
  if (/^\d+$/.test(value)) return status === Number(value);
  return textMatches(String(status), value);
}

function compare(actual: number | null | undefined, comparator: Comparator, value: string): boolean {
  if (actual === null || actual === undefined) return false;
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  switch (comparator) {
    case '>':
      return actual > n;
    case '<':
      return actual < n;
    case '>=':
      return actual >= n;
    case '<=':
      return actual <= n;
    case '=':
      return actual === n;
  }
}

/** Rough response size, matching what the table's Size column shows. */
function bodySize(c: Capture): number {
  return (c.resBody?.length ?? 0) + (c.reqBody?.length ?? 0);
}

/** Everything a bare word searches. Built per row, so keep it cheap. */
function haystack(c: Capture): string {
  return [c.adapterId, c.source, c.method, c.host, c.path, c.classification, c.status].join(' ');
}

function termMatches(c: Capture, t: FilterTerm): boolean {
  switch (t.field) {
    case 'text':
      return textMatches(haystack(c), t.value);
    case 'app':
      return textMatches(c.adapterId, t.value);
    case 'source':
      return textMatches(c.source, t.value);
    case 'method':
      return textMatches(c.method, t.value);
    case 'host':
      return textMatches(c.host, t.value);
    case 'path':
      return textMatches(c.path, t.value);
    case 'op':
      // Fall back to the path when nothing has classified this row yet, so a
      // filter written against the Operation column still works on old captures.
      return textMatches(c.classification ?? c.path, t.value);
    case 'tab':
      return textMatches(c.tabId, t.value);
    case 'status':
      return t.comparator === '='
        ? statusMatches(c.status, t.value)
        : compare(c.status, t.comparator, t.value);
    case 'dur':
      return compare(c.durationMs, t.comparator, t.value);
    case 'size':
      return compare(bodySize(c), t.comparator, t.value);
    case 'body':
      return textMatches(c.reqBody, t.value) || textMatches(c.resBody, t.value);
  }
}

/**
 * Does a capture satisfy every term? Terms are ANDed; a negated term must NOT
 * match.
 */
export function matchesFilter(c: Capture, q: FilterQuery): boolean {
  for (const t of q.terms) {
    const hit = termMatches(c, t);
    if (t.negated ? hit : !hit) return false;
  }
  return true;
}

/** Render a query back to text — for a "copy this filter" affordance. */
export function formatFilter(q: FilterQuery): string {
  return q.terms
    .map((t) => {
      const value = /\s/.test(t.value) ? `"${t.value}"` : t.value;
      const body = t.field === 'text' ? value : `${t.field}:${t.comparator === '=' ? '' : t.comparator}${value}`;
      return `${t.negated ? '-' : ''}${body}`;
    })
    .join(' ');
}

/** The field names, for a completion menu or a cheatsheet. */
export const FILTER_FIELDS: readonly FilterField[] = [...FIELDS].filter(
  (f): f is FilterField => f !== 'text',
);
