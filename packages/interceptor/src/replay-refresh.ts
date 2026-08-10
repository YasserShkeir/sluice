// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 401 → re-extract the local credential → retry once.
 *
 * This is what the roadmap chose INSTEAD of a keychain-backed credential vault.
 * A vault would make an agent workflow survive cookie expiry, but it would also
 * make `~/.sluice/sluice.db` a durable store of live sessions for every app you
 * have ever used — and SECURITY.md leads with the opposite claim, that the store
 * has nowhere to put a secret. That is not an implementation gap; it is why the
 * threat model is small. Re-extracting per call is slower and strictly safer:
 * the OS already solves storage, and it already asks permission.
 *
 * So this function stores nothing. It re-runs the app's own extractor, which is
 * the same consent boundary as the first call, and throws the fresh Session away
 * as soon as the retry completes.
 *
 * ── Why it lives ABOVE runReplay, and must ─────────────────────────────────
 *
 * `withReplaySlot` chains on a module-level in-flight promise that only settles
 * once the current replay resolves. Calling `runReplay` again from inside
 * anything `runReplay` invoked — a hook, a callback, an adapter method — awaits a
 * promise that is waiting on the outer call, and the process hangs with no error
 * and no stack. The retry therefore has to be a plain sequential second call
 * from a layer above, which is exactly what this is. Do not "simplify" it into
 * replay.ts.
 *
 * ── The other three rules ──────────────────────────────────────────────────
 *
 * ONCE. `replayBudget` is a process-global 60-per-60s bucket, and a sync run
 * replays N actions per session. A retry that loops turns one expired cookie
 * into a rate-limit trip mid-sync, and re-extraction can raise a Keychain
 * prompt, so a loop is also a prompt storm.
 *
 * REBUILD, never reuse. The first attempt's request carries the STALE credential
 * in its headers. Retrying with it sends the dead cookie straight back, gets the
 * same 401, and looks like the refresh did not work.
 *
 * RECORD BOTH. The failed attempt is evidence — it is what makes "your Slack
 * session expired at 14:03" answerable later. Dropping it from the store to keep
 * the audit trail tidy is exactly backwards.
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
