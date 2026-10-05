// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 401 → re-extract the local credential → retry once.
 *
 * Re-extracting instead of keeping a credential vault: a vault would make the
 * store a durable home for live sessions, and the store must have nowhere to put
 * a secret (SECURITY.md). This function stores nothing. It re-runs the app's own
 * extractor (the same consent boundary as the first call) and discards the
 * fresh Session after the retry.
 *
 * The retry must stay a plain sequential second call from a layer above, never
 * moved into replay.ts: `withReplaySlot` chains on a module-level in-flight
 * promise, so calling `runReplay` from inside anything `runReplay` invoked hangs
 * silently. ONCE, because `replayBudget` is a process-global 60/60s bucket and a
 * looping retry trips the rate limit mid-sync and causes a Keychain prompt storm.
 * Rebuild and record both: see {@link RefreshableReplay.build} and
 * {@link RefreshableReplay.record}; the failed attempt is recorded as evidence of
 * when the session expired.
 */
import { isAuthFailure } from '@sluice/core';
import type { Capture, ReplayRequest, Session } from '@sluice/core';
import { ReplayDeniedError } from './replay-policy.js';

export interface RefreshableReplay {
  /**
   * Build the request for a session. Called AGAIN with the refreshed session on
   * retry, so it must derive everything from its argument — a closure over the
   * first session would silently resend the stale credential.
   */
  build(session: Session): ReplayRequest;
  /**
   * Execute one request. This is where `runReplay` goes; it is called
   * sequentially, never nested, for the reason in the header.
   */
  run(req: ReplayRequest): Promise<Capture>;
  /**
   * Persist/attribute a capture. Called for the FAILED attempt and again for the
   * retry, in that order, so both land in the store exactly as an ordinary
   * replay would.
   */
  record?(capture: Capture): void;
  /**
   * Mint a fresh Session from local state. Return undefined when this app cannot
   * refresh — a credential-free app (fast.com replays with a synthetic empty
   * session) must never be sent to a Keychain prompt it has no use for.
   */
  refresh?(): Promise<Session | undefined>;
  /** Diagnostics. Never receives a request, a session or a header. */
  onRetry?(reason: string): void;
}

/**
 * Replay once; on an auth failure, re-extract and replay once more.
 *
 * Returns whichever capture is the final answer — the retry's if there was one,
 * otherwise the first. Never returns the intermediate 401 while pretending it
 * was the only attempt: `record` has seen both by then.
 */
export async function replayWithRefresh(
  session: Session,
  io: RefreshableReplay,
): Promise<Capture> {
  const first = await io.run(io.build(session));
  io.record?.(first);

  if (!isAuthFailure(first) || io.refresh === undefined) return first;

  let fresh: Session | undefined;
  try {
    fresh = await io.refresh();
  } catch {
    // The extractor failing is not this function's error to report — the caller
    // already has a perfectly good auth failure to hand back, and replacing it
    // with "could not read the keychain" would hide what actually went wrong.
    return first;
  }
  if (!fresh) return first;

  io.onRetry?.('credential re-extracted after an auth failure');

  try {
    const second = await io.run(io.build(fresh));
    io.record?.(second);
    return second;
  } catch (e) {
    // A policy refusal on the retry is not an auth problem and must surface as
    // itself. Anything else (network, timeout) leaves the original failure as
    // the better answer.
    if (e instanceof ReplayDeniedError) throw e;
    return first;
  }
}
