// SPDX-License-Identifier: Apache-2.0
/**
 * How a capture's request/response body is stored.
 *
 * Bodies are the overwhelming majority of the store: the engines cap a single
 * body at 5 MB and a busy Slack workspace produces thousands of JSON responses
 * an hour, so `~/.sluice/sluice.db` was mostly uncompressed JSON. gzip is a very
 * good fit for it — API responses are repetitive, key-heavy text — and it costs
 * one stdlib call, no dependency.
 *
 * Each body carries its own encoding column, so a row self-describes and old
 * rows written before this existed keep working untouched: a NULL encoding means
 * "plain text", which is exactly what they are. Request and response are encoded
 * independently, because the common shape is a tiny request with a large
 * response and compressing the request would only add overhead.
 *
 * Two invariants this module cannot enforce but everything depends on:
 *
 *   1. Compression happens strictly AFTER redaction. The redactor works on text;
 *      handing it a gzip Buffer would silently pass secrets through.
 *   2. The FTS index is fed the PLAINTEXT (already-redacted) body at insert time.
 *      A gzip Buffer cannot be tokenized, so search and compression have to read
 *      the same value at the same moment.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

/** The only non-null value `*_body_encoding` ever holds today. */
export const BODY_ENCODING_GZIP = 'gzip';

/**
 * Bodies at or below this stay plain text.
 *
 * gzip adds ~20 bytes of header and trailer and defeats SQLite's own record
 * packing, so compressing a 200-byte `{"ok":true}` makes the row bigger. It also
 * keeps small bodies greppable with the sqlite3 CLI, which is genuinely useful
 * when debugging a capture by hand.
 */
export const BODY_COMPRESS_THRESHOLD = 2048;

/** A body as it goes to SQLite: text below the threshold, gzip BLOB above it. */
export interface EncodedBody {
  value: string | Buffer | null;
  encoding: string | null;
}

/** Choose a storage form for one already-redacted body. */
export function encodeBody(text: string | null | undefined): EncodedBody {
  if (text === null || text === undefined) return { value: null, encoding: null };
  if (text.length <= BODY_COMPRESS_THRESHOLD) return { value: text, encoding: null };
  return { value: gzipSync(Buffer.from(text, 'utf8')), encoding: BODY_ENCODING_GZIP };
}

/**
 * Read one body back out of SQLite.
 *
 * Deliberately total: a body that cannot be decoded returns null rather than
 * throwing. `listCaptures` feeds the WS backfill, the cartographer and the
 * api-map, so one truncated write — or a `--db` someone edited by hand — would
 * otherwise throw out of every one of those paths at once. This mirrors how the
 * store already treats malformed JSON columns.
 */
export function decodeBody(value: unknown, encoding: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (encoding === BODY_ENCODING_GZIP) {
    if (!Buffer.isBuffer(value)) {
      // Marked compressed but stored as text — only reachable via a hand-edited
      // database. Trust the bytes, not the flag.
      return typeof value === 'string' ? value : null;
    }
    try {
      return gunzipSync(value).toString('utf8');
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') return value;
  // No encoding flag but a BLOB anyway: a body that happened to be written as
  // bytes. utf8-decode it rather than dropping it.
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return null;
}
