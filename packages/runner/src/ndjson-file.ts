// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Read an NDJSON fixture without ever holding it as one string.
 *
 * `parseNdjson(readFileSync(file, 'utf8'))` is the obvious spelling and it has
 * the same ~512 MB ceiling that `sluice record` used to hit from the other side:
 * V8 caps a single string there, so a 773 MB recording of one Notion crawl could
 * be written but not read back — a round trip that only failed at the size it
 * exists for. Chunked reads keep whole lines and hand each one to the same
 * parser, so line numbers in the skip report still match the file.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parseNdjson } from '@sluice/adapter-sdk';
import type { Capture } from '@sluice/core';

const CHUNK_BYTES = 32 * 1024 * 1024;

export function readNdjsonFile(
  file: string,
  chunkBytes = CHUNK_BYTES,
): { captures: Capture[]; skipped: number[] } {
  const fd = openSync(file, 'r');
  const buf = Buffer.allocUnsafe(chunkBytes);
  // A chunk boundary can fall inside a multi-byte character. Decoding each chunk
  // on its own turns both halves into U+FFFD, which JSON.parse accepts, so the
  // record would load with its text quietly corrupted. StringDecoder holds the
  // incomplete bytes back until the next chunk completes them.
  const decoder = new StringDecoder('utf8');
  const captures: Capture[] = [];
  const skipped: number[] = [];
  let tail = '';
  let lineNo = 0;
  const take = (line: string): void => {
    lineNo += 1;
    const parsed = parseNdjson(line);
    captures.push(...parsed.captures);
    if (parsed.skipped.length > 0) skipped.push(lineNo);
  };
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) break;
      const lines = (tail + decoder.write(buf.subarray(0, n))).split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) take(line);
    }
    tail += decoder.end();
    if (tail.trim().length > 0) take(tail);
  } finally {
    closeSync(fd);
  }
  return { captures, skipped };
}
