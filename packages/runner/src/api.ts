// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The read-only HTTP API over the capture store.
 *
 * Everything the dashboard needs beyond the live WebSocket stream lives here:
 * paginated history, entity listings, the derived API map, and — the reason this
 * exists at all — the per-app tables the Cartographer materializes, which until
 * now were written on every capture and never readable outside `sqlite3`.
 *
 * Design rules, all of which follow from "this is loopback-only but still
 * exposed to a browser":
 *   - GET only. Nothing here mutates; state changes go over the WebSocket where
 *     the replay safety rails apply.
 *   - Same bearer token as the WS upgrade, and the same loopback Origin check.
 *   - Table and column names are validated against sqlite_master before they are
 *     interpolated. They cannot be parameterised in SQL, so an allowlist built
 *     from the live schema is the only safe way to accept them from a client.
 *   - Responses are already-redacted store rows; nothing re-derives a secret.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SqliteStore } from '@sluice/core';
import { buildApiMap, renderMarkdown } from '@sluice/cartographer';

/** Hard ceiling on any page size, so a client cannot ask for the whole store. */
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

export interface ApiDeps {
  store: SqliteStore;
  /** Adapter ids + display names, for `/api/adapters`. */
  adapters: Array<{ id: string; displayName: string }>;
  /** Engine status snapshot, or undefined when no engine is running. */
  engineStatus: () => unknown;
  appVersion: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function intParam(u: URL, name: string, fallback: number, max = MAX_LIMIT): number {
  const raw = u.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * Every table the Cartographer has materialized, as a fresh allowlist.
 *
 * Read from sqlite_master on each call rather than cached: materialize runs
 * continuously during capture, so a cached list would go stale exactly when the
 * user is watching new tables appear. It is one cheap indexed query.
 */
function materializedTables(store: SqliteStore, adapterIds: string[]): string[] {
  const rows = store.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as Array<{ name: string }>;
  const prefixes = adapterIds.map((id) => `${id}_`);
  return rows
    .map((r) => r.name)
    .filter((n) => prefixes.some((p) => n.startsWith(p)));
}

/** Column names of a table, used to validate an `orderBy`. */
function columnsOf(store: SqliteStore, table: string): string[] {
  return (store.db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{
    name: string;
  }>).map((r) => r.name);
}

/**
 * Handle a `/api/*` request. Returns true when it took the request, false when
 * the caller should fall through to static file serving.
 *
 * The caller is responsible for auth — this is only reached once the bearer
 * token and Origin have been checked.
 */
export function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ApiDeps): boolean {
  const { store } = deps;
  if (!url.pathname.startsWith('/api/')) return false;

  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed', detail: 'The API is read-only.' });
    return true;
  }

  const path = url.pathname;

  try {
    // ── status ────────────────────────────────────────────────────────────────
    if (path === '/api/status') {
      json(res, 200, {
        appVersion: deps.appVersion,
        captures: store.countCaptures(),
        workspaces: store.listWorkspaces().length,
        containers: store.listContainers().length,
        engine: deps.engineStatus(),
      });
      return true;
    }

    // ── storage ─────────────────────────────────────────────────────────────
    // A read, so it honours the GET-only rule; the data-management OPERATIONS are
    // mutations and go over the WebSocket (data.*).
    if (path === '/api/storage') {
      const stats = store.storageStats();
      // The one partition worth calling out: pre-scoping noise no adapter claimed.
      const unattributed = store.countCaptures({ unattributed: true });
      json(res, 200, {
        totalBytes: stats.totalBytes,
        freeBytes: stats.freeBytes,
        tables: stats.tables,
        captures: { total: store.countCaptures(), unattributed },
        // Which tables are DERIVED (rebuildable) vs core evidence — so the panel
        // can show "safe to drop" against "your only copy". A materialized table
        // is any adapter-prefixed one; the FTS shadows are derived too.
        adapterIds: deps.adapters.map((a) => a.id),
      });
      return true;
    }

    if (path === '/api/adapters') {
      json(res, 200, { adapters: deps.adapters });
      return true;
    }

    // ── captures ──────────────────────────────────────────────────────────────
    if (path === '/api/captures') {
      const idsRaw = url.searchParams.get('ids');
      const ids = idsRaw
        ? idsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 500)
        : undefined;
      const captures = store.listCaptures({
        limit: intParam(url, 'limit', DEFAULT_LIMIT),
        adapterId: url.searchParams.get('app') ?? undefined,
        host: url.searchParams.get('host') ?? undefined,
        tabId: url.searchParams.get('tab') ?? undefined,
        sinceTs: url.searchParams.has('since') ? intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER) : undefined,
        ids: ids && ids.length > 0 ? ids : undefined,
      });
      json(res, 200, { captures, total: store.countCaptures() });
      return true;
    }

    /**
     * Full-text search over capture BODIES.
     *
     * The traffic table can filter everything else itself, because every other
     * field is on the row it already holds. Bodies are different: the WS backfill
     * is a bounded window, so answering `body:"not_in_channel"` from what the
     * client has silently answers a narrower question than the one asked —
     * "matches in the last N captures" presented as "matches".
     *
     * Backed by the FTS5 index, so this is an index lookup rather than a scan
     * over every stored body.
     */
    if (path === '/api/captures/search') {
      const q = url.searchParams.get('q') ?? '';
      const captures = store.searchCaptures(q, {
        limit: intParam(url, 'limit', DEFAULT_LIMIT),
        adapterId: url.searchParams.get('app') ?? undefined,
        host: url.searchParams.get('host') ?? undefined,
        tabId: url.searchParams.get('tab') ?? undefined,
      });
      // `matched` rather than `total`: it is the count for THIS query, and
      // reusing the /api/captures field name would read as the store's size.
      json(res, 200, { captures, matched: captures.length, query: q });
      return true;
    }

    const capBody = /^\/api\/captures\/([^/]+)\/body$/.exec(path);
    if (capBody) {
      const capture = store.getCapture(decodeURIComponent(capBody[1] ?? ''));
      if (!capture) {
        json(res, 404, { error: 'not_found' });
        return true;
      }
      // Bodies are the expensive part of a capture, which is why the WS backfill
      // no longer ships them — this is where the inspector fetches one on demand.
      json(res, 200, {
        id: capture.id,
        reqBody: capture.reqBody,
        resBody: capture.resBody,
        reqHeaders: capture.reqHeaders,
        resHeaders: capture.resHeaders,
      });
      return true;
    }

    // Entities this capture's parse yielded — the inspector's Entities tab. A
    // bounded lookup (items are the only capture-linked entity today), returned
    // already-redacted like every other store row.
    const capEntities = /^\/api\/captures\/([^/]+)\/entities$/.exec(path);
    if (capEntities) {
      const id = decodeURIComponent(capEntities[1] ?? '');
      const items = store.itemsForCapture(id, intParam(url, 'limit', 200));
      json(res, 200, { items });
      return true;
    }

    // ── entities ──────────────────────────────────────────────────────────────
    if (path === '/api/sessions') {
      // RedactedSession only — credential KIND names, never a value. The store has
      // nowhere to put a secret, so there is nothing here that could leak one.
      json(res, 200, { sessions: store.listSessions() });
      return true;
    }
    if (path === '/api/workspaces') {
      json(res, 200, { workspaces: store.listWorkspaces() });
      return true;
    }
    if (path === '/api/containers') {
      json(res, 200, {
        containers: store.listContainers(url.searchParams.get('workspaceId') ?? undefined),
      });
      return true;
    }
    if (path === '/api/actors') {
      json(res, 200, { actors: store.listActors(url.searchParams.get('workspaceId') ?? undefined) });
      return true;
    }
    if (path === '/api/items') {
      const containerId = url.searchParams.get('containerId');
      if (!containerId) {
        json(res, 400, { error: 'bad_request', detail: 'containerId is required' });
        return true;
      }
      const limit = intParam(url, 'limit', 200);
      const offset = intParam(url, 'offset', 0);
      json(res, 200, {
        items: store.listItems(containerId, { limit, offset }),
        // Total in the CONTAINER, not in the page — a reader walking with
        // `offset` has no other way to know whether it has reached the end, and
        // "the page came back short" is a guess that is wrong on an exact
        // multiple of the page size.
        total: store.countItems({ containerId }),
        offset,
        limit,
      });
      return true;
    }

    // ── interaction flows + learned templates (secret-free summaries) ────────
    if (path === '/api/flows') {
      const source = url.searchParams.get('source') ?? undefined;
      const flows = store
        .listFlows({
          adapterId: url.searchParams.get('app') ?? undefined,
          source: source as 'observed' | 'pinned' | 'replay' | 'learned' | undefined,
          q: url.searchParams.get('q') ?? undefined,
          limit: intParam(url, 'limit', 100),
        })
        .map((f) => ({
          id: f.id,
          adapterId: f.adapterId,
          label: f.label,
          source: f.source,
          primaryCaptureId: f.primaryCaptureId,
          primaryOp:
            f.steps.find((s) => s.captureId === f.primaryCaptureId)?.operation ??
            f.steps.find((s) => s.role === 'primary')?.operation,
          stepCount: f.steps.length,
          startedAt: f.startedAt,
          endedAt: f.endedAt,
          steps: f.steps.map((s) => ({
            seq: s.seq,
            role: s.role,
            operation: s.operation,
            required: s.required,
            captureId: s.captureId,
          })),
        }));
      json(res, 200, { flows });
      return true;
    }

    if (path === '/api/flow-templates') {
      const templates = store
        .listFlowTemplates({
          adapterId: url.searchParams.get('app') ?? undefined,
          primaryKey: url.searchParams.get('primaryKey') ?? undefined,
          q: url.searchParams.get('q') ?? undefined,
          limit: intParam(url, 'limit', 100),
        })
        .map((t) => ({
          id: t.id,
          adapterId: t.adapterId,
          primaryKey: t.primaryKey,
          label: t.label,
          sampleCount: t.sampleCount,
          stepCount: t.steps.length,
          flowParams: t.flowParams,
          learnedAt: t.learnedAt,
          version: t.version,
          steps: t.steps.map((s) => ({
            seq: s.seq,
            role: s.role,
            method: s.method,
            path: s.path,
            operation: s.operation,
            required: s.required,
            support: s.support,
            delayMsP50: s.delayMsP50,
            offsetFromPrimaryMsP50: s.offsetFromPrimaryMsP50,
            offsetSpreadMs: s.offsetSpreadMs,
            unreproducible: s.unreproducible || undefined,
            paramKinds: s.params
              ? Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, v.kind]))
              : undefined,
          })),
        }));
      json(res, 200, { templates });
      return true;
    }

    // ── the derived API map ───────────────────────────────────────────────────
    if (path === '/api/apidoc') {
      const hostParam = url.searchParams.get('host');
      const map = buildApiMap(store, {
        hostContains: hostParam ? hostParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        adapterId: url.searchParams.get('app') ?? undefined,
      });
      if (url.searchParams.get('format') === 'markdown') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(renderMarkdown(map));
        return true;
      }
      json(res, 200, map);
      return true;
    }

    // ── materialized per-app tables ───────────────────────────────────────────
    if (path === '/api/tables') {
      const adapterIds = deps.adapters.map((a) => a.id);
      const names = materializedTables(store, adapterIds);
      const tables = names.map((name) => ({
        name,
        app: adapterIds.find((id) => name.startsWith(`${id}_`)) ?? null,
        rows: (store.db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(name)}`).get() as { n: number }).n,
        columns: columnsOf(store, name),
      }));
      json(res, 200, { tables });
      return true;
    }

    const tableRows = /^\/api\/tables\/([^/]+)$/.exec(path);
    if (tableRows) {
      const requested = decodeURIComponent(tableRows[1] ?? '');
      const allowed = materializedTables(store, deps.adapters.map((a) => a.id));
      // A table name cannot be a bound parameter, so it is only ever interpolated
      // after an exact match against the live schema.
      if (!allowed.includes(requested)) {
        json(res, 404, { error: 'unknown_table', detail: 'Not a materialized per-app table.' });
        return true;
      }
      const limit = intParam(url, 'limit', DEFAULT_LIMIT);
      const offset = intParam(url, 'offset', 0, Number.MAX_SAFE_INTEGER);

      // Same rule for the sort column: validated against the table's real columns.
      const orderBy = url.searchParams.get('orderBy');
      const cols = columnsOf(store, requested);
      const order = orderBy && cols.includes(orderBy) ? ` ORDER BY ${JSON.stringify(orderBy)}` : '';
      const dir = url.searchParams.get('dir') === 'desc' ? ' DESC' : '';

      const rows = store.db
        .prepare(`SELECT * FROM ${JSON.stringify(requested)}${order}${order ? dir : ''} LIMIT ? OFFSET ?`)
        .all(limit, offset);
      const total = (store.db.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(requested)}`).get() as {
        n: number;
      }).n;
      json(res, 200, { table: requested, columns: cols, rows, total, limit, offset });
      return true;
    }

    json(res, 404, { error: 'not_found', detail: `No API route for ${path}` });
    return true;
  } catch (e) {
    json(res, 500, { error: 'internal', detail: e instanceof Error ? e.message : String(e) });
    return true;
  }
}
