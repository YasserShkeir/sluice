// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Replay — re-issue a prepared ReplayRequest against the real target service with
 * global `fetch` (genuine outbound HTTPS through the OS trust store, no proxy/CA),
 * time it, and return a normalized, secret-redacted Capture (`source: 'replay'`)
 * that re-enters the identical ingest funnel as live captures.
 *
 * A network-level failure throws (redacted); any HTTP response — including 4xx/5xx
 * — comes back as a Capture so the caller can inspect the error body.
 */
import { newId, redactHeaders, redactText, redactUrl, splitUrl } from '@sluice/core';
import type { Capture, ReplayRequest } from '@sluice/core';
import { assertReplayAllowed, replayBudget, withReplaySlot } from './replay-policy.js';

const MAX_BODY = 5_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Drop header values undici would reject, at the ONE boundary every replay
 * crosses.
 *
 * undici throws `Cannot convert argument to a ByteString` — out of the whole
 * fetch — on any header value with a code unit > 255. `makeFaithful` already
 * guards the values it learns from captures, but a value the ADAPTER put on the
 * base request (or any other caller's) reaches here unguarded, so one odd header
 * failed the entire replay rather than just being omitted. Guarding here covers
 * every path into the network, faithful or raw, which is the same reason the
 * safety rails live at this layer. A dropped header degrades fidelity; a thrown
 * replay returns nothing.
 */
export function sendableHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    let ok = true;
    for (let i = 0; i < v.length; i++) {
      if (v.charCodeAt(i) > 255) {
        ok = false;
        break;
      }
    }
    if (ok) out[k] = v;
  }
  return out;
}

/**
 * Issue a replay, subject to the safety rails in `replay-policy.ts`. The checks
 * are here rather than in each caller so that the CLI, the WS server and the MCP
 * tools all inherit them — there is no path to the network that skips this.
 */
export async function runReplay(
  req: ReplayRequest,
  opts: { timeoutMs?: number } = {},
): Promise<Capture> {
  assertReplayAllowed(req);
  replayBudget.take();
  return withReplaySlot(() => issue(req, opts));
}

async function issue(
  req: ReplayRequest,
  opts: { timeoutMs?: number } = {},
): Promise<Capture> {
  const { host, path } = splitUrl(req.url);
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // A replay must never hang the CLI/daemon: abort the fetch on a hard deadline.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: sendableHeaders(req.headers),
      body: req.body,
      signal: ctrl.signal,
    });
  } catch (err) {
    const msg = ctrl.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`replay request failed: ${redactText(msg)}`);
  } finally {
    clearTimeout(timer);
  }
  const durationMs = Date.now() - startedAt;

  const resHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    resHeaders[key] = value;
  });

  let resBodyRaw: string | null = null;
  try {
    resBodyRaw = await res.text();
  } catch {
    resBodyRaw = null;
  }

  return {
    id: newId('cap'),
    ts: startedAt,
    source: 'replay',
    adapterId: null,
    method: req.method,
    url: redactUrl(req.url),
    host,
    path,
    status: res.status,
    durationMs,
    reqHeaders: redactHeaders(req.headers),
    reqBody: req.body == null ? null : redactText(req.body),
    resHeaders: redactHeaders(resHeaders),
    resBody: resBodyRaw == null ? null : redactText(cap(resBodyRaw)),
    pid: null,
    processName: null,
  };
}

function cap(s: string): string {
  return s.length > MAX_BODY
    ? `${s.slice(0, MAX_BODY)}…[truncated ${s.length - MAX_BODY} chars]`
    : s;
}
