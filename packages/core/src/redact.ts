// SPDX-License-Identifier: Apache-2.0
/**
 * The central secret-redactor. Every sink (SQLite ingest, logs, WS, errors)
 * passes header maps / bodies / URLs through here BEFORE the bytes leave the
 * capture path. One stray `console.log(headers)` with a live session credential
 * is a full account compromise, so this is deliberately aggressive.
 *
 * Two layers:
 *   1. A generic, app-agnostic policy (below) that knows nothing about any service.
 *   2. Per-app contributions registered at startup via `registerAppRedaction`.
 *      Apps know their own token shapes (Slack's `xoxc-`/`xoxd-`) far better than
 *      a generic regex can, and they also know which of their query params are
 *      PUBLIC and must survive redaction to keep captures replayable.
 *
 * Redaction runs BEFORE a capture is attributed to an adapter, so the registered
 * contributions are applied as one union to all traffic rather than per-app.
 */

/** Header names whose values are always masked (compared case-insensitively). */
const SECRET_HEADER_EXACT = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);

export const MASK = '«redacted»';

/** Generic value patterns masked anywhere in text (bodies, logs, errors). */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // an Authorization: Bearer … value echoed into a body/log
];

/** Credential-bearing fields (token=…, password:…, api_key=…) → mask the value. */
const SECRET_FIELD =
  /(\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|token|password|passwd|secret)\b\s*["']?\s*[:=]\s*["']?)([^"'&\s,}]{4,})/gi;

// ─────────────────────────────────────────────────────────────────────────────
// Per-app contributions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one app contributes to the redaction policy. Everything is optional; an
 * app that has no service-specific secrets needs none of it.
 */
export interface AppRedaction {
  /** Extra header names always masked, on top of the generic set. */
  headers?: string[];
  /**
   * Extra secret-value patterns masked in any text. Give these the `g` flag —
   * they are used with `String.replace` and must match every occurrence.
   */
  patterns?: RegExp[];
  /**
   * Query params that are PUBLIC on the listed hosts and must NOT be masked.
   * The generic field rule masks any `token=…`, which destroys non-secret values
   * like fast.com's speedtest token and makes the capture unreplayable. Hosts
   * match exactly or as a suffix (`fast.com` also matches `api.fast.com`).
   */
  publicParams?: { hosts: string[]; params: string[] }[];
}

const extraHeaders = new Set<string>();
const extraPatterns: RegExp[] = [];
const publicParamRules: { hosts: string[]; params: Set<string> }[] = [];

/**
 * Register the redaction contributions of every installed app. Called once at
 * startup by `@sluice/apps` so that any process which can capture traffic has
 * the full policy loaded before the first byte arrives.
 */
export function registerAppRedaction(sources: { redaction?: AppRedaction }[]): void {
  for (const { redaction } of sources) {
    if (!redaction) continue;
    for (const h of redaction.headers ?? []) extraHeaders.add(h.toLowerCase());
    for (const p of redaction.patterns ?? []) extraPatterns.push(p);
    for (const rule of redaction.publicParams ?? []) {
      publicParamRules.push({
        hosts: rule.hosts.map((h) => h.toLowerCase()),
        params: new Set(rule.params.map((p) => p.toLowerCase())),
      });
    }
  }
}

/** Test seam: drop every registered contribution. */
export function resetAppRedaction(): void {
  extraHeaders.clear();
  extraPatterns.length = 0;
  publicParamRules.length = 0;
}

function isSecretHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_HEADER_EXACT.has(lower) || extraHeaders.has(lower);
}

/** The union of params declared public for this host by any installed app. */
function publicParamsFor(hostname: string): Set<string> {
  const out = new Set<string>();
  for (const rule of publicParamRules) {
    const hit = rule.hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
    if (!hit) continue;
    for (const p of rule.params) out.add(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The sinks
// ─────────────────────────────────────────────────────────────────────────────

/** Return a copy of the header map with secret values masked. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isSecretHeader(k) ? MASK : redactText(v);
  }
  return out;
}

/** Mask credential-shaped substrings in arbitrary text (bodies, log lines, errors). */
export function redactText(text: string | null | undefined): string {
  if (!text) return text ?? '';
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, MASK);
  for (const re of extraPatterns) out = out.replace(re, MASK);
  out = out.replace(SECRET_FIELD, (_m, prefix: string) => `${prefix}${MASK}`);
  return out;
}

/**
 * Redact a request URL. Identical to `redactText` except on hosts where an app
 * has declared some query params public — there, those params keep their values
 * so the captured URL still reproduces the request, while every other param is
 * masked exactly as before.
 *
 * Hosts with no declared public params take the original code path unchanged, so
 * this can only ever *preserve* more on hosts an app has explicitly vouched for.
 */
export function redactUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl) return rawUrl ?? '';
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return redactText(rawUrl);
  }

  const publicHere = publicParamsFor(u.hostname.toLowerCase());
  if (publicHere.size === 0) return redactText(rawUrl);

  const params = [...u.searchParams.entries()];
  const rebuilt = new URLSearchParams();
  for (const [k, v] of params) {
    if (publicHere.has(k.toLowerCase())) {
      rebuilt.append(k, v);
      continue;
    }
    // Reuse the generic field rules by probing "k=v": if they would mask it, mask it.
    const probe = `${k}=${v}`;
    rebuilt.append(k, redactText(probe) === probe ? v : MASK);
  }

  // The path and host can still carry a secret, so run the text rules over the
  // param-free URL and re-attach the query we just decided on.
  u.search = '';
  const base = redactText(u.toString());
  const query = rebuilt.toString();
  return query ? `${base}?${query}` : base;
}

/** A short, safe preview of a secret for the UI: first 6 chars + hidden count. */
export function previewSecret(secret: string): string {
  if (!secret) return '';
  const head = secret.slice(0, 6);
  const hidden = Math.max(0, secret.length - 6);
  return `${head}…(+${hidden})`;
}
