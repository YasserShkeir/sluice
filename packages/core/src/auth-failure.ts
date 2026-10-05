// SPDX-License-Identifier: Apache-2.0
/**
 * "Did this call fail because the session is no longer good?" — one shared
 * answer. Too narrow and a workflow dies on a cookie that could be re-read; too
 * broad and every ordinary 403 triggers a Keychain prompt. A `status === 401`
 * check alone misses Slack, which answers an expired session with HTTP 200 and
 * `{"ok":false,"error":"not_authed"}`.
 */
import type { Capture } from './types.js';
import { safeJsonObject } from './util.js';

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

/**
 * A Slack-style `{ ok:false, error?, needed?, provided? }` failure body, else
 * undefined. Never throws. `ok: false` is what makes a 200 a failure; without
 * it, an `error` key could just as easily be a field of a successful payload.
 */
export function serviceError(
  body: string | null | undefined,
): { error?: string; needed?: string; provided?: string } | undefined {
  const o = body?.includes('"') ? safeJsonObject(body) : undefined;
  if (o?.ok !== false) return undefined;
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return { error: s(o.error), needed: s(o.needed), provided: s(o.provided) };
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
  const code = serviceError(capture.resBody)?.error;
  return code !== undefined && EXPIRED_CODES.has(code);
}
