// SPDX-License-Identifier: Apache-2.0
/**
 * How a capture's request/response body is stored: plain text up to
 * BODY_COMPRESS_THRESHOLD, gzip above it. Each body has its own encoding column,
 * so rows self-describe; NULL means plain text (every row written before
 * compression).
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
 * Bodies at or below this stay plain text: gzip's ~20-byte overhead makes small
 * rows bigger, and small bodies stay greppable with the sqlite3 CLI.
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
 * Read one body back out of SQLite. Total: an undecodable body returns null
 * rather than throwing, so one bad row cannot break every reader of listCaptures.
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
