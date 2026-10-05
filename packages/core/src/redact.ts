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
import { errorMessage } from './util.js';

/** Header names whose values are always masked (compared case-insensitively). */
const SECRET_HEADER_EXACT = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);

/**
 * Header names that look credential-shaped even when not in the exact set:
 * `x-api-key`, `x-access-key`, `x-amz-security-token`, `x-jwt`, `x-sid`, … A name
 * ENDING in `token`, `secret` or `password` matches without a delimiter too
 * (`X-CSRFToken`, `x-authtoken`, `x-accesstoken`). Benign names (`content-type`,
 * `x-tokenizer`, `x-sidebar`, `x-goog-authuser`, `Refresh`) survive.
 */
const SECRET_HEADER_NAME =
  /(?:(?:^|[-_])(?:api[-_]?key|access[-_]?key|auth(?:orization|enticat(?:e|ion))?|session(?:[-_]?id)?|signature|csrf|xsrf|credential|jwt|bearer|sid)|token|secret|passw(?:or)?d)(?:$|[-_])/i;

export const MASK = '«redacted»';

/**
 * What may sit right before a value-shaped secret: the start of the text, a
 * character that cannot be part of a token, or a percent-escape (`%22eyJ…`,
 * `%3Dya29.…` in an encoded URL). Requiring a run boundary also keeps every
 * shape linear — a match can begin once per run, never at each character.
 */
const BOUNDARY = '(?:^|[^A-Za-z0-9_-]|%[0-9A-Fa-f]{2})';

/**
 * A secret recognised by its SHAPE, whatever field (or no field) holds it. The
 * literal `prefix` comes first and the boundary is checked behind it, so the
 * regex engine can scan for the literal instead of testing every position.
 */
function valueShape(prefix: string, rest: string): RegExp {
  return new RegExp(`${prefix}(?<=${BOUNDARY}${prefix})${rest}`, 'g');
}

/** A PEM private-key tag line's tail, raw or URL/form-encoded (`%20`, `+`). */
const PEM_TAG = String.raw`(?:[A-Z0-9 +]|%20){0,40}PRIVATE(?: |%20|\+)KEY(?:(?: |%20|\+)BLOCK)?-----`;

/**
 * Generic value patterns masked anywhere in text (bodies, logs, errors, URLs).
 * Each starts on a literal and stays linear; each is long or prefixed enough
 * that ordinary words never match.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, // an Authorization: Bearer … value echoed into a body/log
  /(?:\b|(?<=%[0-9A-Fa-f]{2}))Bearer(?:%20|\+)[A-Za-z0-9._~/=%-]{8,}/g, // …and URL/form-encoded
  // PEM private keys, whole block, however it is escaped (JSON at any depth,
  // `<br>`, URL-encoded). The END search stops at the next BEGIN, so each
  // character is scanned for at most one block and dense BEGIN markers stay
  // linear. A block cut off before its END line is masked from BEGIN on.
  new RegExp(
    String.raw`-----BEGIN${PEM_TAG}(?:(?:(?!-----BEGIN)[\s\S]){0,16384}?-----END${PEM_TAG}|(?:[A-Za-z0-9+/=\s:,.-]|\\+[nrt/]|%[0-9A-Fa-f]{2}){0,16384})`,
    'g',
  ),
  // JWT / JWS: base64url JSON header (`eyJ` = `{"`) plus two more segments.
  valueShape('eyJ', String.raw`[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,16384}\.[A-Za-z0-9_-]{8,8192}`),
  // Anthropic API keys and OAuth tokens (sk-ant-api03-…, sk-ant-oat01-…).
  valueShape('sk-ant-', String.raw`[a-z]{2,8}\d{0,3}-[A-Za-z0-9_-]{16,512}`),
  // OpenAI project / service-account / admin / `None` keys, and the legacy sk-<48>.
  valueShape('sk-(?:proj|svcacct|admin|None)-', '[A-Za-z0-9_-]{16,512}'),
  valueShape('sk-', '[A-Za-z0-9]{32,512}'),
  // Stripe secret and restricted keys.
  valueShape('[rs]k_(?:live|test)_', '[A-Za-z0-9]{16,256}'),
  // Google OAuth access tokens, OAuth refresh tokens (also once or twice URL-encoded) and API keys.
  valueShape(String.raw`ya29\.`, '[A-Za-z0-9_-]{16,4096}'),
  valueShape('1(?://|%2[Ff]%2[Ff]|%252[Ff]%252[Ff])0', '[A-Za-z0-9_-]{30,1024}'),
  valueShape('AIza', '[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])'),
  // AWS access key ids (long-term AKIA…, temporary ASIA…).
  valueShape('(?:AKIA|ASIA)', '[A-Z0-9]{16}(?![A-Za-z0-9])'),
  // GitHub personal/OAuth/user/server/refresh tokens and fine-grained PATs.
  valueShape('gh[opsur]_', '[A-Za-z0-9]{36,255}'),
  valueShape('github_pat_', '[A-Za-z0-9_]{22,255}'),
  // Slack tokens — here as well as in app-slack's contribution, so they stay
  // masked in any process or path that has not registered the app policies —
  // and Slack app-level tokens (xapp-1-…).
  /xox[abcdeprs]-[A-Za-z0-9%+/=._-]{8,4096}/g,
  valueShape('xapp-', String.raw`\d-[A-Za-z0-9-]{16,4096}`),
];

/**
 * A credential HEADER echoed into a body, log line or error (a telemetry
 * `"headers":{"cookie":"a=1; SID=…"}`, `Authorization: Basic …`). Its value
 * holds spaces and `;`, where a field value stops, so the WHOLE value is masked,
 * up to a quote, `,`, `}`, a line end or a backslash run closing an escaped
 * string (so JSON at any depth stays parseable). The name must be a whole
 * word (an escaped `\r\n` may precede it): `withCredentials`, `acceptCookie`
 * and `cookie_consent` never match.
 */
const HEADER_ECHO =
  /((?:(?<![A-Za-z0-9_-])|(?<=\\[rn]))(?:(?:proxy-)?authorization|(?:set-)?cookie)(?:\\*"\s*:\s*(?:\[\s*)?\\*"|[ \t]*:[ \t]*(?:\\*["'])?))(?!\s)((?:[^"\\\r\n,}]|\\+(?![rn"\\]))+)/gi;

/**
 * The credential word a field NAME ends in. Any prefix may come before it —
 * `id_token`, `oauth_token`, `authToken`, `sm_access_token`, `x-csrf-token`,
 * `aws_secret_access_key` — so it is not anchored on `\b` (which sits nowhere
 * inside `id_token`); only its END must be the end of the name. The prefix is
 * left outside the match, so only the value is ever replaced.
 *
 * Pagination cursors (`nextPageToken`, `page_token`, `nextToken`, `syncToken`,
 * `paginationToken`, …) are NOT secrets, and masking them would stop captures
 * from paginating, so they are excluded. `code`, `sig` and bare `key` are too
 * generic as field names; they are masked only as query-shaped params
 * (`?code=`, `&sig=`, …) wherever those appear (`URL_SECRET_PARAM`).
 * Non-capturing groups only — the rules below number their own groups.
 */
const FIELD_NAME_END =
  '(?:(?<!(?:page|pagination|next|prev|previous|sync|continuation|cursor|resume)[_-]?)token|secret|password|passwd|passphrase|api[_-]?key|private[_-]?key|secret[_-]?(?:access[_-]?)?key|client[_-]?assertion|session[_-]?id|(?:oauth|code)[_-]?verifier|saml[_-]?(?:response|art)|csrf|xsrf|jwt)(?![A-Za-z0-9_-])';

/**
 * A bare (unquoted) field value — form, YAML, log: stops at a quote, `&`,
 * whitespace, `,` or `}`, and before a backslash-escaped quote.
 */
const FIELD_VALUE = String.raw`(?:[^"'&\s,}\\]|\\(?!["']))`;

/** An opening or closing quote: bare, backslash-escaped at any JSON depth, or `%22`. */
const QUOTE = String.raw`(?:\\*["']|%22)`;

/**
 * The value after a credential name; the branch is picked by the quote (seen
 * through a lookbehind) that opened it, so no branch can overlap another.
 */
const SECRET_FIELD_VALUE = [
  // Opened by an unescaped quote: run to the matching one. Escape pairs are
  // consumed as units, so spaces, `,`, `}`, the other quote and `\"` inside the
  // value are masked too — and a value ending in `\\` keeps the JSON valid.
  String.raw`(?<=(?<!\\)")(?:[^"\\\r\n]|\\.)+`,
  String.raw`(?<=(?<!\\)')(?:[^'\\\r\n]|\\.)+`,
  // Opened by an escaped quote (escaped JSON, any depth): stop before the
  // backslash run that closes it, so the closing escape stays whole.
  String.raw`(?<=\\")(?:[^"\\\r\n]|\\+(?![\\"]))+`,
  String.raw`(?<=\\')(?:[^'\\\r\n]|\\+(?![\\']))+`,
  // Bare or `%22`-opened: 4+ chars, and never a lone JSON literal, so
  // `{"hasPassword":true,"id_token":null}` stays parseable.
  `(?!(?:true|false|null)(?!${FIELD_VALUE}))${FIELD_VALUE}{4,}`,
].join('|');

/**
 * Credential-bearing fields (token=…, "password":"…", api_key: …, and the
 * escaped-JSON / percent-encoded separators) → mask the value. Each optional
 * quote is folded into one group with its whitespace, so no two `\s*` are
 * adjacent and a whitespace run cannot backtrack quadratically.
 */
const SECRET_FIELD = new RegExp(
  String.raw`(${FIELD_NAME_END}\s*(?:${QUOTE}\s*)?(?:[:=]|%3A|%3D)\s*${QUOTE}?)(${SECRET_FIELD_VALUE})`,
  'gi',
);

/**
 * A multipart/form-data part whose name is credential-shaped. Its value sits on
 * its own line after the part headers, where the `name=value` rule cannot see
 * it: `Content-Disposition: form-data; name="token"` CRLF CRLF `<value>`.
 */
const MULTIPART_SECRET_PART = new RegExp(
  String.raw`(content-disposition:\s*form-data;[^\r\n]{0,128}?\bname=(["']?)[A-Za-z0-9_-]{0,64}?${FIELD_NAME_END}\2[^\r\n]{0,256}\r?\n(?:[^\r\n]{1,512}\r?\n){0,8}\r?\n)([^\r\n]{1,16384})`,
  'gi',
);

/**
 * Query / fragment params that carry a secret but are too generic as field
 * names: an OAuth callback `code`, signed-URL signatures and credentials (`sig`,
 * `X-Amz-Signature`, `X-Goog-Credential`, …) and `session`. Masked wherever a
 * query-shaped `[?&#;]name=` appears — URLs, `Location`/`Referer` values,
 * bodies, classifications. Only values of 8+ characters, so `?code=US` style
 * lookups survive; the value stops before `<>` and an escaped quote, so a
 * `Link` header and escaped JSON keep their shape.
 */
const URL_SECRET_PARAM =
  /([?&#;](?:code|sig|signature|session|x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential)=)((?:[^&#\s"'<>\\]|\\(?!["'])){8,})/gi;

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
   * Extra secret-value patterns masked in any text. They are used with
   * `String.replace` and must match every occurrence, so the `g` flag is applied
   * (and any `y` flag removed) automatically at registration.
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
 * `String.replace` masks only the FIRST match of a non-global regex, and a sticky
 * one only at lastIndex — so every app pattern is normalised to global, non-sticky.
 * Never mutates the caller's RegExp. Can only ever mask more.
 */
function everyMatch(p: RegExp): RegExp {
  const flags = p.flags.replace('y', '');
  const global = flags.includes('g') ? flags : `${flags}g`;
  return global === p.flags ? p : new RegExp(p.source, global);
}

/**
 * Register the redaction contributions of every installed app. Called once at
 * startup by `@sluice/apps` so that any process which can capture traffic has
 * the full policy loaded before the first byte arrives.
 */
export function registerAppRedaction(sources: { redaction?: AppRedaction }[]): void {
  for (const { redaction } of sources) {
    if (!redaction) continue;
    for (const h of redaction.headers ?? []) extraHeaders.add(h.toLowerCase());
    for (const p of redaction.patterns ?? []) extraPatterns.push(everyMatch(p));
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
  return SECRET_HEADER_EXACT.has(lower) || extraHeaders.has(lower) || SECRET_HEADER_NAME.test(lower);
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
  const keepPrefix = (_m: string, prefix: string): string => `${prefix}${MASK}`;
  out = out.replace(HEADER_ECHO, keepPrefix);
  out = out.replace(MULTIPART_SECRET_PART, keepPrefix);
  out = out.replace(SECRET_FIELD, keepPrefix);
  return out.replace(URL_SECRET_PARAM, keepPrefix);
}

/**
 * Redact a request URL (or a bare path with a query) with `redactText`, except
 * on hosts where an app has declared some query params public — there, those
 * params keep their values so the captured URL still reproduces the request,
 * while every other param is masked exactly as before.
 *
 * Hosts with no declared public params take the text path unchanged, so this can
 * only ever *preserve* more on hosts an app has explicitly vouched for.
 *
 * Not covered: userinfo (`https://user:pass@host`), which browsers strip anyway.
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
    // Reuse the generic rules by probing "?k=v": if they would mask it, mask it.
    // URLSearchParams percent-encodes MASK here (`%C2%ABredacted%C2%BB`).
    const probe = `?${k}=${v}`;
    rebuilt.append(k, redactText(probe) === probe ? v : MASK);
  }

  // The path and host can still carry a secret, so run the text rules over the
  // param- and fragment-free URL, re-attach the query we just decided on, then
  // the fragment — which comes after the query and still passes the text rules.
  const hash = u.hash;
  u.search = '';
  u.hash = '';
  const base = redactText(u.toString());
  const query = rebuilt.toString();
  return `${base}${query ? `?${query}` : ''}${redactText(hash)}`;
}

/**
 * The URL-like fields of a capture — `url`, `path` (which some ingest paths fill
 * with `pathname?query`), the page's `tabUrl`, and the `classification` derived
 * from the path — redacted for any sink. The engines redact `url` already; this
 * covers the rest, and is idempotent on values that were masked before.
 */
export function redactCaptureUrls<
  T extends { url: string; path: string; tabUrl?: string | null; classification?: string | null },
>(c: T): T {
  return {
    ...c,
    url: redactUrl(c.url),
    path: redactUrl(c.path),
    ...(c.tabUrl == null ? {} : { tabUrl: redactUrl(c.tabUrl) }),
    ...(c.classification == null ? {} : { classification: redactText(c.classification) }),
  };
}

/** An error's message with credential-shaped substrings masked, for any sink. */
export function redactedErrorMessage(e: unknown): string {
  return redactText(errorMessage(e));
}

/**
 * A short, safe preview of a secret for the UI: first 6 chars + hidden count.
 * Values of 12 characters or fewer are reported as presence only — a 6-char
 * head of those would be most or all of the secret.
 */
export function previewSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 12) return '«present»';
  return `${secret.slice(0, 6)}…(+${secret.length - 6})`;
}
