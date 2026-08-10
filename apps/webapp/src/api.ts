// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin client for the runner's read-only HTTP API.
 *
 * The WebSocket carries the live stream; this carries everything that is too
 * large or too incidental to push — the materialized per-app tables, the derived
 * API map, and a capture body fetched on demand.
 *
 * The bearer token is the same one the socket uses, so it is read from the same
 * place rather than threaded through React.
 */
import type { Capture, Container, Item, Workspace } from '@sluice/core';
import { runnerOrigin, sessionToken } from './ws.js';

async function getJson<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(path, runnerOrigin());
  url.searchParams.set('token', sessionToken());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export interface TableInfo {
  name: string;
  app: string | null;
  rows: number;
  columns: string[];
}

export interface TablePage {
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

export interface ApiMapEndpoint {
  method: string;
  path: string;
  host?: string;
  count?: number;
  [k: string]: unknown;
}

export function listTables(): Promise<{ tables: TableInfo[] }> {
  return getJson('/api/tables');
}

export function fetchTable(name: string, limit: number, offset: number): Promise<TablePage> {
  return getJson(`/api/tables/${encodeURIComponent(name)}`, { limit, offset });
}

export function fetchApiDoc(app?: string): Promise<unknown> {
  return getJson('/api/apidoc', { app });
}

export function fetchCaptureBody(id: string): Promise<{
  id: string;
  reqBody: string | null;
  resBody: string | null;
  reqHeaders: Record<string, string>;
  resHeaders: Record<string, string>;
}> {
  return getJson(`/api/captures/${encodeURIComponent(id)}/body`);
}

/** Entities (items) this capture's parse yielded — the inspector's Entities tab. */
export function fetchCaptureEntities(id: string): Promise<{ items: Item[] }> {
  return getJson(`/api/captures/${encodeURIComponent(id)}/entities`);
}

/**
 * Full-text search over capture bodies, answered by the server's FTS index.
 *
 * The traffic table evaluates every other filter predicate locally, because
 * every other field is on a row it already holds. Bodies are not: the WS
 * backfill is a bounded window, so a `body:` search run against it would answer
 * "matches among the last few thousand captures" while presenting itself as
 * "matches" — a wrong answer that looks like a right one.
 */
export function searchCaptureBodies(
  q: string,
  params: { limit?: number; app?: string; host?: string; tab?: string } = {},
): Promise<{ captures: Capture[]; matched: number; query: string }> {
  return getJson('/api/captures/search', { q, ...params });
}

// ── Normalized entities ─────────────────────────────────────────────────────────

/**
 * The entity reads behind the explorer.
 *
 * Workspaces and containers also arrive over the socket, at subscribe time and
 * on every `entity.upsert` — and are still fetched here, because the socket
 * primes them once and a page opened later needs them without waiting for a
 * capture to arrive. Items are ONLY here: a mailbox holds tens of thousands, and
 * pushing them all down a socket to fill a list showing fifty is the kind of
 * thing that makes a local tool feel like a remote one.
 */
export function fetchWorkspaces(): Promise<{ workspaces: Workspace[] }> {
  return getJson('/api/workspaces');
}

export function fetchContainers(workspaceId?: string): Promise<{ containers: Container[] }> {
  return getJson('/api/containers', { workspaceId });
}

export interface ItemPage {
  items: Item[];
  /** In the CONTAINER, not in this page — what makes "is there more?" answerable. */
  total: number;
  offset: number;
  limit: number;
}

export function fetchItems(containerId: string, limit: number, offset: number): Promise<ItemPage> {
  return getJson('/api/items', { containerId, limit, offset });
}

// ── Storage ─────────────────────────────────────────────────────────────────────

export interface StorageInfo {
  totalBytes: number;
  freeBytes: number;
  tables: Array<{ name: string; bytes: number; rows: number }>;
  captures: { total: number; unattributed: number };
  adapterIds: string[];
}

export function fetchStorage(): Promise<StorageInfo> {
  return getJson('/api/storage');
}
