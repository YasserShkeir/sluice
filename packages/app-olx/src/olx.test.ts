// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * app-olx tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeCapture, makeJsonCapture, runConformance } from '@sluice/adapter-sdk';
import type { AppToolContext, Capture } from '@sluice/core';
import {
  buildOlxReplayRequest,
  classifyOlxCapture,
  olxApp,
  olxNextCursors,
  parseOlxCapture,
} from './index.js';

function capture(over: Partial<Capture> = {}): Capture {
  return makeCapture({
    method: 'GET',
    url: 'https://api-prod.olx-dubizzle.com/api/v1/categories',
    host: 'api-prod.olx-dubizzle.com',
    path: '/api/v1/categories',
    ...over,
  });
}

const CATEGORIES = [
  {
    id: 1,
    name: 'Vehicles',
    slug: 'vehicles',
    statistics: { activeCount: 0 },
    children: [{ id: 51, name: 'Cars for Sale', slug: 'cars-for-sale', parentID: 1, children: [] }],
  },
];

const LOCATIONS = {
  status: 'ok',
  data: [
    {
      id: 4,
      name: 'Zahle',
      slug: 'zahle',
      children: [{ id: 124, name: 'Ain ed Dawq', slug: 'ain-ed-dawq', parent_id: 4 }],
    },
  ],
};

// Every value is synthetic: the shape is OLX's, the listing and seller are not.
const HIT = {
  id: 1000001,
  externalID: '100000001',
  title: 'Example Coupe - 2010',
  slug: 'example-coupe-2010',
  price: '0.00',
  extraFields: { price: 12345, year: 2010, mileage: 54321, make: 'ExampleMake', model: 'ExampleModel' },
  description: 'Test listing',
  createdAt: 1_700_000_001,
  userExternalID: 'seller-1',
  contactInfo: { name: 'Test Seller' },
  category: [
    { id: 1, name: 'Vehicles', slug: 'vehicles' },
    { id: 51, name: 'Cars for Sale', slug: 'cars-for-sale' },
  ],
  location: [
    { id: 1, name: 'Lebanon', slug: 'lebanon' },
    { id: 21, name: 'Metn', slug: 'metn' },
  ],
};

function nextDataBody(over: Record<string, unknown> = {}) {
  return {
    pageProps: {
      searchPath: 'vehicles/cars-for-sale',
      initialState: {
        search: {
          ads: { hits: [HIT], pageSize: 45, totalHits: 900, pageCount: 20 },
        },
        ad: { data: null },
        ...over,
      },
    },
  };
}

test('matchRequest claims OLX Lebanon and dubizzle, and nothing else', () => {
  const hit = (host: string) => olxApp.matchRequest({ host, path: '/', method: 'GET', url: '' });
  for (const h of [
    'olx.com.lb',
    'www.olx.com.lb',
    'olx-dubizzle.com',
    'api-prod.olx-dubizzle.com',
    'search-prod.olx-dubizzle.com',
    'images-prod.olx-dubizzle.com',
  ]) {
    assert.ok(hit(h), `${h} should match`);
  }
  for (const h of ['olx.com', 'notolx.com.lb', 'olx.com.lb.evil.test', 'slack.com']) {
    assert.ok(!hit(h), `${h} must not match`);
  }
});

test('classify names public APIs and keeps assets/metrics/msearch out of parse', () => {
  assert.equal(classifyOlxCapture(capture()).class, 'structure');
  assert.equal(classifyOlxCapture(capture()).operation, 'categories.list');

  const locations = capture({
    path: '/api/v1/locations',
    url: 'https://api-prod.olx-dubizzle.com/api/v1/locations',
  });
  assert.equal(classifyOlxCapture(locations).operation, 'locations.list');

  const search = capture({
    host: 'www.olx.com.lb',
    path: '/_next/data/build/en/vehicles/cars-for-sale.json',
    url: 'https://www.olx.com.lb/_next/data/build/en/vehicles/cars-for-sale.json?page=2',
    resBody: '{}',
  });
  assert.equal(classifyOlxCapture(search).class, 'messages');
  assert.equal(classifyOlxCapture(search).operation, 'ads.search');

  const svg = capture({
    host: 'www.olx.com.lb',
    path: '/_next/static/media/logo.svg',
    url: 'https://www.olx.com.lb/_next/static/media/logo.svg',
  });
  assert.equal(classifyOlxCapture(svg).class, 'asset');

  const metrics = capture({
    host: 'ovation-prod.olx-dubizzle.com',
    path: '/bannerMetric',
    url: 'https://ovation-prod.olx-dubizzle.com/bannerMetric',
  });
  assert.equal(classifyOlxCapture(metrics).class, 'unknown');
  assert.equal(classifyOlxCapture(metrics).operation, 'metrics.ingest');

  const msearch = capture({
    host: 'search-prod.olx-dubizzle.com',
    path: '/ads/_msearch',
    url: 'https://search-prod.olx-dubizzle.com/ads/_msearch',
    method: 'POST',
  });
  assert.equal(classifyOlxCapture(msearch).class, 'unknown');
  assert.deepEqual(parseOlxCapture(msearch), {});
});

test('a rejected call is an error and is not parsed', () => {
  const got = classifyOlxCapture(capture({ status: 401, resBody: JSON.stringify(CATEGORIES) }));
  assert.equal(got.class, 'error');
  assert.equal(got.operation, 'categories.list');
  assert.deepEqual(parseOlxCapture(capture({ status: 401, resBody: JSON.stringify(CATEGORIES) })), {});
});

test('parse walks category and location trees into containers', () => {
  const cats = parseOlxCapture(capture({ resBody: JSON.stringify(CATEGORIES) }));
  assert.equal(cats.containers?.length, 2);
  assert.equal(cats.containers?.[0]?.id, 'cat:1');
  assert.equal(cats.containers?.[1]?.id, 'cat:51');
  assert.equal(cats.containers?.[0]?.adapterId, 'olx');

  const locs = parseOlxCapture(
    capture({
      path: '/api/v1/locations',
      url: 'https://api-prod.olx-dubizzle.com/api/v1/locations',
      resBody: JSON.stringify(LOCATIONS),
    }),
  );
  assert.equal(locs.containers?.length, 2);
  assert.equal(locs.containers?.[0]?.id, 'loc:4');
  assert.equal(locs.containers?.[1]?.id, 'loc:124');
});

test('parse turns next-data search hits into items', () => {
  const result = parseOlxCapture(
    capture({
      host: 'www.olx.com.lb',
      path: '/_next/data/build/en/vehicles/cars-for-sale.json',
      url: 'https://www.olx.com.lb/_next/data/build/en/vehicles/cars-for-sale.json?page=1',
      resBody: JSON.stringify(nextDataBody()),
    }),
  );
  assert.equal(result.items?.length, 1);
  assert.equal(result.items?.[0]?.id, '100000001');
  assert.equal(result.items?.[0]?.containerId, 'cat:51');
  assert.equal(result.items?.[0]?.kind, 'page');
  assert.match(result.items?.[0]?.text ?? '', /USD 12345/);
  assert.match(result.items?.[0]?.text ?? '', /2010/);
  assert.match(result.items?.[0]?.text ?? '', /54321 km/);
  assert.equal(result.actors?.[0]?.handle, 'Test Seller');
  assert.equal(result.containers?.[0]?.id, 'search:vehicles/cars-for-sale');
  assert.equal(result.containers?.[0]?.itemCount, 900);
});

test('parse extracts __NEXT_DATA__ from HTML listing pages', () => {
  const html = `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextDataBody())}</script>`;
  const result = parseOlxCapture(
    capture({
      host: 'www.olx.com.lb',
      path: '/en/vehicles/cars-for-sale/',
      url: 'https://www.olx.com.lb/en/vehicles/cars-for-sale/',
      resBody: html,
    }),
  );
  assert.equal(result.items?.[0]?.id, '100000001');
});

test('locale-less listing HTML is ads.search and still parses extraFields.price', () => {
  const html = `<!doctype html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextDataBody())}</script>`;
  const cap = capture({
    host: 'www.olx.com.lb',
    path: '/vehicles/cars-for-sale/q-red-sedan/',
    url: 'https://www.olx.com.lb/vehicles/cars-for-sale/q-red-sedan/',
    resBody: html,
  });
  assert.equal(classifyOlxCapture(cap).operation, 'ads.search');
  const result = parseOlxCapture(cap);
  assert.equal(result.items?.[0]?.id, '100000001');
  assert.match(result.items?.[0]?.text ?? '', /USD 12345/);
});

test('parse never throws on a malformed body', () => {
  assert.deepEqual(parseOlxCapture(capture({ resBody: '{not json' })), {});
  assert.deepEqual(parseOlxCapture(capture({ resBody: 'null' })), {
    workspaces: [{ id: 'olx', adapterId: 'olx', name: 'OLX Lebanon', domain: 'olx.com.lb' }],
    containers: [],
  });
  assert.deepEqual(parseOlxCapture(capture({ resBody: '[]' })), {
    workspaces: [{ id: 'olx', adapterId: 'olx', name: 'OLX Lebanon', domain: 'olx.com.lb' }],
    containers: [],
  });
  assert.doesNotThrow(() => parseOlxCapture(capture({ resBody: '{"children":{"0":1}}' })));
});

test('nextCursors seeds the next listing page and never an empty cursor', () => {
  const first = capture({
    host: 'www.olx.com.lb',
    path: '/_next/data/build/en/vehicles/cars-for-sale.json',
    url: 'https://www.olx.com.lb/_next/data/build/en/vehicles/cars-for-sale.json',
    resBody: JSON.stringify(nextDataBody()),
  });
  const seeds = olxNextCursors(first);
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]?.actionId, 'olx.search.ads');
  assert.equal(seeds[0]?.cursor, '2');
  assert.equal(seeds[0]?.params?.path, 'vehicles/cars-for-sale');

  const last = capture({
    host: 'www.olx.com.lb',
    path: '/_next/data/build/en/vehicles/cars-for-sale.json',
    url: 'https://www.olx.com.lb/_next/data/build/en/vehicles/cars-for-sale.json?page=20',
    resBody: JSON.stringify(nextDataBody()),
  });
  assert.deepEqual(olxNextCursors(last), []);
  assert.deepEqual(olxNextCursors(capture({ resBody: JSON.stringify(CATEGORIES) })), []);
});

test('buildReplayRequest fills listing path/page and refuses a blank ad id', () => {
  const search = olxApp.listReplayActions().find((a) => a.id === 'olx.search.ads');
  assert.ok(search);
  const req = buildOlxReplayRequest(search, { path: 'vehicles/cars-for-sale', page: '2' });
  assert.equal(req.url, 'https://www.olx.com.lb/en/vehicles/cars-for-sale?page=2');
  assert.equal(req.method, 'GET');
  const queried = buildOlxReplayRequest(search, { path: 'vehicles/cars-for-sale', q: 'red sedan' });
  assert.equal(queried.url, 'https://www.olx.com.lb/en/vehicles/cars-for-sale/q-red-sedan');
  // A path that already ends in the query slug is not given a second one.
  const again = buildOlxReplayRequest(search, { path: 'vehicles/cars-for-sale/q-red-sedan', q: 'red sedan' });
  assert.equal(again.url, 'https://www.olx.com.lb/en/vehicles/cars-for-sale/q-red-sedan');

  const ad = olxApp.listReplayActions().find((a) => a.id === 'olx.ad.get');
  assert.ok(ad);
  const adReq = buildOlxReplayRequest(ad, { externalId: '100000001', slug: 'example-coupe-2010' });
  assert.equal(adReq.url, 'https://www.olx.com.lb/en/ad/example-coupe-2010-ID100000001.html');
  assert.throws(() => buildOlxReplayRequest(ad, { slug: 'x' }), /externalId/);
});

test('MCP tools replay through ctx and parse the canned capture', async () => {
  const ctx: AppToolContext = {
    replay: async (req) =>
      makeJsonCapture('api-prod.olx-dubizzle.com', '/api/v1/categories', CATEGORIES, {
        method: 'GET',
        url: req.url,
      }),
  };
  const tools = olxApp.mcpTools?.() ?? [];
  const list = tools.find((t) => t.name === 'olx_list_categories');
  assert.ok(list);
  const out = (await list.run({}, ctx)) as { count: number; categories: Array<{ id: string }> };
  assert.equal(out.count, 2);
  assert.equal(out.categories[0]?.id, 'cat:1');
});

test('olx_search_ads and olx_get_ad build their GETs from the named replay actions', async () => {
  const urls: string[] = [];
  const ctx: AppToolContext = {
    replay: async (req) => {
      urls.push(req.url);
      // What runReplay stores: host and path split from the request url.
      const { host, pathname: path } = new URL(req.url);
      return makeCapture({ method: 'GET', url: req.url, host, path, resBody: JSON.stringify(nextDataBody({ ad: { data: HIT } })) });
    },
  };
  const tools = olxApp.mcpTools?.() ?? [];
  const search = tools.find((t) => t.name === 'olx_search_ads')!;
  const found = (await search.run({ path: 'vehicles/cars-for-sale', q: 'red sedan', page: 2 }, ctx)) as { count: number };
  assert.ok(found.count >= 1);
  const get = tools.find((t) => t.name === 'olx_get_ad')!;
  const ad = (await get.run({ externalId: '100000001', slug: 'example-coupe-2010' }, ctx)) as { id: string };
  assert.equal(ad.id, '100000001');
  assert.deepEqual(urls, [
    'https://www.olx.com.lb/en/vehicles/cars-for-sale/q-red-sedan?page=2',
    'https://www.olx.com.lb/en/ad/example-coupe-2010-ID100000001.html',
  ]);
});

test('an OLX tool run without a host context refuses rather than fetching around the rails', async () => {
  const list = olxApp.mcpTools?.().find((t) => t.name === 'olx_list_categories');
  assert.ok(list);
  await assert.rejects(list.run({}, undefined), /replay pipeline/);
});

const FIXTURES: Capture[] = [
  makeJsonCapture('api-prod.olx-dubizzle.com', '/api/v1/categories', CATEGORIES, { method: 'GET' }),
  makeJsonCapture('api-prod.olx-dubizzle.com', '/api/v1/locations', LOCATIONS, { method: 'GET' }),
  makeJsonCapture('www.olx.com.lb', '/_next/data/build/en/vehicles/cars-for-sale.json', nextDataBody(), {
    method: 'GET',
    url: 'https://www.olx.com.lb/_next/data/build/en/vehicles/cars-for-sale.json?page=1',
  }),
  makeCapture({
    method: 'GET',
    host: 'www.olx.com.lb',
    path: '/en/ad/example-coupe-2010-ID100000001.html',
    url: 'https://www.olx.com.lb/en/ad/example-coupe-2010-ID100000001.html',
    resBody: JSON.stringify({
      pageProps: { initialState: { ad: { data: HIT }, search: { ads: { hits: [] } } } },
    }),
  }),
];

runConformance(olxApp, { fixtures: FIXTURES });
