// SPDX-License-Identifier: Apache-2.0
/**
 * Recover the parameters a request was made WITH.
 *
 * This is not a convenience. Slack's `conversations.history` and
 * `conversations.replies` responses do not contain the channel id anywhere — it
 * exists only in the request — so a parser that cannot read the request produces
 * zero items for the single most valuable endpoint there is, silently and
 * without an error. `ts` on `conversations.replies` has the same problem.
 *
 * Services are inconsistent about where they put parameters, and the same
 * service is inconsistent with itself, so all three carriers are read with the
 * query string winning: it is the one the client author chose to make visible.
 */
import type { Capture } from '@sluice/core';
import { obj, safeJson } from './coerce.js';

/**
 * Every request parameter, from the query string, a urlencoded body, or a JSON
 * body — in that precedence. Never throws; an unparseable body yields nothing.
 */
export function requestParams(capture: Capture): Record<string, string> {
  const out: Record<string, string> = {};

  const body = capture.reqBody;
  if (body !== null && body !== undefined && body.length > 0) {
    const json = obj(safeJson(body));
    if (json) {
      for (const [k, v] of Object.entries(json)) {
        if (typeof v === 'string') out[k] = v;
        else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
      }
    } else {
      // Not JSON — try urlencoded. URLSearchParams never throws, it just yields
      // nothing useful for, say, a multipart body, which is the right outcome.
      try {
        for (const [k, v] of new URLSearchParams(body)) out[k] = v;
      } catch {
        /* not form-encoded either */
      }
    }
  }

  try {
    for (const [k, v] of new URL(capture.url).searchParams) out[k] = v;
  } catch {
    /* a malformed url still leaves whatever the body gave us */
  }

  return out;
}

/** One request parameter by name. See {@link requestParams} for where it looks. */
export function requestParam(capture: Capture, name: string): string | undefined {
  return requestParams(capture)[name];
}
