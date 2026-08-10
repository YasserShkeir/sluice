// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Replay safety rails.
 *
 * Sluice reads your own session. The single most important property is that it
 * cannot *act* as you — a replay should never post a message, invite someone,
 * delete a card, or touch an admin endpoint. Nothing enforced that before: the
 * replay path issued whatever URL and method it was handed.
 *
 * These checks live here, below every caller (CLI, WS server, MCP tool), rather
 * than in the UI, precisely so a modified frontend or a creative tool argument
 * cannot route around them.
 *
 * Three independent limits:
 *   1. Method — mutating verbs are refused outright.
 *   2. Operation — a denylist of write/admin operation names, since services like
 *      Slack use POST for ordinary reads and the verb alone proves nothing.
 *   3. Budget — a token bucket plus single-flight concurrency, so a runaway loop
 *      cannot hammer the service and get the account rate-limited or flagged.
 */
import type { ReplayBudgetState, ReplayRequest } from '@sluice/core';
import { looksLikeDeniedOperation } from '@sluice/core';

export type ReplayDenialCode =
  | 'method_not_allowed'
  | 'operation_not_allowed'
  | 'rate_budget_exhausted';

export class ReplayDeniedError extends Error {
  readonly code: ReplayDenialCode;
  constructor(code: ReplayDenialCode, message: string) {
    super(message);
    this.name = 'ReplayDeniedError';
    this.code = code;
  }
}

/** Verbs that can only mutate. GET/HEAD are reads; POST is ambiguous (see below). */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

export interface ReplayBudgetOptions {
  /** Requests permitted per window. */
  capacity?: number;
  /** Window length in ms over which the bucket fully refills. */
  refillMs?: number;
}

const DEFAULT_CAPACITY = 60;
const DEFAULT_REFILL_MS = 60_000;

/**
 * A token bucket shared by every replay in the process. Deliberately global: the
 * point is to bound what Sluice does to *your account*, and the service does not
 * care which of our code paths issued the call.
 */
class ReplayBudget {
  private capacity = DEFAULT_CAPACITY;
  private refillMs = DEFAULT_REFILL_MS;
  private tokens = DEFAULT_CAPACITY;
  private lastRefill = Date.now();

  configure(opts: ReplayBudgetOptions): void {
    if (opts.capacity !== undefined && opts.capacity > 0) {
      this.capacity = opts.capacity;
      this.tokens = Math.min(this.tokens, opts.capacity);
    }
    if (opts.refillMs !== undefined && opts.refillMs > 0) this.refillMs = opts.refillMs;
  }

  /** Restore this instance to its defaults — used by tests. */
  reset(): void {
    this.capacity = DEFAULT_CAPACITY;
    this.refillMs = DEFAULT_REFILL_MS;
    this.tokens = DEFAULT_CAPACITY;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const gained = (elapsed / this.refillMs) * this.capacity;
    if (gained < 1) return;
    this.tokens = Math.min(this.capacity, this.tokens + Math.floor(gained));
    this.lastRefill = now;
  }

  take(): void {
    this.refill();
    if (this.tokens < 1) {
      const waitMs = this.msUntilNextToken();
      throw new ReplayDeniedError(
        'rate_budget_exhausted',
        `replay rate budget exhausted (${this.capacity} per ${Math.round(this.refillMs / 1000)}s); retry in ~${Math.ceil(waitMs / 1000)}s`,
      );
    }
    this.tokens -= 1;
  }

  /**
   * How long until the bucket has a token again, in ms. 0 when it already does.
   *
   * Derived from `lastRefill` rather than from the window length, because a
   * bucket that was drained 55 seconds into a 60-second window is one token away
   * and a whole window is the wrong thing to tell someone waiting on it.
   */
  private msUntilNextToken(): number {
    if (this.tokens >= 1) return 0;
    const perToken = this.refillMs / this.capacity;
    const elapsed = Date.now() - this.lastRefill;
    return Math.max(0, Math.ceil(perToken - (elapsed % perToken)));
  }

  /**
   * The budget as a value, for anything that has to SHOW it.
   *
   * The bucket was write-only: the single signal it produced was a thrown
   * `ReplayDeniedError` at the moment it was already exhausted. That is the
   * worst possible time to learn about a rate limit — an operator watching a
   * meter drain slows down, and one who gets a refusal has already spent the
   * budget on the request that got refused.
   *
   * `refill()` runs first so the snapshot is not stale by however long it has
   * been since anything replayed, which on an idle dashboard is the whole
   * session.
   */
  snapshot(): ReplayBudgetState {
    this.refill();
    return {
      tokens: Math.floor(this.tokens),
      capacity: this.capacity,
      refillMs: this.refillMs,
      retryAfterMs: this.msUntilNextToken(),
    };
  }
}


export const replayBudget = new ReplayBudget();

/**
 * Reject a request that would write. Throws `ReplayDeniedError`; callers surface
 * `err.code` so the UI and MCP can distinguish a policy refusal from a network
 * failure.
 */
export function assertReplayAllowed(req: ReplayRequest): void {
  const method = (req.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new ReplayDeniedError(
      'method_not_allowed',
      `replay refused: ${method} can only mutate. Sluice replays reads only.`,
    );
  }

  let probe = req.url;
  try {
    const u = new URL(req.url);
    probe = `${u.pathname}?${u.searchParams.toString()}`;
  } catch {
    /* not a parseable URL — match against the raw string instead */
  }
  // The operation name can also ride in a form body (Slack sends it in the path,
  // but some services put it in the payload), so check both.
  if (looksLikeDeniedOperation(probe, req.body)) {
    throw new ReplayDeniedError(
      'operation_not_allowed',
      `replay refused: this looks like a write/admin operation. Sluice replays reads only.`,
    );
  }
}

/**
 * Single-flight gate. Replays are diagnostic, not a throughput path, and running
 * them one at a time keeps request pacing legible to the service (and to the
 * user watching the traffic table).
 */
let inFlight: Promise<unknown> = Promise.resolve();

export function withReplaySlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = inFlight.then(fn, fn);
  // Keep the chain alive regardless of outcome so one failure can't wedge it.
  inFlight = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
