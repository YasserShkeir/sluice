// SPDX-License-Identifier: Apache-2.0
/**
 * The one persistence funnel every capture passes through before it is stored
 * (live ingest, every CLI write path, the MCP record paths), so redaction,
 * classification, `parsedAt` and seeding cannot diverge.
 */
import { redactCaptureUrls, redactHeaders, redactText } from './redact.js';
import type { SqliteStore, UpsertCounts } from './store.js';
import type { Adapter, Capture, CursorSeed, ParseResult, RequestMatchInput } from './types.js';
import { operationName } from './util.js';

/**
 * Every capture field that can carry a secret, redacted: headers, bodies, and
 * the URL-like fields (`url`, `path`, `tabUrl`, `classification`). Idempotent,
 * so the engines' already-redacted captures come out unchanged; it exists for
 * the paths that are not, the extension above all, which posts raw page URLs.
 */
export function redactCapture(c: Capture): Capture {
  return redactCaptureUrls({
    ...c,
    reqHeaders: redactHeaders(c.reqHeaders ?? {}),
    resHeaders: redactHeaders(c.resHeaders ?? {}),
    reqBody: c.reqBody == null ? c.reqBody : redactText(c.reqBody),
    resBody: c.resBody == null ? c.resBody : redactText(c.resBody),
  });
}

/**
 * The first adapter that claims this exchange (only the four match fields are
 * passed). `matchRequest` is contractually non-throwing; one that throws is
 * skipped and reported via `onError`, so a capture is never lost to it.
 */
export function matchAdapter<A extends Adapter>(
  adapters: readonly A[],
  input: RequestMatchInput,
  onError?: (e: unknown) => void,
): A | undefined {
  const { host, path, method, url } = input;
  for (const a of adapters) {
    try {
      if (a.matchRequest({ host, path, method, url })) return a;
    } catch (e) {
      onError?.(e);
    }
  }
  return undefined;
}

export interface PersistResult {
  /** The capture as stored: redacted, attributed, classified. */
  capture: Capture;
  /** What the adapter parsed out of it; `{}` without an adapter or when parse threw. */
  parsed: ParseResult;
  counts: UpsertCounts;
  /** Cursor seeds newly enqueued from this response. */
  seeded: number;
  /** What `parse` threw, when it did. The capture is still stored, with `parsedAt` null. */
  parseError?: unknown;
}

/**
 * Redact, attribute, classify, store, parse and seed one capture.
 *
 * Never mutates `raw` — flow replay keeps using its own object after recording
 * it. Adapter hooks (`classify`, `parse`, `nextCursors`) are contained: a hook
 * that throws never loses the capture. Store errors still throw.
 */
export function persistCapture(
  store: SqliteStore,
  raw: Capture,
  adapter: Adapter | undefined,
  opts: { reclassify?: boolean } = {},
): PersistResult {
  const capture = redactCapture(raw);
  if (adapter && !capture.adapterId) capture.adapterId = adapter.id; // attribute to its app

  // Prefer the adapter's semantic op (cards/:id, not card/AbCd1234); operationName is the fallback.
  if (adapter?.classify && (opts.reclassify || capture.classification == null)) {
    try {
      const named = adapter.classify(capture);
      if (named.operation) capture.classification = named.operation;
    } catch {
      // classify is contractually non-throwing; never lose a capture to one that does.
    }
  }
  capture.classification ??= operationName(capture.path);

  let parsed: ParseResult = {};
  let parseError: unknown;
  if (adapter) {
    try {
      parsed = adapter.parse(capture);
    } catch (e) {
      parseError = e ?? new Error('parser threw');
    }
  }
  // Stamped after the parse and only when it succeeded, so a capture whose
  // parser threw stays findable as unparsed (null) for `sluice reparse`. Set
  // before the insert, so the row is still written in one statement.
  capture.parsedAt = parseError === undefined ? (capture.parsedAt ?? Date.now()) : null;

  store.insertCapture(capture);
  const counts = store.applyParseResult(parsed, capture.ts || Date.now());

  // Seed the worklist from what this response says is still unfetched. Enqueue only,
  // never execute: seeding is free and deduped, replaying hits a real account.
  let seeds: CursorSeed[] = [];
  if (adapter?.nextCursors) {
    try {
      seeds = adapter.nextCursors(capture);
    } catch {
      // nextCursors is contractually non-throwing; never lose a capture to one that does.
    }
  }
  const seeded = seeds.length > 0 ? store.enqueueCursors(seeds) : 0;

  return { capture, parsed, counts, seeded, parseError };
}
