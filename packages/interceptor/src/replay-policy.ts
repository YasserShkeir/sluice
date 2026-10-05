// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Replay safety rails.
 *
 * Sluice reads your own session, and a replay should never post a message,
 * invite someone, delete a card, or touch an admin endpoint. Nothing enforced
 * that before: the replay path issued whatever URL and method it was handed.
 *
 * These checks live here, below every caller (CLI, WS server, MCP tool), rather
 * than in the UI, precisely so a modified frontend or a creative tool argument
 * cannot route around them. They are heuristics that refuse what looks like a
 * write, NOT a proof that an allowed request does not mutate.
 *
 * Independent limits:
 *   1. Method — mutating verbs are refused outright.
 *   2. Operation — a best-effort denylist of write/admin operations (plus
 *      method-override headers and fields), since services like Slack use POST
 *      for ordinary reads and the verb alone proves nothing.
 *   3. Host — the URL must be within the owning app's hosts (required by
 *      `runReplay`).
 *   4. Budget — a token bucket plus single-flight concurrency, so a runaway loop
 *      cannot hammer the service and get the account rate-limited or flagged.
 */
import type { ReplayBudgetState, ReplayRequest } from '@sluice/core';
import { isReplayMethodAllowed, looksLikeDeniedReplay, replayHostAllowed, replayRequestProbe } from '@sluice/core';

export type ReplayDenialCode =
  | 'method_not_allowed'
  | 'operation_not_allowed'
  | 'host_not_allowed'
  | 'rate_budget_exhausted';

export class ReplayDeniedError extends Error {
  readonly code: ReplayDenialCode;
  constructor(code: ReplayDenialCode, message: string) {
    super(message);
    this.name = 'ReplayDeniedError';
    this.code = code;
  }
}

const DEFAULT_CAPACITY = 60;
const DEFAULT_REFILL_MS = 60_000;

/**
 * A token bucket shared by every replay in the process. Deliberately global: the
 * point is to bound what Sluice does to *your account*, and the service does not
 * care which of our code paths issued the call.
 */
class ReplayBudget {
  private readonly capacity = DEFAULT_CAPACITY;
  private readonly refillMs = DEFAULT_REFILL_MS;
  private tokens = DEFAULT_CAPACITY;
  private lastRefill = Date.now();

  /** Restore this instance to its defaults — used by tests. */
  reset(): void {
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
   * How long until the bucket has a token again, in ms. Derived from `lastRefill`
   * rather than the window length: a bucket drained 55s into a 60s window is one
   * token away, not a whole window.
   */
  private msUntilNextToken(): number {
    if (this.tokens >= 1) return 0;
    const perToken = this.refillMs / this.capacity;
    const elapsed = Date.now() - this.lastRefill;
    return Math.max(0, Math.ceil(perToken - (elapsed % perToken)));
  }

  /**
   * The budget as a value for the UI meter, so an operator sees it drain before
   * a refusal. `refill()` runs first so an idle dashboard's snapshot is not stale.
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
 * Reject a request that looks like a write. Throws `ReplayDeniedError`; callers
 * surface `err.code` so the UI and MCP can distinguish a policy refusal from a
 * network failure.
 *
 * `allowedHosts` (the owning app's declared hosts) turns on the host rail: the
 * URL's host must equal one of them or be a subdomain of one (`*.` is
 * stripped). An empty list allows nothing. `runReplay` always passes the owning
 * app's hosts; omitting it here (unit tests only) skips the host check.
 */
export function assertReplayAllowed(
  req: ReplayRequest,
  opts: { allowedHosts?: readonly string[] } = {},
): void {
  const method = (req.method || 'GET').toUpperCase();
  if (!isReplayMethodAllowed(method)) {
    throw new ReplayDeniedError(
      'method_not_allowed',
      `replay refused: ${method} can only mutate; replay allows GET, HEAD and POST.`,
    );
  }

  // The operation name can also ride in a form body (Slack sends it in the path,
  // but some services put it in the payload), so the path, query and body are
  // all checked — as sent and percent-decoded — plus method-override headers
  // and `_method` fields. Method-aware: a POST to /api/orders places an order,
  // while a GET of the same path reads them. The flow build gate runs the same
  // core check, so the two cannot drift.
  if (looksLikeDeniedReplay({ ...req, method })) {
    throw new ReplayDeniedError(
      'operation_not_allowed',
      'replay refused: this matches the write/admin operation denylist.',
    );
  }

  if (opts.allowedHosts) {
    const { host } = replayRequestProbe(req.url);
    if (!replayHostAllowed(host, opts.allowedHosts)) {
      throw new ReplayDeniedError(
        'host_not_allowed',
        `replay refused: host "${host}" is outside the app's declared hosts.`,
      );
    }
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
