// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The read-only HTTP API over the capture store.
 *
 * Everything the dashboard needs beyond the live WebSocket stream lives here:
 * paginated history, entity listings, the derived API map, and — the reason this
 * exists at all — the per-app tables the Cartographer materializes.
 *
 * Design rules, all of which follow from "this is loopback-only but still
 * exposed to a browser":
 *   - GET only. Nothing here mutates; state changes go over the WebSocket where
 *     the replay safety rails apply.
 *   - Same session token as the WS upgrade, and the same Origin check.
 *   - Table names are allowlisted against the live materialized tables before
 *     they are interpolated (and quoted as identifiers); a sort column never
 *     enters the SQL text at all — it is validated, then sorted by position.
 *   - Responses are store rows as persisted: redacted on write by the rules of
 *     that time (a row older than a redaction rule is not re-scrubbed here), and
 *     nothing here re-derives a secret.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  redactedErrorMessage as errMsg,
  flowStepSummary,
  flowSummary,
  templateStepSummary,
  templateSummary,
} from '@sluice/core';
import type { Capture, SqliteStore } from '@sluice/core';
import { buildApiMap, listMaterializedTables, quoteIdent, renderMarkdown, tableColumns } from '@sluice/cartographer';

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

export function json(res: ServerResponse, status: number, body: unknown): void {
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

/** How much of each body a list or WebSocket preview of a capture carries. */
const PREVIEW_BODY_CHARS = 64 * 1024;

/**
 * A capture as lists and the WebSocket ship it: each body cut to `max` chars,
 * with the full `bodyLengths` set only when something was cut — so a backfill or
 * the resume ring never pins multi-MB bodies. The inspector fetches the full body
 * by id (`/api/captures/:id/body`) and `body:` search runs server-side.
 */
export function previewCapture(c: Capture, max = PREVIEW_BODY_CHARS): Capture {
  const req = c.reqBody?.length ?? 0;
  const res = c.resBody?.length ?? 0;
  if (req <= max && res <= max) return c;
  return {
    ...c,
    reqBody: c.reqBody == null || req <= max ? c.reqBody : c.reqBody.slice(0, max),
    resBody: c.resBody == null || res <= max ? c.resBody : c.resBody.slice(0, max),
    bodyLengths: { req, res },
  };
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
  const materialized = () => listMaterializedTables(store, deps.adapters.map((a) => a.id));
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
      const ids = url.searchParams.get('ids')?.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
      const captures = store.listCaptures({
        limit: intParam(url, 'limit', DEFAULT_LIMIT),
        adapterId: url.searchParams.get('app') ?? undefined,
        host: url.searchParams.get('host') ?? undefined,
        tabId: url.searchParams.get('tab') ?? undefined,
        sinceTs: url.searchParams.has('since') ? intParam(url, 'since', 0, Number.MAX_SAFE_INTEGER) : undefined,
        ids: ids?.length ? ids : undefined,
      });
      json(res, 200, { captures: captures.map((c) => previewCapture(c)), total: store.countCaptures() });
      return true;
    }

    /**
     * Full-text search over capture BODIES. It must run server-side: the WS
     * backfill is a bounded window, so client-side matching would silently answer
     * a narrower question. FTS5-backed, so an index lookup rather than a scan.
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
      json(res, 200, { captures: captures.map((c) => previewCapture(c)), matched: captures.length, query: q });
      return true;
    }

    const capBody = /^\/api\/captures\/([^/]+)\/body$/.exec(path);
    if (capBody) {
      const capture = store.getCapture(decodeURIComponent(capBody[1] ?? ''));
      if (!capture) {
        json(res, 404, { error: 'not_found' });
        return true;
      }
      // Bodies are the expensive part of a capture; lists and the WebSocket ship
      // previews (previewCapture), and this is where the inspector fetches the
      // whole one on demand.
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
        .map((f) => ({ ...flowSummary(f), steps: f.steps.map(flowStepSummary) }));
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
          ...templateSummary(t),
          steps: t.steps.map(templateStepSummary),
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
    // Listed fresh on each call rather than cached: materialize runs continuously
    // during capture, so a cached list would go stale exactly when the user is
    // watching new tables appear. One listing (cartographer's) decides what is a
    // materialized table — sanitized `<app>_` prefixes, core and FTS tables never.
    if (path === '/api/tables') {
      const tables = materialized().map(({ name, adapterId }) => ({
        name,
        app: adapterId,
        rows: (store.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number }).n,
        columns: tableColumns(store, name),
      }));
      json(res, 200, { tables });
      return true;
    }

    const tableRows = /^\/api\/tables\/([^/]+)$/.exec(path);
    if (tableRows) {
      const requested = decodeURIComponent(tableRows[1] ?? '');
      // A table name cannot be a bound parameter, so it is only ever interpolated
      // after an exact match against the live materialized tables.
      const allowed = materialized().some((t) => t.name === requested);
      if (!allowed) {
        json(res, 404, { error: 'unknown_table', detail: 'Not a materialized per-app table.' });
        return true;
      }
      const limit = intParam(url, 'limit', DEFAULT_LIMIT);
      const offset = intParam(url, 'offset', 0, Number.MAX_SAFE_INTEGER);

      // The sort column is validated against the table's real columns and then
      // referenced by POSITION (`ORDER BY 3`), so its name — a raw response-body
      // key — never becomes SQL text. `SELECT *` returns columns in table_info order.
      const orderBy = url.searchParams.get('orderBy');
      const cols = tableColumns(store, requested);
      const idx = orderBy ? cols.indexOf(orderBy) : -1;
      const order = idx >= 0 ? ` ORDER BY ${idx + 1}` : '';
      const dir = url.searchParams.get('dir') === 'desc' ? ' DESC' : '';

      const rows = store.db
        .prepare(`SELECT * FROM ${quoteIdent(requested)}${order}${order ? dir : ''} LIMIT ? OFFSET ?`)
        .all(limit, offset);
      const total = (store.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(requested)}`).get() as {
        n: number;
      }).n;
      json(res, 200, { table: requested, columns: cols, rows, total, limit, offset });
      return true;
    }

    json(res, 404, { error: 'not_found', detail: `No API route for ${path}` });
    return true;
  } catch (e) {
    json(res, 500, { error: 'internal', detail: errMsg(e) });
    return true;
  }
}
