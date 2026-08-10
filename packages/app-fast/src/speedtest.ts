// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The fast.com speed test — a real, self-contained download measurement.
 *
 * Mirrors how the fast.com web client works (observed from captured traffic):
 *   1. GET https://fast.com/ , find the app bundle (`/app-<hash>.js`) in the HTML,
 *      fetch it, and regex the embedded API token. Fall back to the long-standing
 *      public token if extraction fails.
 *   2. GET https://api.fast.com/netflix/speedtest/v2?https=true&token=<token>&urlCount=5
 *      → { client, targets:[{ url, name, location }] }. Each target `url` is a
 *      Netflix Open Connect (OCA) endpoint of the shape
 *      `https://<oca-host>.nflxvideo.net/speedtest?c=..&n=..&v=..&e=..&t=..`.
 *   3. For a target, download a byte range the way the client does: the `/speedtest`
 *      path becomes `/speedtest/range/0-<bytes-1>`, KEEPING the query params, e.g.
 *      `…/speedtest/range/0-26214399?c=..&n=..&v=..&e=..&t=..`. Stream the body,
 *      count bytes actually received, and time it with two `Date.now()` reads.
 *
 * Nothing here needs credentials — fast.com is anonymous. `globalThis.fetch` and
 * web streams are used (available in Node 20).
 */
import { arr, compact, obj, safeJsonObject, str } from '@sluice/adapter-sdk';
import type { AppToolContext } from '@sluice/core';

/** The long-standing public fast.com token, used when live extraction fails. */
export const FAST_FALLBACK_TOKEN = 'YXNkZmFzZGxmbnNkYWZoYXNkZmhrYWxm';

/** ~25 MiB — matches fast.com's observed `range/0-26214399` (0..26214399 = 26214400 bytes). */
const TARGET_BYTES = 26214400;
/** Per-download hard cap; on trip we keep whatever bytes we already streamed. */
const DOWNLOAD_TIMEOUT_MS = 30000;
/** Short cap for the metadata (token/config) fetches. */
const META_TIMEOUT_MS = 15000;
/** How many targets to measure and average over. */
const MAX_TARGETS = 2;

export interface FastTarget {
  url: string;
  name?: string;
  location?: { city?: string; country?: string };
}

export interface FastConfig {
  client?: {
    ip?: string;
    asn?: string;
    isp?: string;
    location?: { city?: string; country?: string };
  };
  targets?: FastTarget[];
}

export interface SpeedTestResult {
  downloadMbps: number;
  client: {
    ip: string | undefined;
    isp: string | undefined;
    location: { city?: string; country?: string } | undefined;
  };
  targetsTried: number;
  bytes: number;
  ms: number;
}

/** Turn an OCA target url into its ranged-download url, keeping the query params. */
export function rangeUrl(targetUrl: string, bytes = TARGET_BYTES): string {
  const u = new URL(targetUrl);
  // `/speedtest` → `/speedtest/range/0-<bytes-1>`; query (c,n,v,e,t) is preserved.
  u.pathname = `${u.pathname}/range/0-${bytes - 1}`;
  return u.toString();
}

/** Fetch the fast.com API token from the site's app bundle, or fall back. */
export async function fetchToken(): Promise<string> {
  try {
    const homeRes = await fetch('https://fast.com/', { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
    const html = await homeRes.text();
    const jsMatch = /\/(app-[^"'/\s]+\.js)/.exec(html);
    if (!jsMatch?.[1]) return FAST_FALLBACK_TOKEN;
    const jsRes = await fetch(`https://fast.com/${jsMatch[1]}`, {
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    });
    const js = await jsRes.text();
    const tokenMatch = /token:"([^"]+)"/.exec(js);
    return tokenMatch?.[1] ?? FAST_FALLBACK_TOKEN;
  } catch {
    return FAST_FALLBACK_TOKEN;
  }
}

/** The api.fast.com config URL for a token (the same call the replay action issues). */
export function configUrl(token: string): string {
  const u = new URL('https://api.fast.com/netflix/speedtest/v2');
  u.searchParams.set('https', 'true');
  u.searchParams.set('token', token);
  u.searchParams.set('urlCount', '5');
  return u.toString();
}

/** The `{city,country}` pair both `client` and a target carry, or undefined. */
function toPlace(v: unknown): { city?: string; country?: string } | undefined {
  const o = obj(v);
  return o ? compact({ city: str(o.city), country: str(o.country) }) : undefined;
}

/**
 * A config body as a FastConfig, or a throw that says what was wrong with it.
 *
 * Regression: `JSON.parse(body ?? 'null') as FastConfig` was a cast nothing
 * checked, and `runReplay` falsifies it routinely — it records `resBody: null`
 * whenever `res.text()` rejects, e.g. the connection drops mid-body — so a 200
 * returned `null` here and `runSpeedTest` read `.targets` off it OUTSIDE the try
 * that exists to turn a bad config into a message. Coercing instead of casting
 * makes the declared shape true for every caller: `targets` really is an array,
 * and every target in it really does have a url.
 */
function toFastConfig(body: string | null): FastConfig {
  const parsed = safeJsonObject(body);
  if (!parsed) throw new Error('fast.com config returned a non-JSON body');
  const client = obj(parsed.client);
  const targets: FastTarget[] = [];
  for (const raw of arr(parsed.targets) ?? []) {
    const t = obj(raw);
    const url = str(t?.url);
    if (!url) continue;
    targets.push(compact({ url, name: str(t?.name), location: toPlace(t?.location) }));
  }
  return {
    client: compact({
      ip: str(client?.ip),
      asn: str(client?.asn),
      isp: str(client?.isp),
      location: toPlace(client?.location),
    }),
    targets,
  };
}

/**
 * Fetch the fast.com target config (client info + CDN targets) for a token.
 *
 * With an MCP tool context, this goes through the shared replay pipeline so the
 * call is recorded as a Capture and the adapter parses its CDN targets into
 * Containers — the same treatment `sluice_replay` gets. Without one it falls
 * back to a plain fetch for direct library use.
 */
export async function fetchConfig(token: string, ctx?: AppToolContext): Promise<FastConfig> {
  if (ctx) {
    const capture = await ctx.replay({ method: 'GET', url: configUrl(token), headers: {} });
    if (capture.status === null || capture.status >= 400) {
      throw new Error(`fast.com config request failed with HTTP ${capture.status ?? 'error'}`);
    }
    return toFastConfig(capture.resBody);
  }
  const res = await fetch(configUrl(token), { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fast.com config request failed with HTTP ${res.status}`);
  // `res.json()` here would reject with the runtime's own parser message; the
  // text path routes a bad body through the same wording as the replay branch.
  return toFastConfig(await res.text());
}

/** Download one target's range, streaming and counting bytes; abort-tolerant. */
export async function measureDownload(targetUrl: string): Promise<{ bytes: number; ms: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const start = Date.now();
  let bytes = 0;
  try {
    const res = await fetch(rangeUrl(targetUrl), { signal: controller.signal });
    if (!res.ok) throw new Error(`OCA download failed with HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) bytes += value.byteLength;
        }
      } catch {
        // Aborted by the timeout cap (or a stream hiccup) — keep the bytes read.
      }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer()).byteLength;
    }
  } finally {
    clearTimeout(timer);
  }
  return { bytes, ms: Date.now() - start };
}

/**
 * Run the full speed test: token → config → measure up to {@link MAX_TARGETS}
 * targets, and report the aggregate download throughput in Mbps. Throws with a
 * clear message if nothing could be measured.
 */
export async function runSpeedTest(ctx?: AppToolContext): Promise<SpeedTestResult> {
  const token = await fetchToken();

  let cfg: FastConfig;
  try {
    // Only the metadata call is recorded. The range downloads below deliberately
    // stay a bare fetch: they are tens of megabytes of throwaway bytes whose whole
    // purpose is to be timed, and routing them through the capture store would
    // put 25 MiB bodies in SQLite for no analytical value.
    cfg = await fetchConfig(token, ctx);
  } catch (e) {
    throw new Error(`Could not fetch fast.com config: ${e instanceof Error ? e.message : String(e)}`);
  }

  // `fetchConfig` already dropped every target without a usable url and
  // guarantees an array; the filter that used to stand here was itself a
  // `?? []` on a field the service is free to send as something else.
  const targets = cfg.targets ?? [];
  if (targets.length === 0) throw new Error('fast.com returned no download targets.');

  let totalBytes = 0;
  let totalMs = 0;
  let targetsTried = 0;
  const failures: string[] = [];

  for (const target of targets.slice(0, MAX_TARGETS)) {
    try {
      const { bytes, ms } = await measureDownload(target.url);
      if (bytes > 0 && ms > 0) {
        totalBytes += bytes;
        totalMs += ms;
        targetsTried += 1;
      } else {
        failures.push(`${bytes} bytes in ${ms}ms from ${new URL(target.url).host}`);
      }
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (targetsTried === 0) {
    throw new Error(`No download target could be measured. ${failures.join('; ')}`.trim());
  }

  // Sequential downloads: aggregate throughput = total bits / total seconds.
  const mbps = (totalBytes * 8) / ((totalMs / 1000) * 1e6);

  return {
    downloadMbps: Number(mbps.toFixed(1)),
    client: {
      ip: cfg.client?.ip,
      isp: cfg.client?.isp,
      location: cfg.client?.location,
    },
    targetsTried,
    bytes: totalBytes,
    ms: totalMs,
  };
}
