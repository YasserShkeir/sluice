// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-fast — the self-contained Fast.com app.
 *
 * Fast.com (Netflix's Open Connect speed test) needs no authentication, so this
 * app has NO `credentials` provider. It contributes:
 *   - an adapter that claims fast.com / api.fast.com / *.nflxvideo.net traffic,
 *   - a parser that turns an api.fast.com config response into Containers (the
 *     CDN targets), so captured runs show up as normalized entities,
 *   - a classifier that names each exchange and marks the ~25 MiB OCA range
 *     downloads `binary`, so a recorder can refuse to store them mechanically,
 *   - one replay action (`fast.speedtest.config`) that re-issues the config call,
 *   - one MCP tool (`fast_speed_test`) that runs a real download speed test.
 *
 * It is also the deliberate DEGENERATE adapter: no credentials, no pagination,
 * four endpoints total. The contract has to tolerate that, and this package is
 * where "tolerates it" is demonstrated rather than assumed.
 *
 * The primary export is `fastApp: App`.
 */
import { arr, obj, safeJson, str } from '@sluice/adapter-sdk';
import type {
  App,
  AppMcpTool,
  AppRedaction,
  Capture,
  CaptureClass,
  Container,
  CursorSeed,
  ParseResult,
  ReplayAction,
  ReplayRequest,
  Workspace,
} from '@sluice/core';
import { FAST_FALLBACK_TOKEN, configUrl, runSpeedTest } from './speedtest.js';

export const ADAPTER_ID = 'fast';
const WORKSPACE_ID = 'fast';

/**
 * The one workspace every target lives in. Emitted beside its containers because
 * nothing else ever creates it: there is no credentials provider to seed it, and
 * a reader that walks workspaces first never reaches an orphaned container.
 */
const FAST_WORKSPACE: Workspace = {
  id: WORKSPACE_ID,
  adapterId: ADAPTER_ID,
  name: 'fast.com',
  domain: 'fast.com',
};

// ── Matching ─────────────────────────────────────────────────────────────────────

/** Every fixed hostname fast.com serves from; the OCA fleet is a wildcard, below. */
const FAST_HOSTS = new Set(['fast.com', 'api.fast.com', 'nflxvideo.net']);

/**
 * Only the OCA fleet is genuinely a wildcard — every range download comes from a
 * per-POP hostname like `ipv4-c001.lhr001.ix.nflxvideo.net`. The leading dot is
 * load-bearing: a bare `endsWith('nflxvideo.net')` also accepts `notnflxvideo.net`.
 */
function matchesFast(host: string): boolean {
  return FAST_HOSTS.has(host) || host.endsWith('.nflxvideo.net');
}

// ── Classification ───────────────────────────────────────────────────────────────

/** The exact ranged URL `rangeUrl()` builds, e.g. `/speedtest/range/0-26214399`. */
const OCA_RANGE_PATH = /\/speedtest\/range\/\d+-\d+$/;
/** The hashed bundle `fetchToken()` scrapes the API token out of, e.g. `/app-a1b2c3.js`. */
const APP_BUNDLE_PATH = /^\/app-[^/]+\.js$/;

/** What an exchange DOES, named the same way whether it succeeded or failed. */
function fastOperation(capture: Capture): string | undefined {
  if (capture.host === 'api.fast.com' && capture.path.startsWith('/netflix/speedtest')) {
    return 'speedtest.config';
  }
  if (capture.host.endsWith('.nflxvideo.net') && OCA_RANGE_PATH.test(capture.path)) {
    return 'speedtest.range';
  }
  // The site itself, as distinct from its JSON API on api.fast.com. Both paths
  // are here because both are token-scrape sources for `fetchToken()`.
  if (capture.host === 'fast.com') {
    if (APP_BUNDLE_PATH.test(capture.path)) return 'app.bundle';
    if (capture.path === '/') return 'app.shell';
  }
  return undefined;
}

/**
 * What kind of exchange this is, without parsing it. Total by construction — it
 * reads only the url triple and the status code, and never touches a body, so
 * there is no shape a service can send that makes it throw.
 *
 * An OCA range download is ~25 MiB of throwaway bytes whose only purpose is to be
 * timed, so it is classed `binary` to keep it out of the capture store. It is scoped
 * to the exact ranged path rather than to the whole OCA host because dropping a
 * capture is lossy, and under-claiming is the recoverable mistake.
 *
 * Status is decided first: a 4xx on the config endpoint carries an error body,
 * not a config, and calling that `structure` is precisely what makes `parse()`
 * go looking for CDN targets in a rejection.
 */
export function classifyFastCapture(capture: Capture): { class: CaptureClass; operation?: string } {
  const operation = fastOperation(capture);
  if (typeof capture.status === 'number' && capture.status >= 400) return { class: 'error', operation };
  const hasBody = typeof capture.resBody === 'string' && capture.resBody.length > 0;
  if (operation === 'speedtest.config' && hasBody) return { class: 'structure', operation };
  if (operation === 'speedtest.range') return { class: 'binary', operation };
  if (operation === 'app.shell' || operation === 'app.bundle') return { class: 'asset', operation };
  // Includes a config call with no response body: still named `speedtest.config`
  // for the traffic table, but not `structure`, because there is nothing to parse.
  return { class: 'unknown', operation };
}

// ── Pagination (there is none) ───────────────────────────────────────────────────

/**
 * Always `[]`. fast.com has no pagination anywhere in it.
 *
 * `urlCount=5` on the config call reads like a page size and is not one: it is a
 * fan-out COUNT the server honours once, and the response carries no token,
 * offset or has-more flag to continue from. There is no second page to seed.
 *
 * Implemented rather than omitted so readers can tell "nothing to paginate" from "not written yet".
 */
export function fastNextCursors(): CursorSeed[] {
  return [];
}

// ── Parser ───────────────────────────────────────────────────────────────────────

/**
 * Turn an `api.fast.com /netflix/speedtest/v2` response into Containers — one per
 * CDN target. Anything else (the fast.com HTML, the OCA range downloads, a
 * malformed body) yields an empty ParseResult.
 */
export function parseFastCapture(capture: Capture): ParseResult {
  if (classifyFastCapture(capture).class !== 'structure') return {};
  // Not JSON returns the empty result. arr() rather than ?? []: a present-but-non-array
  // `targets` (a map keyed by index) would throw in for...of.
  const body = safeJson(capture.resBody);
  if (body === undefined) return {};
  const containers: Container[] = [];
  for (const target of arr(obj(body)?.targets) ?? []) {
    const t = obj(target);
    const url = str(t?.url);
    if (!url) continue;
    const name = `${str(obj(t?.location)?.city) ?? ''} ${str(t?.name) ?? ''}`.trim();
    containers.push({
      id: url,
      workspaceId: WORKSPACE_ID,
      adapterId: ADAPTER_ID,
      kind: 'other',
      name,
      raw: t,
    });
  }
  return containers.length > 0 ? { workspaces: [FAST_WORKSPACE], containers } : { containers };
}

// ── Replay ───────────────────────────────────────────────────────────────────────

const FAST_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'fast.speedtest.config',
    adapterId: ADAPTER_ID,
    label: 'Fast.com speedtest config',
    method: 'GET',
    urlTemplate: 'https://api.fast.com/netflix/speedtest/v2',
    params: [{ name: 'token', label: 'API token', kind: 'string' }],
  },
];

/** GET the config URL. No credentials — the session argument is ignored. */
function buildReplayRequest(action: ReplayAction, params: Record<string, string>): ReplayRequest {
  return { method: action.method, url: configUrl(params.token || FAST_FALLBACK_TOKEN), headers: {} };
}

// ── MCP tool ───────────────────────────────────────────────────────────────────────

const fastMcpTools: AppMcpTool[] = [
  {
    name: 'fast_speed_test',
    description:
      'Run an internet speed test via fast.com (Netflix Open Connect): fetch the config, download a range from a CDN target, report Mbps.',
    run: (_args, ctx) => runSpeedTest(ctx),
  },
];

// ── Redaction ────────────────────────────────────────────────────────────────────

/**
 * fast.com's `token` query param is PUBLIC — it is served in the page's own JS
 * bundle to anyone who loads fast.com, and the speedtest API rejects a request
 * without it. The generic redactor masks any `token=…`. Declaring it public keeps
 * the capture faithful; there is no secret here to protect.
 */
const fastRedaction: AppRedaction = {
  publicParams: [{ hosts: ['fast.com', 'nflxvideo.net'], params: ['token'] }],
};

// ── The app ──────────────────────────────────────────────────────────────────────

/** The one installed Fast.com app: a credential-free adapter with an MCP tool. */
export const fastApp: App = {
  id: ADAPTER_ID,
  displayName: 'Fast.com',
  hosts: ['fast.com', 'api.fast.com', 'nflxvideo.net'],
  matchRequest: (input) => matchesFast(input.host),
  parse: parseFastCapture,
  classify: classifyFastCapture,
  nextCursors: fastNextCursors,
  listReplayActions: () => FAST_REPLAY_ACTIONS,
  buildReplayRequest,
  mcpTools: () => fastMcpTools,
  redaction: fastRedaction,
};
