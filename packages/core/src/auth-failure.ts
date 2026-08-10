// SPDX-License-Identifier: Apache-2.0
/**
 * "Did this call fail because the session is no longer good?"
 *
 * One shared answer, because getting it wrong in either direction is expensive.
 * Too narrow and a long-running agent workflow dies on a cookie that could have
 * been re-read in a millisecond. Too broad and every ordinary 403 — a private
 * channel, a board you were removed from — triggers a Keychain prompt.
 *
 * The trap this exists to avoid: a `status === 401` check LOOKS complete and
 * silently misses Slack entirely. Slack answers an expired session with
 * **HTTP 200** and `{"ok":false,"error":"not_authed"}`, and Slack is the app with
 * the most session churn — so the naive version would have made this feature
 * look finished while the case that motivated it stayed broken.
 */
import type { Capture } from './types.js';

/**
 * Service-level error codes that mean "your credential is no longer valid",
 * returned with a 2xx by APIs that treat HTTP as a transport rather than a
 * status channel.
 *
 * Deliberately a fixed list rather than a substring match on "auth": Slack's
 * `not_in_channel`, `channel_not_found` and `missing_scope` are all authorization
 * outcomes that re-extracting cannot fix, and retrying them would burn the
 * replay budget and prompt for a Keychain unlock to no purpose.
 */
const EXPIRED_CODES: ReadonlySet<string> = new Set([
  // Slack
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  // Common elsewhere
  'unauthenticated',
  'unauthorized',
  'invalid_token',
  'expired_token',
  'session_expired',
]);

/** The service's own error code, if the body carries one. Never throws. */
function serviceErrorCode(body: string | null | undefined): string | undefined {
  if (!body || body.length === 0 || !body.includes('"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const o = parsed as { ok?: unknown; error?: unknown };
  // `ok: false` is the shape that makes a 200 a failure. Without it, an `error`
  // key could just as easily be a field of a successful payload.
  if (o.ok !== false) return undefined;
  return typeof o.error === 'string' ? o.error : undefined;
}

/**
 * Would re-reading the local credential plausibly fix this call?
 *
 * 401 always. 403 never: it is overwhelmingly "you are authenticated and not
 * allowed", and a fresh copy of the same session changes nothing — treating it
 * as expiry means a Keychain prompt every time you touch a private channel.
 */
export function isAuthFailure(capture: Pick<Capture, 'status' | 'resBody'>): boolean {
  if (capture.status === 401) return true;
  const code = serviceErrorCode(capture.resBody);
  return code !== undefined && EXPIRED_CODES.has(code);
}

/** The service error code behind a failure, for a message a human can act on. */
export function authFailureReason(capture: Pick<Capture, 'status' | 'resBody'>): string {
  return serviceErrorCode(capture.resBody) ?? (capture.status === 401 ? 'HTTP 401' : 'auth failure');
}
