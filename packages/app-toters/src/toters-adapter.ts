// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Toters adapter — matching, classification, parsing and pagination.
 *
 * Toters is a MENA delivery service whose client is the iOS/Android app; there
 * is no desktop client and no web app worth capturing. Everything here was
 * derived from real captured traffic (`Toters/1 CFNetwork/… Darwin/…`, header
 * `app: customer`, `platform: ios`), not from documentation, because the API is
 * not public.
 *
 * ## The response envelope
 *
 * Every JSON endpoint answers `{ errors: boolean, data: { … } }`. `errors` is
 * the failure signal and it rides on an HTTP 200, the same way Slack sends
 * `{ ok: false }` — so `classify` has to read the body's own flag rather than
 * trust the status code.
 *
 * ## Why this adapter is GET-only
 *
 * `POST /api/orders` places a real, paid food order; it was in the capture set
 * because the phone that produced it actually ordered. Nothing here builds a
 * POST, and `totersReplayActions` is GET-only by construction. That is the
 * adapter's half of the rail — the other half is the shared denylist in
 * `@sluice/core` (`REPLAY_DENIED_OPERATION_PATTERNS`), which refuses the write
 * shapes regardless of which code path proposes them.
 */
import { actionUrl, arr, num, obj, safeJson, str } from '@sluice/adapter-sdk';
import type {
  Actor,
  Capture,
  CaptureClass,
  Container,
  CursorSeed,
  Item,
  ParseResult,
  ReplayAction,
  ReplayRequest,
  Session,
  Workspace,
} from '@sluice/core';

export const ADAPTER_ID = 'toters';

/**
 * One workspace per signed-in account would be ideal, but no captured response
 * carries an account-scoped container id — `user-info` names the person, not a
 * tenant. A single constant workspace is the honest representation of "one
 * consumer account on one device", and `parse` upgrades its name once
 * `user-info` has been seen.
 */
export const WORKSPACE_ID = 'toters';

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Hosts seen in real traffic. `toters-api.com` and `totersapp.com` are separate
 * registrable domains, not subdomains of one another, so both are declared.
 *
 * The leading dot on each suffix test is load-bearing: a bare
 * `endsWith('toters-api.com')` would also accept `nottoters-api.com`, which is
 * exactly the lookalike the conformance harness probes for.
 */
const TOTERS_DOMAINS = ['toters-api.com', 'totersapp.com', 'totersapi.com'];

export function matchesToters(host: string): boolean {
  const h = host.toLowerCase();
  return TOTERS_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Image CDNs. Claimed (so the traffic is attributed) but never parsed. */
function isImageHost(host: string): boolean {
  return host.toLowerCase().startsWith('images.');
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * `{ errors: true }` on an HTTP 200. Reading the flag costs a JSON parse, so it
 * is only attempted on a body small enough to be an error envelope — a 2 MB
 * store listing is never one, and parsing it here would double the ingest cost
 * of the largest responses in the store.
 */
const ERROR_ENVELOPE_MAX = 4096;

function hasErrorFlag(capture: Capture): boolean {
  const body = capture.resBody;
  if (!body || body.length > ERROR_ENVELOPE_MAX) return false;
  if (!body.includes('"errors"')) return false;
  return obj(safeJson(body))?.errors === true;
}

/**
 * What an exchange DOES, named identically whether it succeeded or failed.
 *
 * Numeric path segments are collapsed to `{id}` so one operation name covers
 * every store, item and collection — otherwise the traffic table's Operation
 * column would have a distinct value per store id, which is a list of ids
 * rather than a list of operations.
 */
export function totersOperation(capture: Capture): string | undefined {
  if (!matchesToters(capture.host)) return undefined;
  if (isImageHost(capture.host)) return 'image';
  const path = capture.path.split('?')[0] ?? capture.path;
  const normalized = path.replace(/\/\d+(?=\/|$)/g, '/{id}');
  const trimmed = normalized.replace(/^\/api\//, '').replace(/^\//, '');
  return trimmed.length > 0 ? trimmed.replace(/\//g, '.') : undefined;
}

/**
 * Total by construction: it reads the url triple, the status and — only for a
 * small body — the `errors` flag. There is no shape the service can send that
 * makes this throw.
 */
export function classifyTotersCapture(capture: Capture): { class: CaptureClass; operation?: string } {
  const operation = totersOperation(capture);
  if (isImageHost(capture.host)) return { class: 'asset', operation };
  if (typeof capture.status === 'number' && capture.status >= 400) return { class: 'error', operation };
  // A 200 carrying `{ errors: true }` is a failure. Calling it `structure` is
  // what would send `parse` looking for stores inside a rejection.
  if (hasErrorFlag(capture)) return { class: 'error', operation };
  if (capture.path.startsWith('/api/auth/')) return { class: 'auth', operation };
  if (!capture.resBody) return { class: 'unknown', operation };
  if (parserFor(capture.path.split('?')[0] ?? capture.path)) return { class: 'structure', operation };
  return { class: 'unknown', operation };
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** The parser for each endpoint family `parse` turns into entities; undefined for the rest. */
function parserFor(path: string): ((data: Record<string, unknown>, capture: Capture) => ParseResult) | undefined {
  if (path === '/api/user-info') return parseUserInfo;
  if (path === '/api/addresses') return parseAddresses;
  if (STORE_LIST_PATHS.has(path)) return (d) => storeContainers(arr(obj(d.stores)?.data)); // a Laravel paginator
  if (path === '/api/mobile/store/favorites') return (d) => storeContainers(arr(d.favoriteStores));
  if (/^\/api\/v2\/home\/store-collections\/\d+$/.test(path)) {
    return (d) => storeContainers(arr(d.stores) ?? arr(obj(d.collection)?.stores));
  }
  if (/^\/api\/stores\/\d+\/items\/popular$/.test(path) || /^\/api\/mobile\/upselling-items\/\d+$/.test(path)) {
    return parseItems;
  }
  return undefined;
}

/** Paths whose `data` carries a Laravel paginator of stores. */
const STORE_LIST_PATHS = new Set(['/api/home/stores']);

/**
 * Localized display name. Toters ships `ref` plus `ref_ar` / `ref_krs` /
 * `ref_krb` / `ref_tr` siblings; `ref` is the English one and the only one the
 * dashboard has a column for.
 */
function displayName(record: Record<string, unknown>): string | undefined {
  return str(record.ref) ?? str(record.name) ?? str(record.title);
}

/**
 * Turn one Toters capture into normalized entities.
 *
 * Never throws: every read goes through the SDK coercers, which return
 * `undefined` for a present-but-wrong-typed field rather than letting
 * `for…of` meet an object. Anything unrecognised yields `{}`.
 */
export function parseTotersCapture(capture: Capture): ParseResult {
  if (!matchesToters(capture.host)) return {};
  if (classifyTotersCapture(capture).class !== 'structure') return {};

  const data = obj(obj(safeJson(capture.resBody))?.data);
  if (!data) return {};
  return parserFor(capture.path.split('?')[0] ?? capture.path)?.(data, capture) ?? {};
}

/** `{ user: {…} }` → the signed-in Actor, and a named Workspace for it. */
function parseUserInfo(data: Record<string, unknown>): ParseResult {
  const user = obj(data.user);
  const id = num(user?.id);
  if (!user || id === undefined) return {};
  const first = str(user.first_name) ?? '';
  const last = str(user.last_name) ?? '';
  const name = `${first} ${last}`.trim();
  const workspace: Workspace = {
    id: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    name: name.length > 0 ? `Toters — ${name}` : 'Toters',
  };
  const actor: Actor = {
    id: String(id),
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    // Toters has no @handle. The numeric id is the only stable identifier the
    // account has, so it doubles as the handle rather than inventing one from
    // the email — which is a secret-adjacent value the entity shape would then
    // display in the dashboard.
    handle: String(id),
    displayName: name.length > 0 ? name : String(id),
    raw: user,
  };
  return { workspaces: [workspace], actors: [actor] };
}

/** `{ addresses: [...] }` → one Container per saved delivery address. */
function parseAddresses(data: Record<string, unknown>): ParseResult {
  const containers: Container[] = [];
  for (const raw of arr(data.addresses) ?? []) {
    const a = obj(raw);
    const id = num(a?.id);
    if (!a || id === undefined) continue;
    containers.push({
      id: `address:${id}`,
      workspaceId: WORKSPACE_ID,
      adapterId: ADAPTER_ID,
      kind: 'other',
      name: str(a.title) ?? str(a.street) ?? str(a.description) ?? `Address ${id}`,
      raw: a,
    });
  }
  return containers.length > 0 ? { containers } : {};
}

function storeContainers(records: unknown[] = []): ParseResult {
  const containers: Container[] = [];
  for (const raw of records) {
    const s = obj(raw);
    const id = num(s?.id);
    if (!s || id === undefined) continue;
    containers.push({
      id: `store:${id}`,
      workspaceId: WORKSPACE_ID,
      adapterId: ADAPTER_ID,
      // Toters has no channel/board/thread analogue — a store is a venue, which
      // the fixed entity vocabulary spells `other`. Inventing a `store` kind
      // would make it invisible to the UI, which switches on the known set.
      kind: 'other',
      name: displayName(s) ?? `Store ${id}`,
      raw: s,
    });
  }
  return { containers };
}

/**
 * Menu / catalogue items. The collection key differs per endpoint (`popular`,
 * `items`, `upselling_items`), so the first array-of-objects under a known key
 * wins rather than hardcoding one name per route.
 */
const ITEM_KEYS = ['popular', 'items', 'upselling_items', 'upsellingItems'];

function parseItems(data: Record<string, unknown>, capture: Capture): ParseResult {
  const ts = capture.ts || Date.now();
  const records = ITEM_KEYS.map((key) => arr(data[key])).find((a) => a !== undefined && a.length > 0);
  if (!records) return {};

  // The owning store is in the request path, never in the item record — the
  // same recovery `requestParams` exists for on other adapters, one level
  // simpler because it is a path segment rather than a query param.
  const storeId = capture.path.match(/\/stores\/(\d+)\//)?.[1]
    ?? capture.path.match(/\/upselling-items\/(\d+)/)?.[1];
  // `Item.containerId` is required, and rightly so: a catalogue item that is
  // not attached to a store is not answerable to any question the MCP tools
  // ask. Without a recoverable store id there is nothing honest to emit.
  if (!storeId) return {};

  const items: Item[] = [];
  for (const raw of records) {
    const it = obj(raw);
    const id = num(it?.id);
    if (!it || id === undefined) continue;
    items.push({
      id: `item:${id}`,
      workspaceId: WORKSPACE_ID,
      adapterId: ADAPTER_ID,
      containerId: `store:${storeId}`,
      kind: 'other',
      text: displayName(it) ?? `Item ${id}`,
      ts,
      sourceCaptureIds: [capture.id],
      raw: it,
    });
  }
  return items.length > 0 ? { items } : {};
}

// ── Pagination ───────────────────────────────────────────────────────────────

/**
 * Toters paginates the store list with a Laravel paginator:
 * `{ current_page, last_page, next_page_url: '/?page=2', total }`.
 *
 * Only the store list is seeded. The item endpoints return a bare array with no
 * paginator at all, and seeding a page-2 for them would fetch page one forever
 * — the exact failure the empty-cursor rule exists to prevent.
 */
export function totersNextCursors(capture: Capture): CursorSeed[] {
  if (!matchesToters(capture.host)) return [];
  const path = capture.path.split('?')[0] ?? capture.path;
  if (!STORE_LIST_PATHS.has(path)) return [];
  if (classifyTotersCapture(capture).class !== 'structure') return [];

  const page = obj(obj(obj(safeJson(capture.resBody))?.data)?.stores);
  if (!page) return [];
  const current = num(page.current_page);
  const last = num(page.last_page);
  if (current === undefined || last === undefined || current >= last) return [];

  // The cursor is the page NUMBER, not `next_page_url` — that field arrives as
  // a root-relative `/?page=2` against `path: '/'`, which is not resolvable to
  // the real endpoint and would rebuild into a request for the API root.
  const next = String(current + 1);
  return [
    {
      adapterId: ADAPTER_ID,
      actionId: 'toters.home.stores',
      cursor: next,
      reason: 'cursor',
      depth: 1,
    },
  ];
}

// ── Replay ───────────────────────────────────────────────────────────────────

/**
 * GET-only, and deliberately narrow.
 *
 * Every action here is a read that the phone itself performs on launch. There
 * is no cart, no order, no address mutation and no payment action, because
 * replaying one of those spends the account's real money — `POST /api/orders`
 * placed a paid order in the traffic this adapter was written from.
 */
export const TOTERS_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'toters.user.info',
    adapterId: ADAPTER_ID,
    label: 'Signed-in user profile',
    method: 'GET',
    urlTemplate: 'https://api.toters-api.com/api/user-info',
    params: [],
  },
  {
    id: 'toters.addresses',
    adapterId: ADAPTER_ID,
    label: 'Saved delivery addresses',
    method: 'GET',
    urlTemplate: 'https://api.toters-api.com/api/addresses',
    params: [],
  },
  {
    id: 'toters.home.stores',
    adapterId: ADAPTER_ID,
    label: 'Nearby stores (paginated)',
    method: 'GET',
    urlTemplate: 'https://api.toters-api.com/api/home/stores',
    params: [
      { name: 'page', label: 'Page number', kind: 'string' },
      { name: 'lat', label: 'Latitude', kind: 'string' },
      { name: 'lon', label: 'Longitude', kind: 'string' },
    ],
  },
  {
    id: 'toters.store.favorites',
    adapterId: ADAPTER_ID,
    label: 'Favourite stores',
    method: 'GET',
    urlTemplate: 'https://api.toters-api.com/api/mobile/store/favorites',
    params: [],
  },
  {
    id: 'toters.store.popular-items',
    adapterId: ADAPTER_ID,
    label: 'Popular items in a store',
    method: 'GET',
    urlTemplate: 'https://api.toters-api.com/api/stores/{storeId}/items/popular',
    params: [{ name: 'storeId', label: 'Store id', kind: 'string', required: true }],
  },
];

/**
 * Build a concrete GET.
 *
 * Secrets are read by VALUE off `session.credentials.values`, never by copying
 * an `injection` key name onto the wire — the conformance probe inspects the
 * built url, headers and body for the literal key strings, and
 * `Authorization: accessToken` is exactly what it catches.
 *
 * The device headers below are not authentication. Toters rejects a request
 * without `app` / `platform` / `version`, so they are part of a well-formed
 * call; the faithful-replay overlay will replace them with the real client's
 * learned values when a capture for this endpoint exists.
 *
 * A missing `{storeId}` throws by name (see `fillPathParams`). Only DECLARED
 * params reach the query; a caller's extra keys are dropped.
 */
export function buildTotersReplayRequest(
  action: ReplayAction,
  params: Record<string, string>,
  session: Session,
): ReplayRequest {
  const headers: Record<string, string> = {
    accept: 'application/x.toters.v1+json',
    app: 'customer',
    platform: 'ios',
  };

  const values = session.credentials?.values ?? {};
  const authorization = values.authorization ?? (values.accessToken ? `Bearer ${values.accessToken}` : undefined);
  if (authorization) headers.authorization = authorization;
  const deviceToken = values.clientDeviceToken;
  if (deviceToken) headers['client-device-token'] = deviceToken;

  return { method: 'GET', url: actionUrl(action, params), headers };
}
