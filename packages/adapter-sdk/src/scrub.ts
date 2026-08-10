// SPDX-License-Identifier: Apache-2.0
/**
 * Fixture scrubber — preserve SHAPE, replace CONTENT.
 *
 * `sluice record` produces a capture of a real, signed-in account; it does not
 * produce a fixture anyone can commit, because the recording IS that account's
 * data. Hand-editing is not an answer at 25MB, and deleting the interesting
 * fields is not an answer either: what a parser test asserts on is precisely the
 * interesting fields.
 *
 * So this replaces every value and leaves the frame around it alone. That
 * matters most for positional-array APIs — Gmail's sync endpoints carry no field
 * names at all, so a parser test there is entirely a claim about which INDEX
 * holds what TYPE at what LENGTH. Reshape any of those and the fixture stops
 * testing the parser and starts testing the scrubber.
 *
 * Preserved: array lengths, nesting depth, object keys, types, every string's
 * length, the relative order of timestamps, and the FORM of ids — a
 * `thread-f:<19 digits>` comes back as a different 19 digits.
 * Replaced: every string's characters, every timestamp's absolute value.
 * Kept verbatim: `^label` ids and redaction masks. A label id is Gmail's
 * vocabulary rather than the user's data, and a parser that routes on `^i` has
 * to still see `^i`.
 *
 * Deterministic: every synthetic value is drawn from a hash of the input, so
 * re-running the scrubber over the same recording produces a byte-identical
 * fixture and a re-scrub shows up as an empty diff.
 *
 * Never throws. It is not in the ingest funnel, but it runs over exactly the
 * malformed bodies the funnel exists to survive, and a throw here would be a
 * throw over data nobody is allowed to paste into a bug report.
 */
import { MASK } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { arr, num, obj, safeJson, str } from './coerce.js';

export interface ScrubOptions {
  /**
   * Mixed into every hash. Two fixtures scrubbed from the same mailbox with
   * different salts share no synthetic text, which is what stops a reader from
   * lining them up and learning that two captures mentioned the same person.
   */
  salt?: string;
}

// ── Determinism ──────────────────────────────────────────────────────────────

/** FNV-1a, 32-bit. Not a security hash — a stable seed that agrees across runs. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The seed for one value. The separator is a marker rather than a space so that
 * `salt='a b'` + `'c'` and `salt='a'` + `'b c'` cannot seed the same generator.
 */
const SEED_SEPARATOR = '::sluice-scrub::';

function seedOf(salt: string, value: string): number {
  return hash32(salt + SEED_SEPARATOR + value);
}

/** mulberry32. Seeded, so the same string always yields the same synthetic text. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const HEX = '0123456789abcdef';

/**
 * Lowercase words of 3–9 letters, space-separated, capitalized, exactly `len`
 * characters — never a leading or trailing space, because a parser that trims
 * would then see a different length than the one we promised to preserve.
 */
function synthText(seed: number, len: number): string {
  if (len <= 0) return '';
  const next = rng(seed);
  const wordLen = (): number => 3 + Math.floor(next() * 7);
  const chars: string[] = [];
  let run = 0;
  let target = wordLen();
  while (chars.length < len) {
    if (run === target && chars.length < len - 1) {
      chars.push(' ');
      run = 0;
      target = wordLen();
      continue;
    }
    chars.push(LOWER[Math.floor(next() * LOWER.length)] ?? 'e');
    run += 1;
  }
  const out = chars.join('');
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Digits, never leading-zero: an all-digit string is routinely an id that a
 * parser feeds through `num()`, and `0123` survives JSON but not that round-trip.
 */
function synthDigits(seed: number, len: number): string {
  if (len <= 0) return '';
  const next = rng(seed);
  const first = String(1 + Math.floor(next() * 9));
  let out = first;
  while (out.length < len) out += String(Math.floor(next() * 10));
  return out;
}

function synthHex(seed: number, len: number): string {
  const next = rng(seed);
  let out = '';
  while (out.length < len) out += HEX[Math.floor(next() * HEX.length)] ?? '0';
  return out;
}

// ── Strings ──────────────────────────────────────────────────────────────────

/**
 * `thread-f:1234…`, `msg-f:1234…` — any `<short lowercase name>:<digits>` id.
 *
 * The bound on the name is not cosmetic. An unbounded `[A-Za-z0-9_-]+:` also
 * matches Gmail's `x-framework-xsrf-token`, whose value is
 * `<34-character session token>:<epoch ms>` — so a looser rule would have
 * written a live XSRF token into the fixture verbatim while reporting that it
 * had preserved an id's form. A marker a parser routes on is short and
 * lowercase; anything longer or mixed-case is treated as a secret and replaced.
 */
const PREFIXED_ID = /^([a-z][a-z0-9_-]{0,15}:)(\d+)$/;
const ALL_DIGITS = /^\d+$/;
const ALL_HEX = /^[0-9a-f]{8,}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTP_URL = /^https?:\/\//i;

/** `.test` is reserved by RFC 6761, so a synthetic address can never resolve. */
const SYNTH_DOMAIN = '@example.test';
const SHORT_DOMAIN = '@x.test';

/**
 * One string in, one synthetic string of the same length out.
 *
 * The order of the branches is the whole contract: markers a parser routes on
 * are recognized BEFORE the string is treated as prose, so a scrubbed fixture
 * still exercises the routing. Everything unrecognized is prose.
 */
function scrubString(value: string, salt: string): string {
  if (value.length === 0) return value;
  // A mask is already the absence of data. Re-scrubbing it would hide the fact
  // that the redactor ran, and the fixture is partly there to prove it did.
  if (value === MASK) return value;
  if (value.startsWith('^')) return value;

  const seed = seedOf(salt, value);

  const prefixed = PREFIXED_ID.exec(value);
  if (prefixed) {
    const [, prefix = '', digits = ''] = prefixed;
    return `${prefix}${synthDigits(seed, digits.length)}`;
  }
  if (ALL_DIGITS.test(value)) return synthDigits(seed, value.length);
  if (ALL_HEX.test(value)) return synthHex(seed, value.length);
  // URL before email: `https://user@host.com/` satisfies the address shape too.
  if (HTTP_URL.test(value)) return scrubUrl(value, salt, false);
  if (EMAIL.test(value)) return synthEmail(seed, value.length);
  return synthText(seed, value.length);
}

/**
 * `user<n>@example.test`, padded to the original length.
 *
 * An address shorter than the synthetic domain cannot be rendered as an address
 * of the same length, so below that it degrades: first to a shorter reserved
 * domain, then to prose. Length and type are preserved in every case; only
 * "still looks like an address" is given up, and only for addresses too short
 * for any real one to be mistaken for.
 */
function synthEmail(seed: number, len: number): string {
  const next = rng(seed);
  const n = String(1 + Math.floor(next() * 9999));
  const long = `user${n}`;
  if (len >= long.length + SYNTH_DOMAIN.length) {
    return `${long.padEnd(len - SYNTH_DOMAIN.length, 'x')}${SYNTH_DOMAIN}`;
  }
  const short = `u${n}`;
  if (len >= short.length + SHORT_DOMAIN.length) {
    return `${short.padEnd(len - SHORT_DOMAIN.length, 'x')}${SHORT_DOMAIN}`;
  }
  return synthText(seed, len);
}

/**
 * scheme+authority, path, query, fragment — reassembled by concatenation rather
 * than through `URL`, which cannot be used here: `new URL('https://x.com')`
 * stringifies with a `/` appended and `URLSearchParams` percent-re-encodes every
 * value, so a nested `?u=https://…` came back 74 characters longer than it went
 * in. Both silently break the length this file exists to preserve.
 *
 * The authority is optional so that an HTTP/2 `:path` request target — a path
 * and a query with no origin in front of it — takes exactly the same road.
 */
const URL_PARTS = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/i;

/** Characters a synthetic value must not reintroduce, per position. */
const UNSAFE_IN_SEGMENT = /[\s/?#%]/g;
const UNSAFE_IN_QUERY = /[\s&=#%]/g;
const UNSAFE_IN_HOST = /[^a-z0-9-]/g;

/**
 * Query values, fragment and userinfo never survive. The HOST and the PATH both
 * depend on whose URL it is, and getting that split wrong is the one way this
 * file leaks.
 *
 * `isOwnUrl` — the capture's OWN url, or its `:path`/`tabUrl`. `mail.google.com`
 * and `/sync/u/0/i/bv` are what `matchRequest` and `classify` route on, so
 * scrambling them leaves a fixture that exercises neither. Same call as
 * `^label`: service vocabulary, not the user's data.
 *
 * `!isOwnUrl` — a URL found inside a body or a header value, where BOTH parts are
 * the user's data. The path went first: Gmail's image proxy encodes the original
 * remote image URL into `/proxy/<token>`, so keeping embedded paths wrote every
 * remote image the mailbox had loaded into the fixture, 198 characters at a time.
 * The host went second, for the same reason and found the same way — a leak check
 * over an already-scrubbed mailbox came back with a list of third-party domains
 * read straight out of the message bodies. Which companies email a person IS
 * content, and no adapter routes on an EMBEDDED host anyway.
 *
 * Shape survives in both cases: scheme, label count, label lengths, segment
 * count, segment lengths, total length. The names do not.
 */
function scrubUrl(raw: string, salt: string, isOwnUrl: boolean): string {
  const parts = URL_PARTS.exec(raw);
  if (!parts) return synthText(seedOf(salt, raw), raw.length);
  const [, authority = '', path = '', query = '', fragment = ''] = parts;
  return (
    scrubAuthority(authority, salt, isOwnUrl) +
    (isOwnUrl ? path : scrubPath(path, salt)) +
    scrubQuery(query, salt) +
    scrubFragment(fragment, salt)
  );
}

/** Anything before an `@` is a credential and always goes; the host obeys `keepHost`. */
function scrubAuthority(authority: string, salt: string, keepHost: boolean): string {
  if (authority.length === 0) return authority;
  const scheme = authority.slice(0, authority.indexOf('://') + 3);
  const rest = authority.slice(scheme.length);
  const at = rest.lastIndexOf('@');
  const host = at < 0 ? rest : rest.slice(at + 1);
  let userinfo = '';
  if (at >= 0) {
    const raw = rest.slice(0, at);
    userinfo = `${synthText(seedOf(salt, raw), raw.length)
      .replace(UNSAFE_IN_SEGMENT, '-')
      .replace(/[@:]/g, '-')}@`;
  }
  return `${scheme}${userinfo}${keepHost ? host : scrubHost(host, salt)}`;
}

/**
 * `www.example.com:443` → a same-shaped name nobody has ever registered.
 *
 * Label by label, so the label count and each label's length survive and a parser
 * that splits on `.` still sees what it saw. The port is protocol vocabulary and
 * stays: only the name in front of it is data.
 */
function scrubHost(host: string, salt: string): string {
  const colon = host.lastIndexOf(':');
  const hasPort = colon > 0 && ALL_DIGITS.test(host.slice(colon + 1));
  const name = hasPort ? host.slice(0, colon) : host;
  const port = hasPort ? host.slice(colon) : '';
  const scrubbed = name
    .split('.')
    .map((label) =>
      label.length === 0
        ? label
        : synthText(seedOf(salt, label), label.length).toLowerCase().replace(UNSAFE_IN_HOST, '-'),
    )
    .join('.');
  return `${scrubbed}${port}`;
}

function scrubPath(path: string, salt: string): string {
  return path
    .split('/')
    .map((seg) => (seg.length === 0 ? seg : scrubString(seg, salt).replace(UNSAFE_IN_SEGMENT, '-')))
    .join('/');
}

function scrubQuery(query: string, salt: string): string {
  if (query.length === 0) return query;
  const parts = query
    .slice(1)
    .split('&')
    .map((part) => {
      // A param with no `=` is a bare flag: the whole token is its NAME.
      const eq = part.indexOf('=');
      if (eq < 0) return part;
      const value = part.slice(eq + 1);
      return `${part.slice(0, eq + 1)}${scrubString(value, salt).replace(UNSAFE_IN_QUERY, '-')}`;
    });
  return `?${parts.join('&')}`;
}

function scrubFragment(fragment: string, salt: string): string {
  if (fragment.length === 0) return fragment;
  return `#${scrubString(fragment.slice(1), salt).replace(UNSAFE_IN_SEGMENT, '-')}`;
}

// ── Numbers ──────────────────────────────────────────────────────────────────

const EPOCH_MIN = 1e12;
const EPOCH_MAX = 2e12;

/**
 * ~347 days back. Constant, so every timestamp in the fixture moves together and
 * both ordering and the gaps between captures survive — which is what the mock
 * runner paces a replay from. It is large enough that a scrubbed date no longer
 * lines up with anything that happened in the real account, and small enough
 * that any plausible recording stays inside the epoch-ms window.
 */
const EPOCH_SHIFT_MS = -30_000_000_000;

/**
 * Numbers pass through: they are counts, flags, indices and enum values, and a
 * parser that branches on `kind === 2` has to still see 2. Timestamps are the
 * exception — they say when the user did something.
 */
function scrubNumber(value: number): number {
  if (!Number.isFinite(value)) return value;
  return value >= EPOCH_MIN && value <= EPOCH_MAX ? value + EPOCH_SHIFT_MS : value;
}

// ── Structure ────────────────────────────────────────────────────────────────

/**
 * Recurse, never reshape.
 *
 * Object KEYS are kept verbatim: a key is the API's field name, and a fixture
 * whose keys are scrambled cannot test a parser that reads them. The cost is
 * that a service which keys a map BY user data (an address book keyed by email)
 * is not covered here — none of the positional-array APIs this was built for do
 * that, and a map like that needs a decision about the map, not a regex.
 */
function scrubValue(value: unknown, salt: string): unknown {
  if (typeof value === 'string') return scrubString(value, salt);
  if (typeof value === 'number') return scrubNumber(value);
  if (value === null || typeof value === 'boolean') return value;

  const list = arr(value);
  if (list) return list.map((v) => scrubValue(v, salt));

  const record = obj(value);
  if (record) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = scrubValue(v, salt);
    return out;
  }
  // undefined, a function, a symbol — nothing JSON.parse can produce, and
  // nothing worth inventing a representation for.
  return null;
}

/** Google's anti-JSON-hijacking preamble: `)]}'` and the newlines after it. */
const HIJACK_PREFIX = /^\)\]\}'\s*/;

/**
 * A body in, a scrubbed body of the same kind out.
 *
 * The `)]}'` preamble is stripped, the JSON under it is scrubbed, and the exact
 * preamble text goes back on. Scrubbing it as one opaque blob instead would
 * leave a fixture that no longer exercises the prefix-stripping every Google
 * parser has to do — which is the single most likely thing for a parser to get
 * wrong and the whole reason the fixture exists.
 *
 * Anything that is not JSON — an HTML error page, a JS bundle, a truncated
 * response, a chunked stream — is scrubbed as opaque text of the same length.
 */
function scrubBody(body: unknown, salt: string): string | null {
  const text = str(body);
  if (text === undefined || text.length === 0) return text === '' ? '' : null;

  const preamble = HIJACK_PREFIX.exec(text)?.[0] ?? '';
  const json = text.slice(preamble.length);
  const parsed = safeJson(json);
  // Not JSON: an HTML error page, a JS bundle, or Gmail's length-prefixed chunk
  // stream. The preamble still goes back on — a fixture that stops exercising
  // the strip stops testing the one thing every Google parser has to get right.
  if (parsed === undefined) return `${preamble}${synthText(seedOf(salt, json), json.length)}`;
  return `${preamble}${JSON.stringify(scrubValue(parsed, salt))}`;
}

/**
 * Header values whose content is protocol vocabulary rather than anything the
 * user typed. A parser branches on `content-type`; a scrambled one silently
 * stops exercising that branch, and these pseudo-headers just restate the
 * method, scheme, host and status we already keep. `:path` is NOT among them —
 * see {@link scrubHeaders}.
 */
const VOCABULARY_HEADERS = new Set([
  ':authority',
  ':method',
  ':scheme',
  ':status',
  'accept',
  'accept-encoding',
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'transfer-encoding',
  'vary',
]);

function scrubHeaders(headers: unknown, salt: string): Record<string, string> {
  const record = obj(headers);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    const text = str(value);
    if (text === undefined) continue;
    const lower = name.toLowerCase();
    if (VOCABULARY_HEADERS.has(lower)) out[name] = text;
    // `:path` is the path AND the query string. Filed under protocol vocabulary
    // it republished every query value the capture's own `url` had just
    // scrubbed — an internal build label rode out on `checkbuild?bl=…` that way.
    else if (lower === ':path') out[name] = scrubUrl(text, salt, true);
    else out[name] = scrubString(text, salt);
  }
  return out;
}

// ── Captures ─────────────────────────────────────────────────────────────────

/**
 * Scrub a recording into something committable.
 *
 * Routing metadata — `id`, `source`, `adapterId`, `method`, `host`, `path`,
 * `status`, `durationMs`, `classification`, the tab/process/WS fields — is kept
 * verbatim. None of it is the user's data (it is the recorder's own bookkeeping
 * and the service's own URL space), and all of it is what an adapter is matched
 * and classified by, so a fixture without it tests nothing.
 */
export function scrubCaptures(captures: Capture[], opts: ScrubOptions = {}): Capture[] {
  const salt = str(obj(opts)?.salt) ?? '';
  const list = arr(captures) ?? [];
  return list.map((raw) => scrubCapture(raw, salt));
}

function scrubCapture(raw: unknown, salt: string): Capture {
  const c = obj(raw) ?? {};
  const url = str(c.url) ?? '';
  const tabUrl = str(c.tabUrl);
  const scrubbed: Capture = {
    id: str(c.id) ?? '',
    ts: scrubNumber(num(c.ts) ?? 0),
    source: (str(c.source) ?? 'import') as Capture['source'],
    adapterId: str(c.adapterId) ?? null,
    method: str(c.method) ?? 'GET',
    url: url === '' ? '' : scrubUrl(url, salt, true),
    host: str(c.host) ?? '',
    path: str(c.path) ?? '',
    status: num(c.status) ?? null,
    durationMs: num(c.durationMs) ?? null,
    reqHeaders: scrubHeaders(c.reqHeaders, salt),
    reqBody: scrubBody(c.reqBody, salt),
    resHeaders: scrubHeaders(c.resHeaders, salt),
    resBody: scrubBody(c.resBody, salt),
  };
  // Optional fields are re-attached only when the recording had them, so a
  // scrubbed fixture does not grow keys the recorder never wrote.
  if ('pid' in c) scrubbed.pid = num(c.pid) ?? null;
  if ('processName' in c) scrubbed.processName = str(c.processName) ?? null;
  if ('tabId' in c) scrubbed.tabId = str(c.tabId) ?? null;
  if ('tabUrl' in c) scrubbed.tabUrl = tabUrl === undefined ? null : scrubUrl(tabUrl, salt, true);
  if ('direction' in c) scrubbed.direction = (str(c.direction) ?? null) as Capture['direction'];
  if ('wsId' in c) scrubbed.wsId = str(c.wsId) ?? null;
  if ('classification' in c) scrubbed.classification = str(c.classification) ?? null;
  if ('parsedAt' in c) {
    const at = num(c.parsedAt);
    scrubbed.parsedAt = at === undefined ? null : scrubNumber(at);
  }
  return scrubbed;
}
