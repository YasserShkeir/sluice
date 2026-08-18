// SPDX-License-Identifier: AGPL-3.0-or-later
/** Tiny display helpers — no dependencies, all pure. */

export function formatClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}


export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Humanize a raw byte count (B / KB / MB / GB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Humanize a response body's size from its decoded string length (bytes ≈ chars). */
export function humanizeBytes(body: string | null): string {
  if (body === null) return '—';
  return formatBytes(body.length);
}

/** Best-effort pretty JSON; falls back to the raw string when it isn't JSON. */
export function prettyJson(body: string | null): string {
  if (body === null || body === '') return '';
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/**
 * Render a capture as a runnable `curl` command.
 *
 * Deliberately reproduces what was CAPTURED, redaction and all. The header
 * values that matter for auth are already `«redacted»` by the time a capture
 * reaches the browser — the store has nowhere to put the real ones — so the
 * command will not authenticate as you until you substitute them yourself.
 * That is the intended behaviour: "Copy as cURL" that silently handed out a
 * working session would put a live credential on the clipboard, and from there
 * into a bug report.
 *
 * Single-quoted with the POSIX `'\''` escape, so a body containing quotes,
 * newlines or `$` cannot break out of the argument.
 */
export function toCurl(c: {
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
}): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${c.method} ${q(c.url)}`];
  for (const [k, v] of Object.entries(c.reqHeaders)) {
    // HTTP/2 pseudo-headers (:method, :authority) are part of the framing, not
    // headers curl can send; passing them through produces an invalid command.
    if (k.startsWith(':')) continue;
    parts.push(`  -H ${q(`${k}: ${v}`)}`);
  }
  if (c.reqBody !== null && c.reqBody.length > 0) parts.push(`  --data-raw ${q(c.reqBody)}`);
  return parts.join(' \\\n');
}
