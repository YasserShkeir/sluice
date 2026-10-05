// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin client for the runner's read-only HTTP API (GET only; every mutation
 * goes over the WebSocket).
 *
 * The WebSocket carries the live stream; this carries everything that is too
 * large or too incidental to push — the materialized per-app tables, the derived
 * API map, and a capture body fetched on demand.
 *
 * The bearer token is the same session token the socket uses (full dashboard
 * control, not read-only), so it is read from the same place rather than
 * threaded through React, and sent as an `Authorization` header.
 */
import type {
  Capture,
  Container,
  FlowStepSummary,
  FlowSummary as CoreFlowSummary,
  FlowTemplateStepSummary,
  FlowTemplateSummary as CoreTemplateSummary,
  Item,
  Workspace,
} from '@sluice/core';
import { runnerOrigin, sessionToken } from './ws.js';

async function getJson<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(path, runnerOrigin());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  // A header, not `?token=`: a query string lands in server logs, history and
  // devtools exports, and this token is full dashboard control.
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${sessionToken()}` } });
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
  rows: number;
  columns: string[];
}

export interface TablePage {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total: number;
}

/**
 * Narrowed mirror of @sluice/cartographer's ApiEndpoint/ApiMap — the webapp
 * cannot depend on cartographer. Only what the catalog renders.
 */
export interface ApiEndpoint {
  key: string;
  method: string;
  path: string;
  hosts: string[];
  statuses: number[];
  requestParams: string[];
  sampleCount: number;
}

export interface ApiMap {
  endpoints?: ApiEndpoint[];
}

export function listTables(): Promise<{ tables: TableInfo[] }> {
  return getJson('/api/tables');
}

export function fetchTable(name: string, limit: number, offset: number): Promise<TablePage> {
  return getJson(`/api/tables/${encodeURIComponent(name)}`, { limit, offset });
}

export function fetchApiDoc(app?: string): Promise<ApiMap> {
  return getJson('/api/apidoc', { app });
}

export function fetchCaptureBody(id: string): Promise<{
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

/** Full-text search over capture bodies via the server's FTS index (the client window is partial; see filter.ts serverSideTerms). */
export function searchCaptureBodies(
  q: string,
  params: { limit?: number; app?: string; host?: string; tab?: string } = {},
): Promise<{ captures: Capture[]; matched: number; query: string }> {
  return getJson('/api/captures/search', { q, ...params });
}

/**
 * Hydrate specific captures by id (flow members outside the live WS ring).
 * Server caps at 500 ids; empty input short-circuits.
 */
export function fetchCapturesByIds(ids: string[]): Promise<{ captures: Capture[]; total: number }> {
  if (ids.length === 0) return Promise.resolve({ captures: [], total: 0 });
  // Comma-joined; ids are store uuids without commas.
  return getJson('/api/captures', { ids: ids.slice(0, 500).join(','), limit: Math.min(ids.length, 500) });
}

// ── Normalized entities ─────────────────────────────────────────────────────────

/** Structure for the explorer, fetched over HTTP. Items are only ever paged here,
 *  never pushed down the socket. */
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

// ── Interaction flows ───────────────────────────────────────────────────────────

/** What /api/flows and /api/flow-templates return: core's secret-free summaries plus their steps. */
export type FlowSummary = CoreFlowSummary & { steps?: FlowStepSummary[] };
export type FlowTemplateSummary = CoreTemplateSummary & { steps?: FlowTemplateStepSummary[] };

export function fetchFlows(params: { app?: string; limit?: number } = {}): Promise<{ flows: FlowSummary[] }> {
  return getJson('/api/flows', params);
}

export function fetchFlowTemplates(params: { app?: string; limit?: number } = {}): Promise<{ templates: FlowTemplateSummary[] }> {
  return getJson('/api/flow-templates', params);
}
