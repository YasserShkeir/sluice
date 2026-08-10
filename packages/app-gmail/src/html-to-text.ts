// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * HTML → indexable text, for a Gmail message body.
 *
 * It lives here rather than in `@sluice/core` because it is not a generic
 * utility: it exists because `record[5][1][k][2][1]` is the ONLY body Gmail
 * sends for 63 of the 114 messages in the recording — every one of the 169 parts
 * is HTML, and there is no `text/plain` part anywhere in `[5][1]`. Any adapter
 * that wanted this would want its own trade-offs; the spine should not grow a
 * half-HTML-parser on Gmail's account.
 *
 * The contract is the same one `parse` has: TOTAL. It runs inside the ingest
 * funnel on a string Google controls, so every branch has to end in a string —
 * which is why entity decoding is guarded rather than trusting
 * `String.fromCodePoint`, whose contract is to THROW `RangeError` on a code
 * point above 0x10FFFF. `&#9999999;` is four keystrokes in a marketing email.
 *
 * It is deliberately not a parser. It does not resolve nesting, it does not know
 * that `<td>` implies a column, and it will happily flatten a layout table into
 * one line. The output feeds `Item.text` — full-text search and a preview — and
 * for that "all the words, in order, once" is the whole requirement.
 */

/**
 * The cap on one message's text.
 *
 * Not a truncation policy — a bound. The largest body in the 114-message
 * recording is 11 703 characters of plain text and 8 278 of stripped HTML, so
 * nothing there is clipped by this; it is here so that one pathological message
 * cannot dominate `items_fts` or the row it is stored in.
 */
export const MAX_BODY_CHARS = 16_000;

/**
 * `<script>`/`<style>` go with their CONTENT. Stripping only the tags leaves the
 * CSS and the JavaScript standing as body text, and a marketing email carries
 * far more of both than it does prose — the words a search would then match are
 * `font-family` and `googletagmanager`.
 */
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Comments before tags: a comment may legally contain a `>`. */
const COMMENT = /<!--[\s\S]*?-->/g;

/**
 * Block-level boundaries become a newline rather than a space, so a message
 * whose paragraphs are `<div>`s does not come out as one run-on sentence. Only
 * the closers and the void elements — an opener is always followed by its
 * closer, and doubling the break just makes blank lines to collapse later.
 */
const BLOCK_BREAK = /<\/(p|div|tr|li|h[1-6]|blockquote|table|ul|ol)\s*>|<(br|hr)\b[^>]*\/?>/gi;

/** Everything else that looks like a tag, including a malformed one. */
const TAG = /<[^>]*>/g;

const ENTITY = /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi;

/**
 * The entities that actually change a word. Anything unlisted is left VERBATIM
 * rather than dropped: `&foo;` in a body is far more likely to be text the
 * sender typed than an entity, and deleting it silently edits the message.
 */
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ndash', '-'],
  ['mdash', '-'],
  ['hellip', '...'],
  ['lsquo', "'"],
  ['rsquo', "'"],
  ['ldquo', '"'],
  ['rdquo', '"'],
  ['bull', '*'],
  ['middot', '.'],
  ['copy', '(c)'],
  ['reg', '(r)'],
  ['trade', '(tm)'],
  ['euro', 'EUR'],
  ['pound', 'GBP'],
]);

const MAX_CODE_POINT = 0x10_ff_ff;

/** One entity → its character, or the entity verbatim when it is not one we know. */
function decodeEntity(match: string, body: string): string {
  const lower = body.toLowerCase();
  if (lower.startsWith('#')) {
    const digits = lower.startsWith('#x') ? body.slice(2) : body.slice(1);
    const code = Number.parseInt(digits, lower.startsWith('#x') ? 16 : 10);
    // The guards are the whole reason this is a function: `fromCodePoint` throws
    // on a value out of range or a lone surrogate, and a throw here is a throw in
    // the ingest funnel.
    if (!Number.isInteger(code) || code <= 0 || code > MAX_CODE_POINT) return match;
    if (code >= 0xd8_00 && code <= 0xdf_ff) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  }
  return NAMED_ENTITIES.get(lower) ?? match;
}

/**
 * Strip HTML to the words inside it, collapse the whitespace, and cap it.
 *
 * Never throws, and always returns a string — `''` for anything unrecognizable,
 * which the caller treats the same as "no body" and falls back from.
 */
export function htmlToText(html: unknown, maxChars: number = MAX_BODY_CHARS): string {
  if (typeof html !== 'string' || html.length === 0) return '';
  const text = html
    .replace(SCRIPT_OR_STYLE, ' ')
    .replace(COMMENT, ' ')
    .replace(BLOCK_BREAK, '\n')
    .replace(TAG, ' ')
    .replace(ENTITY, decodeEntity)
    // Runs of horizontal space collapse to one, runs of newlines to one — in that
    // order, so `</p>\n   \n<p>` becomes a single break and not three.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
