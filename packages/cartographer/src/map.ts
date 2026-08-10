// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The endpoint catalog. `buildApiMap` groups every capture by
 * `method + normalized path`, and for each group records the observed request
 * param *names*, a merged response JSON schema, the union of response header
 * *names*, the status codes seen, and a sample count.
 *
 * Only names are ever collected — never a param value or a header value — so the
 * catalog cannot carry a secret.
 */
import type { Capture, SqliteStore } from '@sluice/core';
import { inferJsonSchema } from './infer.js';
import type { JsonSchema } from './infer.js';
import { headerValue, parseJsonValue } from './util.js';

export interface ApiEndpoint {
  /** `${method} ${path}`, the group key */
  key: string;
  method: string;
  /** normalized path with id-like segments collapsed to `{id}` */
  path: string;
  /** sorted union of request param names (query string + urlencoded body keys) */
  requestParams: string[];
  /** merged, recursive schema of all response bodies seen for this endpoint */
  responseSchema: JsonSchema;
  /** sorted union of response header names (lowercased) */
  responseHeaders: string[];
  /** sorted unique HTTP status codes observed */
  statuses: number[];
  /** distinct hosts this endpoint was observed on */
  hosts: string[];
  /** how many captures fed this endpoint */
  sampleCount: number;
}

export interface ApiMap {
  endpoints: ApiEndpoint[];
  /** epoch ms the map was built */
  generatedAt: number;
}

/** A generous ceiling so we read every capture, mirroring the runner's export path. */
const ALL = 1_000_000;

/** Does a path segment look like an id we should collapse to `{id}`? */
export function isIdLikeSegment(seg: string): boolean {
  if (seg.length === 0) return false;
  if (/^\d{5,}$/.test(seg)) return true; // pure numeric id (5+ digits; keeps version tags like /1/, /2/)
  if (/^\d[\d.]+\d$/.test(seg)) return true; // decimal / timestamp id (e.g. 1700000000.001500)
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) {
    return true; // uuid
  }
  if (/^[0-9a-fA-F]{12,}$/.test(seg)) return true; // long hex blob
  // mixed alphanumeric opaque id (Slack C0123ABC, base62 ids, …) — needs a digit
  if (seg.length >= 8 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg)) {
    return true;
  }
  return false;
}

/** Collapse id-like path segments so `/users/123/profile` groups with `/users/456/profile`. */
export function normalizePath(path: string): string {
  const clean = path.split('?')[0] ?? path;
  return clean
    .split('/')
    .map((seg) => (isIdLikeSegment(seg) ? '{id}' : seg))
    .join('/');
}

/** Should this request body be parsed as `application/x-www-form-urlencoded`? */
function looksUrlEncoded(capture: Capture, body: string): boolean {
  const ct = headerValue(capture.reqHeaders, 'content-type');
  if (ct) {
    if (ct.includes('application/x-www-form-urlencoded')) return true;
    if (ct.includes('application/json') || ct.includes('multipart/form-data')) return false;
  }
  const head = body.trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return false;
  return body.includes('=');
}

/** Collect request param *names* from the query string and any urlencoded body. */
export function requestParamNames(capture: Capture): string[] {
  const names = new Set<string>();
  try {
    for (const key of new URL(capture.url).searchParams.keys()) names.add(key);
  } catch {
    /* malformed url — ignore */
  }
  const body = capture.reqBody;
  if (body && looksUrlEncoded(capture, body)) {
    for (const [key] of new URLSearchParams(body)) names.add(key);
  }
  return [...names];
}

interface EndpointAcc {
  method: string;
  path: string;
  params: Set<string>;
  headers: Set<string>;
  statuses: Set<number>;
  hosts: Set<string>;
  bodies: unknown[];
  sampleCount: number;
}

export interface ApiMapOptions {
  /** only include captures whose host contains one of these substrings (case-insensitive) */
  hostContains?: string[];
  /** only include captures with this adapterId (the owning app) */
  adapterId?: string;
}

/** Build the endpoint catalog, optionally scoped to one app's hosts / adapter. */
export function buildApiMap(store: SqliteStore, opts: ApiMapOptions = {}): ApiMap {
  const captures = store.listCaptures({ limit: ALL });
  const needles = (opts.hostContains ?? []).map((s) => s.toLowerCase());
  const groups = new Map<string, EndpointAcc>();

  for (const c of captures) {
    if (opts.adapterId !== undefined && c.adapterId !== opts.adapterId) continue;
    if (needles.length > 0 && !needles.some((n) => c.host.toLowerCase().includes(n))) continue;

    const method = c.method.toUpperCase();
    const path = normalizePath(c.path);
    const key = `${method} ${path}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        method,
        path,
        params: new Set(),
        headers: new Set(),
        statuses: new Set(),
        hosts: new Set(),
        bodies: [],
        sampleCount: 0,
      };
      groups.set(key, g);
    }
    g.sampleCount++;
    g.hosts.add(c.host);
    if (c.status !== null) g.statuses.add(c.status);
    for (const h of Object.keys(c.resHeaders)) g.headers.add(h.toLowerCase());
    for (const p of requestParamNames(c)) g.params.add(p);
    const body = parseJsonValue(c.resBody);
    if (body !== undefined) g.bodies.push(body);
  }

  const endpoints: ApiEndpoint[] = [];
  for (const [key, g] of groups) {
    endpoints.push({
      key,
      method: g.method,
      path: g.path,
      requestParams: [...g.params].sort(),
      responseHeaders: [...g.headers].sort(),
      statuses: [...g.statuses].sort((a, b) => a - b),
      hosts: [...g.hosts].sort(),
      sampleCount: g.sampleCount,
      responseSchema: inferJsonSchema(g.bodies),
    });
  }
  endpoints.sort((a, b) => a.key.localeCompare(b.key));
  return { endpoints, generatedAt: Date.now() };
}
