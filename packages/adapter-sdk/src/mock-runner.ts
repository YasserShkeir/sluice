// SPDX-License-Identifier: Apache-2.0
/**
 * Replay recorded captures as if they were arriving live.
 *
 * Every path that exercises a parser today goes through a real network call
 * against a real signed-in account, which means the store, the WS protocol and
 * the dashboard can only be tested by someone holding credentials for the
 * service in question. That is the single biggest tax on working on this
 * codebase, and it is why the plan called this a week-one dependency.
 *
 * The mock runner reads an NDJSON fixture and feeds each line to the SAME sink
 * the live engines use. That is the whole design: it is not a second ingest
 * path, so anything it exercises is exercised exactly as production does it —
 * attribution, redaction, the store, the entity broadcast, the UI. A bug it
 * cannot reproduce is a bug that genuinely is not in that path.
 *
 * Timing is derived from the fixture's own `ts` deltas, so a replay looks like
 * the traffic burst it recorded rather than an instantaneous dump — which is
 * what makes it useful for anything reacting to arrival rate (debounced
 * materialize, the "N new" pill, backpressure).
 */
import type { Capture } from '@sluice/core';

/** Where a replayed capture goes. This is `startServer(...).ingest` in practice. */
export type CaptureSink = (capture: Capture) => void;

export interface MockRunOptions {
  /**
   * Wall-clock speed. 1 replays at the recorded rate; 10 and 100 compress it.
   * `Infinity` replays with no delay at all, which is what a unit test wants.
   */
  speed?: number;
  /**
   * Never wait longer than this between two captures, whatever the fixture says.
   * A recording with a ten-minute idle gap in the middle is otherwise unusable.
   */
  maxGapMs?: number;
  /**
   * Rewrite each capture's `ts` to now-relative. Off by default: preserving the
   * recorded timestamps is what makes a run reproducible, which is the point.
   * Turn it on when you want the dashboard's time axis to look plausible.
   */
  retime?: boolean;
  /** Stop early. Resolves with however many captures were replayed. */
  signal?: AbortSignal;
  /** Called after each capture, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Parse NDJSON into captures, skipping anything malformed.
 *
 * A fixture is a file someone hand-edited to scrub it, so a broken line is an
 * expected condition, not an exceptional one — and losing the whole fixture to
 * one bad line would be a poor trade. Returns what it could read plus the line
 * numbers it could not, so a caller can report rather than guess.
 */
export function parseNdjson(text: string): { captures: Capture[]; skipped: number[] } {
  const captures: Capture[] = [];
  const skipped: number[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as Capture).id === 'string') {
        captures.push(parsed as Capture);
      } else {
        skipped.push(i + 1);
      }
    } catch {
      skipped.push(i + 1);
    }
  }
  return { captures, skipped };
}

/** Serialize captures to NDJSON — the inverse of {@link parseNdjson}. */
export function toNdjson(captures: Capture[]): string {
  return captures.map((c) => JSON.stringify(c)).join('\n') + (captures.length > 0 ? '\n' : '');
}

/**
 * Feed captures to `sink`, pacing them by their recorded arrival times.
 *
 * Resolves with the number replayed. Aborting resolves rather than rejects: a
 * partial replay is a legitimate outcome, not an error.
 */
export async function runMockCaptures(
  captures: Capture[],
  sink: CaptureSink,
  opts: MockRunOptions = {},
): Promise<number> {
  const speed = opts.speed ?? 1;
  const maxGapMs = opts.maxGapMs ?? 2_000;
  // Sort by recorded time so an out-of-order fixture still replays as recorded.
  // This matters beyond aesthetics: Slack resolves a channel's workspace from
  // whichever endpoint arrives first, so order changes what the store ends up
  // holding.
  const ordered = [...captures].sort((a, b) => a.ts - b.ts);
  const base = ordered[0]?.ts ?? 0;
  const startedAt = Date.now();

  let done = 0;
  let previousTs = base;
  for (const capture of ordered) {
    if (opts.signal?.aborted) break;

    const gap = Math.max(0, capture.ts - previousTs);
    previousTs = capture.ts;
    const delay = Number.isFinite(speed) && speed > 0 ? Math.min(gap / speed, maxGapMs) : 0;
    if (delay >= 1) await sleep(delay, opts.signal);
    if (opts.signal?.aborted) break;

    sink(opts.retime ? { ...capture, ts: startedAt + (capture.ts - base) / (speed || 1) } : capture);
    done += 1;
    opts.onProgress?.(done, ordered.length);
  }
  return done;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}
