// SPDX-License-Identifier: Apache-2.0
/**
 * An app MCP tool's live call to its service — through the host's replay
 * pipeline, and only through it.
 *
 * There is deliberately no bare-`fetch` fallback: it would send a live session
 * cookie with no replay rails (method allowlist, operation denylist, budget), no
 * learned fingerprint and no capture record. A tool run without a host context
 * gets a named error instead, as `requireStore` does.
 */
import { isAuthFailure } from '@sluice/core';
import type { AppToolContext, ReplayRequest } from '@sluice/core';

/**
 * A real Chrome macOS User-Agent: the default for an adapter's browser-like
 * headers. It is only a fallback guess — faithful replay overrides it with the
 * user's learned UA once a capture for the endpoint exists.
 */
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

/**
 * Assert the host gave this tool a replay pipeline, or throw the named refusal.
 * Use it when a tool needs the whole Capture back rather than a {@link LiveAttempt}.
 *
 * @example
 * requireReplay(ctx);
 * const capture = await ctx.replay({ method: 'GET', url, headers });
 */
export function requireReplay(ctx: AppToolContext | undefined): asserts ctx is AppToolContext {
  if (typeof ctx?.replay !== 'function') {
    throw new Error(
      'This tool calls its service through the Sluice replay pipeline, and the host did not provide one. Run it through `sluice-mcp`.',
    );
  }
}

/** What one attempt produced: the body, or enough to decide whether to retry. */
export interface LiveAttempt {
  status: number | null;
  body: string | null;
  /** core's `isAuthFailure`: a 401, or a 2xx carrying an expired-session error code. */
  authFailed: boolean;
}

/**
 * One request through `ctx.replay`, no retry: it overlays the real client's
 * learned fingerprint, passes the replay safety rails and the shared budget, and
 * lands in the capture store like any other Sluice request. Throws when the host
 * gave no context — it never falls back to a bare `fetch`.
 *
 * @example
 * const attempt = await replayAttempt({ method: 'GET', url, headers }, ctx);
 * if (attempt.status === null || attempt.status >= 400) throw new Error(`HTTP ${attempt.status ?? 'error'}`);
 */
export async function replayAttempt(
  req: ReplayRequest,
  ctx: AppToolContext | undefined,
): Promise<LiveAttempt> {
  requireReplay(ctx);
  const capture = await ctx.replay(req);
  return { status: capture.status, body: capture.resBody, authFailed: isAuthFailure(capture) };
}

/**
 * Send with the current cookie; on an auth failure re-read it ONCE and, if it
 * changed, send again.
 *
 * Re-reading IS the mechanism: nothing is cached, so Sluice still has nowhere to
 * keep a secret. A `reread` that throws, or returns the same cookie, keeps the
 * first attempt — the original auth failure is the more useful report, and an
 * identical cookie would only earn the same answer and burn another request.
 *
 * The second send starts only after the first has settled. `ctx.replay` funnels
 * into a single-slot mutex (`withReplaySlot`) that deadlocks if re-entered, so
 * `send` must never be called from inside itself.
 *
 * @example
 * const { attempt, refreshed } = await withCookieRefresh(
 *   cookieHeader,
 *   (cookie) => replayAttempt({ method: 'GET', url, headers: headersFor(cookie) }, ctx),
 *   () => readChromeCookieHeader({ domainSuffix: 'trello.com', serviceLabel: 'Trello' }).cookieHeader,
 * );
 * if (refreshed && attempt.authFailed) throw new Error('expired even after re-reading it; sign in again');
 */
export async function withCookieRefresh(
  cookieHeader: string,
  send: (cookie: string) => Promise<LiveAttempt>,
  reread: () => string,
): Promise<{ attempt: LiveAttempt; refreshed: boolean }> {
  const first = await send(cookieHeader);
  if (!first.authFailed) return { attempt: first, refreshed: false };
  let fresh: string;
  try {
    fresh = reread();
  } catch {
    return { attempt: first, refreshed: false };
  }
  if (fresh === cookieHeader) return { attempt: first, refreshed: false };
  return { attempt: await send(fresh), refreshed: true };
}
