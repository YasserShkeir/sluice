// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-olx — the self-contained OLX Lebanon app.
 *
 * OLX Lebanon (www.olx.com.lb) is browsable without a login, so this app has NO
 * credential provider. It contributes:
 *   - an adapter that claims olx.com.lb and olx-dubizzle.com traffic,
 *   - a parser for public categories/locations JSON and Next.js listing/ad
 *     payloads (both `_next/data` JSON and HTML `__NEXT_DATA__`),
 *   - classifiers that keep images, static assets, metrics, and the private
 *     Elasticsearch `_msearch` endpoint out of entity parsing,
 *   - replay actions for the public GET surfaces,
 *   - MCP tools that re-issue those GETs through `ctx.replay`.
 *
 * The Elasticsearch host is claimed so captures are attributed, but it is never
 * parsed or replayed: the browser bundle's Basic auth is a secret we do not
 * commit, and the public Next.js / api-prod GETs already cover listings.
 */
import { arr, CHROME_UA, num, obj, requestParams, requireReplay, safeJson, str } from '@sluice/adapter-sdk';
import type {
  Actor,
  App,
  AppMcpTool,
  AppToolContext,
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
import { z } from 'zod';

export const ADAPTER_ID = 'olx';
const WORKSPACE_ID = 'olx';
const SITE_ORIGIN = 'https://www.olx.com.lb';
const API_ORIGIN = 'https://api-prod.olx-dubizzle.com';

const OLX_HEADERS: Record<string, string> = {
  'User-Agent': CHROME_UA,
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  Referer: `${SITE_ORIGIN}/`,
};

const ASSET_PATH = /\.(?:js|css|svg|png|jpe?g|gif|webp|woff2?|ico)(?:\?|$)/i;
const NEXT_DATA_PATH = /^\/_next\/data\/[^/]+\/(.+)\.json$/;
const AD_HTML_PATH = /\/ad\/([^/]+)-ID(\d+)\.html$/i;

function matchesOlx(host: string): boolean {
  return (
    host === 'olx.com.lb' ||
    host.endsWith('.olx.com.lb') ||
    host === 'olx-dubizzle.com' ||
    host.endsWith('.olx-dubizzle.com')
  );
}

function workspace(): Workspace {
  return {
    id: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    name: 'OLX Lebanon',
    domain: 'olx.com.lb',
  };
}

function sitePath(capture: Capture): string {
  try {
    return new URL(capture.url).pathname;
  } catch {
    return capture.path;
  }
}

function safeSegment(value: string): string {
  return value.replace(/^\/+/u, '').replace(/\/+$/u, '').replace(/\.\./gu, '');
}

function epochMs(value: unknown, fallback: number): number {
  const n = num(value);
  if (n === undefined) return fallback;
  return n < 1e11 ? Math.round(n * 1000) : n;
}

function nextDataFromHtml(text: string): unknown {
  const start = text.indexOf('<script id="__NEXT_DATA__" type="application/json">');
  if (start < 0) return undefined;
  const open = text.indexOf('>', start);
  if (open < 0) return undefined;
  const end = text.indexOf('</script>', open);
  if (end < 0) return undefined;
  return safeJson(text.slice(open + 1, end));
}

function decodeBody(capture: Capture): unknown {
  const trimmed = capture.resBody?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('<') ? nextDataFromHtml(trimmed) : safeJson(trimmed);
}

function pagePropsOf(body: unknown): Record<string, unknown> | undefined {
  const root = obj(body);
  return obj(root?.pageProps) ?? obj(obj(root?.props)?.pageProps);
}

function initialStateOf(body: unknown): Record<string, unknown> | undefined {
  return obj(pagePropsOf(body)?.initialState) ?? obj(obj(body)?.initialState);
}

function searchPathOf(capture: Capture, body: unknown): string | undefined {
  const fromProps = str(pagePropsOf(body)?.searchPath);
  if (fromProps) return safeSegment(fromProps.replace(/^\/?(?:en|ar)\//u, ''));

  const path = sitePath(capture);
  const next = NEXT_DATA_PATH.exec(path);
  if (next?.[1]) {
    return safeSegment(next[1].replace(/^(?:en|ar)\//u, ''));
  }
  const html = /^\/(?:(?:en|ar)\/)?(.+?)\/?$/u.exec(path);
  if (html?.[1] && !html[1].startsWith('ad/')) return safeSegment(html[1]);
  return undefined;
}

function olxOperation(capture: Capture): string | undefined {
  const path = sitePath(capture);
  if (capture.host.endsWith('.olx-dubizzle.com')) {
    if (path.startsWith('/api/v1/categories')) return 'categories.list';
    if (path.startsWith('/api/v1/locations')) return 'locations.list';
    if (path.includes('_msearch')) return 'search.msearch';
    if (capture.host.startsWith('ovation-') || path.toLowerCase().includes('bannermetric')) {
      return 'metrics.ingest';
    }
    if (capture.host.startsWith('images-') || ASSET_PATH.test(path)) return 'app.asset';
  }
  if (capture.host === 'olx.com.lb' || capture.host.endsWith('.olx.com.lb')) {
    if (path.startsWith('/_next/static') || ASSET_PATH.test(path)) return 'app.asset';
    if (NEXT_DATA_PATH.test(path) && /\/ad\//u.test(path)) return 'ads.detail';
    if (NEXT_DATA_PATH.test(path)) return 'ads.search';
    if (AD_HTML_PATH.test(path)) return 'ads.detail';
    if (path === '/' || path === '/en' || path === '/en/' || path === '/ar' || path === '/ar/') {
      return 'app.shell';
    }
    // Locale-prefixed (/en/vehicles/...) and bare (/vehicles/...) listing URLs.
    return 'ads.search';
  }
  return undefined;
}

export function classifyOlxCapture(capture: Capture): { class: CaptureClass; operation?: string } {
  const operation = olxOperation(capture);
  if (typeof capture.status === 'number' && capture.status >= 400) return { class: 'error', operation };
  if (operation === 'app.asset' || operation === 'app.shell') return { class: 'asset', operation };
  if (operation === 'metrics.ingest' || operation === 'search.msearch') return { class: 'unknown', operation };
  if (operation === 'categories.list' || operation === 'locations.list') return { class: 'structure', operation };
  if (operation === 'ads.search' || operation === 'ads.detail') {
    if (typeof capture.resBody === 'string' && capture.resBody.length > 0) return { class: 'messages', operation };
    return { class: 'unknown', operation };
  }
  return { class: 'unknown', operation };
}

function pushCategory(node: unknown, out: Container[]): void {
  const o = obj(node);
  if (!o) return;
  const id = num(o.id);
  if (id === undefined) return;
  const name = str(o.name) ?? str(o.slug) ?? `category ${id}`;
  const stats = obj(o.statistics);
  out.push({
    id: `cat:${id}`,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'other',
    name,
    itemCount: num(stats?.activeCount),
    raw: o,
  });
  for (const child of arr(o.children) ?? []) pushCategory(child, out);
}

function pushLocation(node: unknown, out: Container[]): void {
  const o = obj(node);
  if (!o) return;
  const id = num(o.id);
  if (id === undefined) return;
  const name = str(o.name) ?? str(o.name_en) ?? str(o.slug) ?? `location ${id}`;
  out.push({
    id: `loc:${id}`,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'other',
    name,
    raw: o,
  });
  for (const child of arr(o.children) ?? []) pushLocation(child, out);
}

function leafCategoryId(hit: Record<string, unknown>): string | undefined {
  const id = num(obj(arr(hit.category)?.at(-1))?.id);
  return id === undefined ? undefined : `cat:${id}`;
}

function locationLabel(hit: Record<string, unknown>): string | undefined {
  const locs = arr(hit.location);
  if (!locs) return str(obj(hit.location)?.name);
  const names: string[] = [];
  for (const row of locs) {
    const name = str(obj(row)?.name);
    if (name) names.push(name);
  }
  return names.length > 0 ? names.join(' / ') : undefined;
}

function extraOf(hit: Record<string, unknown>): Record<string, unknown> | undefined {
  return obj(hit.extraFields) ?? obj(hit.extra);
}

/** OLX listing `price` is often `"0.00"`; the USD amount is `extraFields.price`. */
function priceLabel(hit: Record<string, unknown>): string | undefined {
  const extra = extraOf(hit);
  const usd = num(extra?.price);
  if (usd !== undefined) return `USD ${usd}`;
  const raw = str(hit.price);
  if (raw && raw !== '0.00') return raw;
  return undefined;
}

function adToItem(hit: unknown, capture: Capture, fallbackContainer: string): Item | undefined {
  const o = obj(hit);
  if (!o) return undefined;
  const externalId = str(o.externalID) ?? str(o.external_id) ?? (num(o.id) !== undefined ? String(num(o.id)) : undefined);
  if (!externalId) return undefined;
  const title = str(o.title) ?? str(o.slug) ?? `ad ${externalId}`;
  const extra = extraOf(o);
  const price = priceLabel(o);
  const year = num(extra?.year);
  const km = num(extra?.mileage);
  const where = locationLabel(o);
  const description = str(o.description);
  const bits = [title];
  if (price) bits.push(price);
  if (year !== undefined) bits.push(String(year));
  if (km !== undefined && km > 0) bits.push(`${km} km`);
  if (where) bits.push(where);
  if (description) bits.push(description);
  const authorId = str(o.userExternalID);
  return {
    id: externalId,
    containerId: leafCategoryId(o) ?? fallbackContainer,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'page',
    authorId,
    ts: epochMs(o.createdAt ?? o.updatedAt ?? o.timestamp, capture.ts),
    text: bits.join('\n').slice(0, 4000),
    sourceCaptureIds: [capture.id],
    raw: o,
  };
}

function actorFromHit(hit: unknown): Actor | undefined {
  const o = obj(hit);
  if (!o) return undefined;
  const id = str(o.userExternalID);
  if (!id) return undefined;
  const contact = obj(o.contactInfo);
  const name = str(contact?.name) ?? id;
  return {
    id,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    handle: name,
    displayName: str(contact?.name),
    raw: contact ?? { userExternalID: id },
  };
}

function parseTree(body: unknown, push: (node: unknown, out: Container[]) => void): Container[] {
  const out: Container[] = [];
  for (const row of arr(body) ?? arr(obj(body)?.data) ?? []) push(row, out);
  return out;
}

function parseAds(capture: Capture, body: unknown): ParseResult {
  const st = initialStateOf(body);
  if (!st) return {};
  const path = searchPathOf(capture, body) ?? 'search';
  const searchContainerId = `search:${path}`;
  const ads = obj(obj(st.search)?.ads);
  const hits = arr(ads?.hits) ?? [];
  const detail = obj(obj(st.ad)?.data);
  const result: ParseResult = {
    workspaces: [workspace()],
    containers: [
      {
        id: searchContainerId,
        workspaceId: WORKSPACE_ID,
        adapterId: ADAPTER_ID,
        kind: 'other',
        name: path,
        itemCount: num(ads?.totalHits),
        raw: ads ? { pageSize: ads.pageSize, totalHits: ads.totalHits, pageCount: ads.pageCount } : undefined,
      },
    ],
  };
  const items: Item[] = [];
  const actors = new Map<string, Actor>();

  const consider = (hit: unknown) => {
    const item = adToItem(hit, capture, searchContainerId);
    if (item) items.push(item);
    const actor = actorFromHit(hit);
    if (actor && !actors.has(actor.id)) actors.set(actor.id, actor);
  };
  for (const hit of hits) consider(hit);
  if (detail) consider(detail);

  if (items.length > 0) result.items = items;
  if (actors.size > 0) result.actors = [...actors.values()];
  return result;
}

export function parseOlxCapture(capture: Capture): ParseResult {
  const classified = classifyOlxCapture(capture);
  if (classified.class === 'error' || classified.class === 'asset' || classified.class === 'unknown') {
    return {};
  }
  const body = decodeBody(capture);
  if (body === undefined) return {};

  if (classified.operation === 'categories.list') {
    return { workspaces: [workspace()], containers: parseTree(body, pushCategory) };
  }
  if (classified.operation === 'locations.list') {
    return { workspaces: [workspace()], containers: parseTree(body, pushLocation) };
  }
  if (classified.operation === 'ads.search' || classified.operation === 'ads.detail') {
    return parseAds(capture, body);
  }
  return {};
}

export function olxNextCursors(capture: Capture): CursorSeed[] {
  const classified = classifyOlxCapture(capture);
  if (classified.operation !== 'ads.search') return [];
  if (classified.class === 'error') return [];
  const body = decodeBody(capture);
  const st = initialStateOf(body);
  const ads = obj(obj(st?.search)?.ads);
  const pageCount = num(ads?.pageCount);
  if (pageCount === undefined || pageCount < 2) return [];
  const params = requestParams(capture);
  const current = Math.max(1, Math.floor(num(params.page) ?? 1));
  const next = current + 1;
  if (next > pageCount) return [];
  const path = searchPathOf(capture, body);
  if (!path) return [];
  return [
    {
      adapterId: ADAPTER_ID,
      actionId: 'olx.search.ads',
      containerId: `search:${path}`,
      cursor: String(next),
      params: { path, page: String(next) },
      reason: 'cursor',
      depth: 1,
    },
  ];
}

const OLX_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'olx.categories.list',
    adapterId: ADAPTER_ID,
    label: 'OLX categories',
    method: 'GET',
    urlTemplate: `${API_ORIGIN}/api/v1/categories`,
    params: [],
  },
  {
    id: 'olx.locations.list',
    adapterId: ADAPTER_ID,
    label: 'OLX locations',
    method: 'GET',
    urlTemplate: `${API_ORIGIN}/api/v1/locations`,
    params: [],
  },
  {
    id: 'olx.search.ads',
    adapterId: ADAPTER_ID,
    label: 'OLX listing search (HTML)',
    method: 'GET',
    urlTemplate: `${SITE_ORIGIN}/en/{path}`,
    params: [
      { name: 'path', label: 'Category path', kind: 'string', default: 'vehicles/cars-for-sale' },
      { name: 'q', label: 'Free-text query (appended as /q-…)', kind: 'string' },
      { name: 'page', label: 'Page', kind: 'cursor', default: '1' },
    ],
  },
  {
    id: 'olx.ad.get',
    adapterId: ADAPTER_ID,
    label: 'OLX ad page',
    method: 'GET',
    urlTemplate: `${SITE_ORIGIN}/en/ad/{slug}-ID{externalId}.html`,
    params: [
      { name: 'externalId', label: 'Ad external id', kind: 'string', required: true },
      { name: 'slug', label: 'Ad slug', kind: 'string', default: 'ad' },
    ],
  },
];

function olxAction(id: string): ReplayAction {
  const action = OLX_REPLAY_ACTIONS.find((a) => a.id === id);
  if (!action) throw new Error(`OLX replay action "${id}" is missing`);
  return action;
}

export function buildOlxReplayRequest(
  action: ReplayAction,
  params: Record<string, string>,
  _session?: Session,
): ReplayRequest {
  if (action.id === 'olx.search.ads') {
    let path = safeSegment(params.path || 'vehicles/cars-for-sale');
    const q = params.q?.trim();
    if (q) {
      const slug = safeSegment(q.toLowerCase().replace(/\s+/gu, '-')).replace(/[^a-z0-9_-]/gu, '');
      if (slug && !path.includes(`/q-${slug}`)) {
        path = `${path}/q-${slug}`;
      }
    }
    const u = new URL(`${SITE_ORIGIN}/en/${path}`);
    const page = params.page && params.page.length > 0 ? params.page : '1';
    if (page !== '1') u.searchParams.set('page', page);
    return { method: 'GET', url: u.toString(), headers: { ...OLX_HEADERS } };
  }
  if (action.id === 'olx.ad.get') {
    const externalId = params.externalId ?? '';
    if (!externalId) throw new Error('OLX replay action "olx.ad.get" needs externalId');
    const slug = safeSegment(params.slug || 'ad').replace(/[^a-zA-Z0-9_-]/gu, '') || 'ad';
    const id = externalId.replace(/[^\d]/gu, '');
    if (!id) throw new Error('OLX replay action "olx.ad.get" needs a numeric externalId');
    return {
      method: 'GET',
      url: `${SITE_ORIGIN}/en/ad/${slug}-ID${id}.html`,
      headers: { ...OLX_HEADERS },
    };
  }
  return { method: 'GET', url: action.urlTemplate, headers: { ...OLX_HEADERS } };
}

/** A GET through the host's replay pipeline (no bare-`fetch` fallback); throws on HTTP >= 400. */
async function olxGet(url: string, label: string, ctx?: AppToolContext): Promise<Capture> {
  requireReplay(ctx);
  const capture = await ctx.replay({ method: 'GET', url, headers: { ...OLX_HEADERS } });
  if (typeof capture.status === 'number' && capture.status >= 400) {
    throw new Error(`${label} failed: HTTP ${capture.status}`);
  }
  return capture;
}

async function listCategoriesTool(_args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const capture = await olxGet(`${API_ORIGIN}/api/v1/categories`, 'olx_list_categories', ctx);
  const parsed = parseOlxCapture(capture);
  return {
    count: parsed.containers?.length ?? 0,
    categories: (parsed.containers ?? []).map((c) => ({ id: c.id, name: c.name, itemCount: c.itemCount })),
  };
}

async function searchAdsTool(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const path = safeSegment(str(args.path) || 'vehicles/cars-for-sale');
  const page = str(args.page) || (num(args.page) !== undefined ? String(num(args.page)) : '1');
  const q = str(args.q);
  const req = buildOlxReplayRequest(olxAction('olx.search.ads'), { path, page, ...(q ? { q } : {}) });
  const capture = await olxGet(req.url, 'olx_search_ads', ctx);
  const parsed = parseOlxCapture(capture);
  return {
    path: new URL(req.url).pathname.replace(/^\/en\//u, '').replace(/\/$/u, ''),
    page,
    count: parsed.items?.length ?? 0,
    ads: (parsed.items ?? []).map((item) => ({
      id: item.id,
      title: item.text.split('\n')[0],
      text: item.text,
      containerId: item.containerId,
      authorId: item.authorId,
      ts: item.ts,
    })),
  };
}

async function getAdTool(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const externalId = str(args.externalId);
  if (!externalId) throw new Error('olx_get_ad requires externalId');
  const slug = str(args.slug) || 'ad';
  const req = buildOlxReplayRequest(olxAction('olx.ad.get'), { externalId, slug });
  const capture = await olxGet(req.url, 'olx_get_ad', ctx);
  const parsed = parseOlxCapture(capture);
  const item = parsed.items?.[0];
  if (!item) return { error: 'ad not found in page payload', status: capture.status };
  return { id: item.id, text: item.text, containerId: item.containerId, authorId: item.authorId, ts: item.ts };
}

const olxMcpTools: AppMcpTool[] = [
  {
    name: 'olx_list_categories',
    description:
      'List public OLX Lebanon categories (id, name) via api-prod.olx-dubizzle.com. No login required.',
    run: (args, ctx) => listCategoriesTool(args, ctx),
  },
  {
    name: 'olx_search_ads',
    description:
      'Search public OLX Lebanon listings by category path (e.g. vehicles/cars-for-sale), optional q (e.g. red-sedan), and page. Prices come from extraFields.price. No login required.',
    inputSchema: {
      path: z.string().optional(),
      q: z.string().optional(),
      page: z.union([z.string(), z.number()]).optional(),
    },
    run: (args, ctx) => searchAdsTool(args, ctx),
  },
  {
    name: 'olx_get_ad',
    description:
      'Fetch one public OLX Lebanon ad by externalId and slug (from search results). No login required.',
    inputSchema: {
      externalId: z.string(),
      slug: z.string().optional(),
    },
    run: (args, ctx) => getAdTool(args, ctx),
  },
];

/** The one installed OLX Lebanon app: a credential-free adapter with MCP tools. */
export const olxApp: App = {
  id: ADAPTER_ID,
  displayName: 'OLX Lebanon',
  hosts: ['olx.com.lb', 'olx-dubizzle.com'],
  matchRequest(input) {
    return matchesOlx(input.host);
  },
  parse: parseOlxCapture,
  classify: classifyOlxCapture,
  nextCursors: olxNextCursors,
  listReplayActions() {
    return OLX_REPLAY_ACTIONS;
  },
  buildReplayRequest: buildOlxReplayRequest,
  mcpTools() {
    return olxMcpTools;
  },
};
