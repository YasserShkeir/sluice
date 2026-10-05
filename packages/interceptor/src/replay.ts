// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Replay — re-issue a prepared ReplayRequest against the real target service with
 * global `fetch` (genuine outbound HTTPS through the OS trust store, no proxy/CA),
 * time it, and return a normalized, secret-redacted Capture (`source: 'replay'`)
 * that re-enters the identical ingest funnel as live captures.
 *
 * A network-level failure throws (redacted); any HTTP response — including 4xx/5xx
 * and a 3xx, which is never followed — comes back as a Capture so the caller can
 * inspect it.
 */
import { redactedErrorMessage, splitUrl } from '@sluice/core';
import type { Capture, ReplayRequest } from '@sluice/core';
import { capBody, redactedCapture } from './capture-build.js';
import { assertReplayAllowed, replayBudget, withReplaySlot } from './replay-policy.js';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Drop header values undici would reject, at the ONE boundary every replay
 * crosses. undici throws `Cannot convert argument to a ByteString` out of the
 * whole fetch on any header value with a code unit > 255; guarding here covers
 * every path into the network (faithful or raw), so a dropped header degrades
 * fidelity instead of failing the replay. HTTP/2 pseudo-headers (`:method`,
 * `:authority`, `:scheme`, `:path`) cannot be set on `fetch` either.
 */
export function sendableHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([k, v]) => !k.startsWith(':') && !/[\u0100-\uffff]/.test(v)));
}

/**
 * Issue a replay, subject to the safety rails in `replay-policy.ts`. The checks
 * are here rather than in each caller so that the CLI, the WS server and the MCP
 * tools all inherit them — there is no path to the network that skips this.
 * `allowedHosts` (the owning app's hosts) is required, so the host rail is too.
 */
export async function runReplay(
  req: ReplayRequest,
  opts: { timeoutMs?: number; allowedHosts: readonly string[] },
): Promise<Capture> {
  assertReplayAllowed(req, { allowedHosts: opts.allowedHosts });
  replayBudget.take();
  return withReplaySlot(() => issue(req, opts));
}

async function issue(req: ReplayRequest, opts: { timeoutMs?: number }): Promise<Capture> {
  const { host, path } = splitUrl(req.url);
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A replay must never hang the CLI/daemon: abort the fetch on a hard deadline.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  let resBodyRaw: string | null = null;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: sendableHeaders(req.headers),
      body: req.body,
      // Never follow a redirect. The rails above checked THIS url only; a 3xx
      // to a write endpoint (or another origin) would re-send the method, the
      // body and custom credential headers past them, and the capture would
      // record the read. undici's 'manual' returns the real 3xx (status and
      // Location readable), which becomes the recorded capture.
      redirect: 'manual',
      signal: ctrl.signal,
    });
    // The timeout covers the body too: a stalled res.text() would hold the single-flight slot.
    resBodyRaw = await res.text().catch(() => null);
  } catch (err) {
    const msg = ctrl.signal.aborted ? `timed out after ${timeoutMs}ms` : redactedErrorMessage(err);
    throw new Error(`replay request failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - startedAt;

  const resHeaders: Record<string, string> = Object.fromEntries(res.headers);

  return redactedCapture({
    ts: startedAt,
    source: 'replay',
    adapterId: null,
    method: req.method,
    url: req.url,
    host,
    path,
    status: res.status,
    durationMs,
    reqHeaders: req.headers,
    reqBody: req.body ?? null,
    resHeaders,
    resBody: resBodyRaw == null ? null : capBody(resBodyRaw),
  });
}
