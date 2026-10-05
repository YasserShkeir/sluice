// SPDX-License-Identifier: Apache-2.0
/**
 * Shared write/admin operation denylist for replay rails.
 *
 * One source of truth for interceptor runtime checks, cartographer learn/build
 * gates, and any other caller that must refuse write-shaped traffic. Patterns
 * are matched against URL path, query, body, and op names — case-insensitively,
 * except where letter case is the signal (camelCase verbs, operation names).
 *
 * Design notes:
 *   - Method alone is insufficient (Slack/Trello POST for ordinary reads).
 *   - Prefer name/token matches over "all POST to collections".
 *   - Runtime assert must stay a superset of learn/build filters.
 */

/**
 * Operation shapes that write, notify, or administer. Matched against a
 * haystack of path + body + classification — not against HTTP method.
 */
export const REPLAY_DENIED_OPERATION_PATTERNS: readonly RegExp[] = [
  // Slack-shaped RPC (POST is used for reads too, so names matter)
  /\bchat\.(post|update|delete|meMessage|scheduleMessage|command|unfurl)/i,
  /\badmin\./i,
  /\bfiles\.(upload|delete|revokePublicURL|sharedPublicURL|completeUpload|getUploadURL|remote\.(?:add|remove|update|share))/i,
  /\b(?:conversations|channels|groups|im|mpim)\.(create|invite|kick|leave|archive|unarchive|rename|setTopic|setPurpose|close|mark|join|open)/i,
  /\b(users|usergroups)\.(admin|create|update|disable|enable|set(?:Presence|Photo|Active)|deletePhoto|profile\.set|prefs\.set)/i,
  /\breactions\.(add|remove)/i,
  /\b(pins|stars|bookmarks)\.(add|remove)/i,
  /\b(reminders|drafts|dnd|calls)\.(add|complete|create|update|edit|delete|set|end)/i,
  /\bviews\.(open|publish|push|update)/i,
  /\b(oauth|auth)\.(revoke|token|access)/i,
  // Cross-app write tokens (prefix-friendly for classify / path segments)
  /(?:^|[./_-])(messages\.send|mail\.send|cards?\.create|cards?\.update|boards?\.create)(?:$|[./_?&#-])/i,
  // Notion's write RPCs (every Notion call is a POST, reads included).
  /\b(?:saveTransactions|submitTransaction|enqueueTask)/i,
  // Read receipts are writes: markAsRead, markAllRead, markAssociatedNotificationsRead,
  // mark_as_read, markAsViewed, markSeen. Case-sensitive so `bookmarkReader` stays a name.
  /(?<![A-Za-z])[mM]ark(?:[A-Z][A-Za-z]{0,40}|[_-](?:[a-z]+[_-]){0,2})?(?:[Rr]ead|[Ss]een|[Vv]iewed)(?![a-z])/,
  // Trello comment create (reads go through /actions?filter=commentCard).
  /\/actions\/comments(?:[/?#]|$)/i,
  // Rest.li (LinkedIn) actions: `?action=createMessage` and friends are always writes.
  /[?&]action=(?:create|update|delete|send|remove|add|accept|decline|follow|unfollow|react|mark|dismiss|withdraw|share|upload|invite|block|report|save|edit)/i,
  // GraphQL write ops (body or query= form field), also after a JSON escape
  // (`"\nmutation …"`) or a percent-escape (`query=%0Amutation`).
  /(?:\b|(?<=\\[nrtfb])|(?<=%[0-9A-Fa-f]{2}))mutation\b/i,
  // Persisted GraphQL queries carry no `mutation` text, only an operation name,
  // so a write verb leading the name is the tell (CreateComment, updateFolder).
  /operationName\\?["']?\s*[:=]\s*\\?["']?(?:[Cc]reate|[Uu]pdate|[Dd]elete|[Rr]emove|[Aa]dd|[Ss]et|[Ss]end|[Aa]rchive|[Mm]ove|[Rr]ename|[Uu]psert|[Ii]nsert|[Ee]dit|[Ss]ave|[Ss]ubmit|[Mm]ark|[Ii]nvite|[Tt]oggle|[Pp]ublish|[Ss]hare|[Uu]pload|[Rr]eact|[Ff]ollow|[Uu]nfollow|[Tt]ransfer)[A-Z_]/,
];

/**
 * Path segments where an unsafe method spends money or changes an order.
 *
 * These deliberately do NOT live in the list above, because that list is matched
 * without a method and these paths are ambiguous without one:
 * `GET /api/live-activity/data/orders` reads the user's orders, while
 * `POST /api/orders` places one. Name matching alone cannot separate them, and
 * refusing the read would be wrong.
 *
 * The case that motivated this is real: Toters' iOS app places an order with a
 * plain `POST /api/orders`, which is shaped exactly like the POST-for-read that
 * Slack and Trello rely on — so neither the method check nor the name patterns
 * above would have stopped a replay of it.
 */
const COMMERCE_WRITE_PATHS =
  /\/(?:place[-_]?)?(orders?|checkout|carts?(?:[-_]items?)?|payments?|payment[-_]methods?|charges?|subscriptions?|refunds?|tips?)(?:\.[A-Za-z]{2,5})?(?:\/|$|\?)/i;

/**
 * Bare Trello collections: an unsafe method on one creates (`POST /1/cards`).
 * Trello reads are all GET, and these paths are method-disambiguated like the
 * commerce ones above.
 */
const COLLECTION_CREATE_PATHS = /\/1\/(?:cards|boards|lists|checklists|labels|webhooks|organizations)\/?(?:\?|$)/i;

/** Methods that are never safe on a commerce path. GET/HEAD read; the rest write. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * True when any haystack matches a denied operation name (whatever the method),
 * or — for an unsafe method — a commerce or collection-create path.
 */
export function looksLikeDeniedWrite(
  method: string | undefined,
  ...haystacks: Array<string | undefined | null>
): boolean {
  const unsafe = !SAFE_METHODS.has((method ?? 'GET').toUpperCase());
  for (const raw of haystacks) {
    if (!raw) continue;
    if (REPLAY_DENIED_OPERATION_PATTERNS.some((re) => re.test(raw))) return true;
    if (unsafe && (COMMERCE_WRITE_PATHS.test(raw) || COLLECTION_CREATE_PATHS.test(raw))) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Whole-request rails — one source for the runtime assert and the flow build gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HTTP verbs a replay may use. GET/HEAD read; POST is allowed because Slack,
 * Notion, Loom and Gmail read over POST — the operation denylist is what screens
 * it. Module-private on purpose: an exported Set is mutable by any importer.
 */
const REPLAY_ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST']);

/** True when a replay may use this HTTP method (case-insensitive). */
export function isReplayMethodAllowed(method: string): boolean {
  return REPLAY_ALLOWED_METHODS.has(method.toUpperCase());
}

/**
 * The host rail: true when `host` equals one of `allowed` or is a subdomain of
 * one. Entries are trimmed and lowercased, a leading `*.` is stripped, and
 * empty entries are skipped; an empty `host` or list allows nothing. The single
 * matcher for the runtime replay assert and the flow build gate.
 */
export function replayHostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.trim().toLowerCase();
  if (!h) return false;
  for (const raw of allowed) {
    const a = raw.trim().toLowerCase().replace(/^\*\./, '');
    if (a && (h === a || h.endsWith(`.${a}`))) return true;
  }
  return false;
}

/**
 * Haystack for the operation denylist: `pathname?query` (plus the lowercase
 * hostname), or the raw string when it is not a parseable URL.
 */
export function replayRequestProbe(url: string): { probe: string; host: string } {
  try {
    const u = new URL(url);
    return { probe: `${u.pathname}?${u.searchParams.toString()}`, host: u.hostname.toLowerCase() };
  } catch {
    return { probe: url, host: '' };
  }
}

/**
 * Decode ASCII percent-escapes (`%2E` → `.`, `%73` → `s`), up to three layers.
 * Total by construction — it never throws on a malformed escape — and it only
 * touches the byte range every pattern above is written in, which is all an
 * escape can hide from them: `/api/chat%2EpostMessage` must still read as
 * `chat.postMessage`.
 */
function decodeAsciiEscapes(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(/%([0-7][0-9A-Fa-f])/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Headers that ask a server to treat the request as another method. */
const METHOD_OVERRIDE_HEADERS = new Set(['x-http-method-override', 'x-http-method', 'x-method-override']);

/** `_method=DELETE` (Rails/Laravel form override), in a query, form or JSON body. */
const METHOD_OVERRIDE_FIELD = /(?<![A-Za-z0-9_])_method\\?["']?\s*[:=]\s*\\?["']?([A-Za-z]*)/gi;

/** An override is harmless only when it names a read. */
function isReadOverride(value: string): boolean {
  const v = value.trim().toUpperCase();
  return v === 'GET' || v === 'HEAD';
}

/** True when the request asks the server to swap its method for a non-read one. */
function hasMethodOverride(headers: Record<string, string> | undefined, haystacks: string[]): boolean {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (METHOD_OVERRIDE_HEADERS.has(k.toLowerCase()) && !isReadOverride(String(v))) return true;
  }
  for (const h of haystacks) {
    for (const m of h.matchAll(METHOD_OVERRIDE_FIELD)) {
      if (!isReadOverride(m[1] ?? '')) return true;
    }
  }
  return false;
}

/**
 * The operation rail for one outgoing replay request — the check the runtime
 * assert and the flow build gate both run, so they cannot drift. True (refuse)
 * when the request:
 *   - asks for a method override to anything but GET/HEAD (headers
 *     `X-HTTP-Method-Override` / `X-HTTP-Method` / `X-Method-Override`, or a
 *     `_method` field in the query or body) — the override would otherwise
 *     turn an allowed POST into a DELETE the method check never saw;
 *   - or matches {@link looksLikeDeniedWrite} on its `pathname?query` probe,
 *     its body or any `extra` haystack (an operation / classification name),
 *     either as sent or with ASCII percent-escapes decoded.
 *
 * The method allowlist ({@link isReplayMethodAllowed}) and any host rail are
 * separate checks with their own denial codes. Like every rule here this is a
 * heuristic denylist, not a proof that an allowed request does not mutate.
 */
export function looksLikeDeniedReplay(
  req: { method?: string; url: string; headers?: Record<string, string>; body?: string | null },
  ...extra: Array<string | undefined | null>
): boolean {
  const { probe } = replayRequestProbe(req.url);
  const raw = [probe, req.body, ...extra].filter((h): h is string => typeof h === 'string' && h.length > 0);
  const decoded = raw.map(decodeAsciiEscapes).filter((d, i) => d !== raw[i]);
  const haystacks = [...raw, ...decoded];
  if (hasMethodOverride(req.headers, haystacks)) return true;
  return looksLikeDeniedWrite(req.method || 'GET', ...haystacks);
}
