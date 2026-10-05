// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Faithful request masking — make a replay look like the real client.
 *
 * From the captured REAL requests (source mitm/cdp) for an endpoint we learn the
 * client's actual request fingerprint: its header set (user-agent, x-… version
 * headers) and its non-secret form params (the `_x_csid` / `_x_gantry` / etc. the
 * client attaches). A replay then overlays that fingerprint onto the synthetic
 * request, swapping only the target params + re-injected credentials.
 *
 * Values the client computes fresh per request — nonces, request ids, cache
 * validators — are DETECTED rather than copied. Learning from several captures
 * and diffing them shows which keys change between otherwise-identical requests;
 * those are dropped or regenerated instead of replayed verbatim. Sending a stale
 * nonce is a stronger anomaly signal than sending none, and can trip a service's
 * idempotency/dedupe checks in ways that look like Sluice bugs.
 *
 * Honest limits, measured rather than assumed:
 *   - Secret values were redacted at capture (we re-inject the live session's
 *     own), and a value whose derivation we cannot observe — an HMAC over the
 *     payload, say — cannot be reproduced from outside.
 *   - The replay goes out through Node's `fetch` (undici), which appends two
 *     headers of its own that no masking here can remove. `accept-encoding` it
 *     forces to `gzip, deflate` unless we set one — so we DO set the real
 *     captured value, capped to codecs undici can decode (see
 *     {@link capAcceptEncoding}); it still omits `zstd`, which current Chrome
 *     sends, because a response we cannot decode is a corrupted capture. And
 *     `sec-fetch-mode` undici overwrites to `cors` outright — verified by
 *     echo-server test — so a request whose real value was `same-origin` goes
 *     out as `cors`. That one is a residual tell we cannot correct from here.
 *
 * This raises fidelity on your own account's reads by reconstructing the
 * request the way the real client did, within what Node's fetch can emit.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { decodeBody, headerValue, MASK, safeJsonObject, splitUrl } from '@sluice/core';
import type { ReplayRequest, SqliteStore } from '@sluice/core';

/** How many recent captures to diff when learning. More = better variance signal. */
const SAMPLE_SIZE = 8;

export interface RequestTemplate {
  /** the real client's headers, minus redacted/hop-by-hop/per-request ones */
  headers: Record<string, string>;
  /** the real client's stable non-secret form params (e.g. `_x_*`) */
  bodyParams: Record<string, string>;
  /**
   * Body params observed taking a different value across captures of the same
   * endpoint — i.e. computed per request. Kept so callers can see what was
   * deliberately dropped rather than silently omitted.
   */
  volatileParams: string[];
}

const SKIP_HEADERS = new Set([
  // Recomputed by the HTTP client, or hop-by-hop.
  'content-length',
  'host',
  'connection',
  // NOT accept-encoding: undici's own default is anomalous; it is learned and capped (capAcceptEncoding).
  // Per-request by definition — replaying a stale value is worse than omitting it.
  'date',
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-range',
  'range',
  'traceparent',
  'tracestate',
  'b3',
  'x-request-id',
  'x-correlation-id',
  'x-amzn-trace-id',
  // Never learned: a method override would turn an allowed POST into another
  // verb, and auth is always the live session's (it is redacted at capture too).
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
  'cookie',
  'authorization',
]);

/** Headers whose NAME matches a per-request shape (x-…-request-id, …-nonce, …). */
const VOLATILE_HEADER_RE = /(^|-)(request-id|correlation-id|nonce|trace|span|timestamp)(-|$)/i;

function isSkippableHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SKIP_HEADERS.has(lower) || VOLATILE_HEADER_RE.test(lower);
}

/** Shapes we can regenerate convincingly when a param is known to vary. */
function regenerate(sample: string): string | undefined {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sample)) {
    return randomUUID();
  }
  if (/^\d{13}$/.test(sample)) return String(Date.now()); // epoch ms
  if (/^\d{10}$/.test(sample)) return String(Math.floor(Date.now() / 1000)); // epoch s
  if (/^[0-9a-f]{16,}$/i.test(sample)) {
    return randomBytes(sample.length).toString('hex').slice(0, sample.length); // same-length lowercase hex
  }
  return undefined; // unknown shape → safer to drop than to invent
}

interface SampleRow {
  reqHeaders: string;
  /**
   * Raw column value: a string when stored plain, a Buffer when
   * `reqBodyEncoding` says gzip. Always run it through `decodeBody` — this query
   * reads the table directly and so does not get `rowToCapture`'s decoding.
   */
  reqBody: string | Buffer | null;
  reqBodyEncoding: string | null;
}

function parseHeaders(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(safeJsonObject(json) ?? {})) if (typeof v === 'string') out[k] = v;
  return out;
}

/**
 * Whether a body is a urlencoded form, the only shape whose params are learned
 * and merged. JSON (object or array) never is, and a declared content-type
 * other than urlencoded wins; a form sent without one still counts.
 */
function isFormBody(body: string, contentType: string | undefined): boolean {
  const t = body.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return false;
  return contentType === undefined || /x-www-form-urlencoded/i.test(contentType);
}

function parseFormBody(body: string | null, contentType: string | undefined): Record<string, string> | undefined {
  if (!body || !isFormBody(body, contentType)) return undefined;
  return Object.fromEntries(new URLSearchParams(body));
}

/**
 * Learn a template from the recent REAL captured requests for method+path on
 * `host` or one of its subdomains.
 *
 * The host scope is a trust boundary: MITM and CDP see every site, so method +
 * path alone (`POST /graphql`) would let any other site's captures supply the
 * headers and params sent to this one with the user's live session. Subdomains
 * count so a `slack.com` replay still learns from `acme.slack.com` captures.
 */
export function learnRequestTemplate(
  store: SqliteStore,
  method: string,
  path: string,
  host: string,
): RequestTemplate | undefined {
  if (!host) return undefined;
  const rows = store.db
    .prepare(
      `SELECT req_headers AS reqHeaders, req_body AS reqBody,
              req_body_encoding AS reqBodyEncoding
         FROM captures
        WHERE method = @method AND path = @path AND source IN ('mitm', 'cdp')
          AND (host = @host OR substr(host, -length(@host) - 1) = '.' || @host)
        ORDER BY ts DESC
        LIMIT @limit`,
    )
    .all({ method, path, host: host.toLowerCase(), limit: SAMPLE_SIZE }) as SampleRow[];
  if (rows.length === 0) return undefined;

  // ── Headers: keep only those present and identical across every sample ──────
  const headerSamples = rows.map((r) => parseHeaders(r.reqHeaders));
  const first = headerSamples[0] ?? {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(first)) {
    // A masked (cookie/auth) value is re-injected live.
    if (!v.includes(MASK) && !isSkippableHeader(k) && headerSamples.every((h) => h[k] === v)) headers[k] = v;
  }

  // ── Body params: split stable from varying ─────────────────────────────────
  const bodySamples = rows
    .map((r, i) =>
      parseFormBody(decodeBody(r.reqBody, r.reqBodyEncoding), headerValue(headerSamples[i], 'content-type')),
    )
    .filter(Boolean) as Array<Record<string, string>>;
  const bodyParams: Record<string, string> = {};
  const volatileParams: string[] = [];

  for (const [k, v] of Object.entries(bodySamples[0] ?? {})) {
    if (v.includes(MASK)) continue; // the redacted token → re-injected live
    // One sample gives no variance signal, so copy it rather than guess.
    const varies = bodySamples.length > 1 && bodySamples.some((b) => b[k] !== undefined && b[k] !== v);
    if (varies) {
      volatileParams.push(k);
      const fresh = regenerate(v);
      if (fresh !== undefined) bodyParams[k] = fresh;
      // else: deliberately omitted — see the docstring.
    } else {
      bodyParams[k] = v;
    }
  }

  return { headers, bodyParams, volatileParams };
}

/**
 * Request-INVARIANT browser identity — the headers a real client sends the same
 * way on every request, whatever the endpoint. When we have LEARNED the real
 * value from capture, it beats the base's, because the base's is an adapter's
 * hardcoded guess: Trello and Gmail both pin a static `User-Agent` that drifts
 * from the user's actual Chrome version and replaces a real fingerprint we
 * already hold with an approximation.
 *
 * Everything NOT in this set stays the base's — content-type (matches the body
 * the base built), origin, referer (the adapter computes these for the specific
 * target), and the re-injected auth. The template never carries auth anyway; it
 * is redacted at capture and filtered out during learning.
 */
const IDENTITY_HEADERS = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-wow64',
  'sec-ch-ua-form-factors',
  'dnt',
  'upgrade-insecure-requests',
  'priority',
]);

/**
 * Content encodings undici will DECODE. A learned `accept-encoding` is
 * intersected with this before it goes out — advertising `zstd` (which current
 * Chrome sends) risks a response undici cannot decode, and an undecodable body
 * is a corrupted capture. As faithful as we can be while staying readable; the
 * gap it leaves is named in the file header.
 */
const DECODABLE_ENCODINGS = ['gzip', 'deflate', 'br'];

/** Every char is a single byte — the range undici will accept in a header value. */
function isLatin1(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) > 255) return false;
  return true;
}

export function capAcceptEncoding(value: string): string | undefined {
  const kept = value
    .split(',')
    .map((s) => s.trim().split(';')[0]?.trim() ?? '')
    .filter((codec) => DECODABLE_ENCODINGS.includes(codec));
  return kept.length > 0 ? kept.join(', ') : undefined;
}

/** Overlay a learned template onto a synthetic request so it mimics the client. */
export function makeFaithful(base: ReplayRequest, tmpl: RequestTemplate): ReplayRequest {
  // Merge on LOWERCASED names. Every service here speaks HTTP/2, which sends
  // header names lowercased anyway, and normalizing removes the duplicate a
  // plain spread would leave when the base's `User-Agent` and the template's
  // `user-agent` collide only in case — two keys undici would then both emit.
  const headers = new Map<string, string>();
  for (const [k, v] of Object.entries(base.headers)) headers.set(k.toLowerCase(), v);
  for (const [k, v] of Object.entries(tmpl.headers)) {
    const lower = k.toLowerCase();
    // undici rejects a header value with a byte > 255 by THROWING out of the
    // whole fetch — so one odd captured value would fail the entire replay
    // rather than just that header. Carrying more real headers (identity +
    // accept-encoding) widens the chance of hitting one, so a non-latin1 value
    // is dropped here: a missing header degrades fidelity, a thrown replay
    // returns nothing.
    if (!isLatin1(v)) continue;
    // The base wins for everything it set EXCEPT a browser-identity header,
    // where the learned real value is strictly more faithful than its guess.
    if (headers.has(lower) && !IDENTITY_HEADERS.has(lower)) continue;
    headers.set(lower, v);
  }
  const ae = headers.get('accept-encoding');
  if (ae !== undefined) {
    const capped = capAcceptEncoding(ae);
    if (capped === undefined) headers.delete('accept-encoding');
    else headers.set('accept-encoding', capped);
  }

  let body = base.body;
  if (base.body !== undefined && isFormBody(base.body, headers.get('content-type'))) {
    const merged = new URLSearchParams();
    for (const [k, v] of Object.entries(tmpl.bodyParams)) merged.set(k, v); // client's _x_* first
    for (const [k, v] of new URLSearchParams(base.body)) merged.set(k, v); // base wins (token + targets)
    body = merged.toString();
  }
  return { method: base.method, url: base.url, headers: Object.fromEntries(headers), body };
}

/** Build a faithful request if a template exists for the endpoint, else the base unchanged. */
export function faithfulReplayRequest(store: SqliteStore, base: ReplayRequest): ReplayRequest {
  const { host, path } = splitUrl(base.url);
  const tmpl = learnRequestTemplate(store, base.method, path, host);
  return tmpl ? makeFaithful(base, tmpl) : base;
}
