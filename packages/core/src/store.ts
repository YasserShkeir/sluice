// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { decodeBody, encodeBody } from './body-codec.js';
import { ADDITIVE_COLUMNS, ADDITIVE_INDEXES, SCHEMA_SQL } from './schema.js';
import type {
  Actor,
  Capture,
  CaptureQuery,
  Container,
  CursorSeed,
  CursorState,
  Edge,
  EdgeQuery,
  FlowInput,
  FlowQuery,
  FlowSource,
  FlowStep,
  FlowStepRole,
  FlowTemplate,
  FlowTemplateInput,
  FlowTemplateQuery,
  InteractionFlow,
  Item,
  ItemFilter,
  ItemQuery,
  ItemSearchQuery,
  ParseResult,
  ReadOnlyStore,
  RedactedSession,
  WorkItem,
  Workspace,
} from './types.js';
import { newId } from './util.js';

type DB = InstanceType<typeof Database>;

const j = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

/**
 * Parse a JSON column back into a value. A malformed row must never take down a
 * read: `listCaptures` feeds the WS backfill, the cartographer and the api-map,
 * so one truncated write (or a hand-edited `--db`) would otherwise throw out of
 * every one of those paths. Undefined is the same answer the column being empty
 * gives, and every caller already handles it.
 */
const unj = <T>(v: unknown): T | undefined => {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    return undefined;
  }
};

export interface UpsertCounts {
  workspaces: number;
  actors: number;
  containers: number;
  items: number;
  edges: number;
}

/**
 * Turn arbitrary user text into an FTS5 MATCH expression that cannot throw.
 *
 * FTS5's query language treats `"`, `*`, `(`, `:`, `-`, `^` and the bare words
 * AND/OR/NOT/NEAR as syntax. A search box that passes text straight through
 * turns `what's "up"?` or a lone `-` into a SQLite syntax ERROR — the search
 * fails loudly instead of returning nothing, which is a much worse experience
 * than a literal match. So every token is quoted, which makes it a literal, and
 * a trailing `*` is preserved as a prefix search because that is the one piece
 * of syntax a search box genuinely wants.
 *
 * Returns undefined when there is nothing searchable left, so callers can skip
 * the join entirely rather than matching everything.
 */
export function ftsQuery(input: string): string | undefined {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const prefix = t.endsWith('*');
      const bare = (prefix ? t.slice(0, -1) : t).replace(/"/g, '');
      if (bare.length === 0) return undefined;
      return `"${bare}"${prefix ? '*' : ''}`;
    })
    .filter((t): t is string => t !== undefined);
  return tokens.length > 0 ? tokens.join(' ') : undefined;
}

/** A WHERE clause and its named parameters, ready to interpolate. */
interface Where {
  clause: string;
  params: Record<string, unknown>;
}

const whereOf = (parts: string[], params: Record<string, unknown>): Where => ({
  clause: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '',
  params,
});

/**
 * The capture filter, built once for the three reads that share it.
 *
 * It used to live inline in `listCaptures`, which meant a count or a max over the
 * same query had no way to reuse it and would have drifted the moment either side
 * gained a field.
 */
function captureWhere(q: CaptureQuery): Where {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.adapterId) {
    parts.push('adapter_id = @adapterId');
    params.adapterId = q.adapterId;
  }
  if (q.host) {
    parts.push('host = @host');
    params.host = q.host;
  }
  if (q.sinceTs !== undefined) {
    parts.push('ts >= @sinceTs');
    params.sinceTs = q.sinceTs;
  }
  if (q.tabId) {
    parts.push('tab_id = @tabId');
    params.tabId = q.tabId;
  }
  if (q.classification) {
    parts.push('classification = @classification');
    params.classification = q.classification;
  }
  if (q.unparsed) parts.push('parsed_at IS NULL');
  // `unattributed` is the pre-scoping noise: captures no adapter claimed
  // (adapter_id IS NULL). It is the ~100 MB of chatgpt/telemetry/CDN traffic
  // from before TLS interception was scoped, and the one partition a user
  // actually wants to delete without touching real app data. It is a SEPARATE
  // predicate from `adapterId` (which requires a value), so a delete and the
  // count shown beside it can share this exact WHERE — see deleteCaptures.
  if (q.unattributed) parts.push('adapter_id IS NULL');
    if (q.ids && q.ids.length === 0) {
    parts.push('1=0'); // match-none: empty id list is not "no filter"
  } else if (q.ids && q.ids.length > 0) {
    // Bound the IN list so a huge hydrate request cannot blow the query planner
    // or the bind limit. Callers batch if they need more.
    const capped = q.ids.slice(0, 500);
    const placeholders = capped.map((_, i) => `@id${i}`).join(', ');
    parts.push(`id IN (${placeholders})`);
    for (let i = 0; i < capped.length; i++) params[`id${i}`] = capped[i];
  }
  if (q.bodyMatch) {
    // Contentless FTS reads back as NULL, so the index can only be used to
    // narrow rowids — the row itself always comes from `captures`.
    parts.push('rowid IN (SELECT rowid FROM captures_fts WHERE captures_fts MATCH @bodyMatch)');
    params.bodyMatch = q.bodyMatch;
  }
  return whereOf(parts, params);
}

/** The item filter, shared by `queryItems` and `countItems` for the same reason. */
function itemWhere(q: ItemFilter): Where {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.id !== undefined) {
    parts.push('id = @id');
    params.id = q.id;
  }
  if (q.containerId !== undefined) {
    parts.push('container_id = @containerId');
    params.containerId = q.containerId;
  }
  if (q.adapterId !== undefined) {
    parts.push('adapter_id = @adapterId');
    params.adapterId = q.adapterId;
  }
  if (q.workspaceId !== undefined) {
    parts.push('workspace_id = @workspaceId');
    params.workspaceId = q.workspaceId;
  }
  if (q.beforeTs !== undefined) {
    parts.push('ts < @beforeTs');
    params.beforeTs = q.beforeTs;
  }
  // A literal, not a parameter: `thread_id IS NOT @x` is not the same test as
  // `IS NOT NULL` in SQLite, and there is nothing to bind either way.
  if (q.threaded === true) parts.push('thread_id IS NOT NULL');
  if (q.threaded === false) parts.push('thread_id IS NULL');
  return whereOf(parts, params);
}

/**
 * The single SQLite sink for captures + normalized entities. There is no method
 * to persist a secret: the store simply has nowhere to put one.
 */
/** Escape `%`, `_`, and `\\` for SQLite LIKE with ESCAPE '\\'. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

export class SqliteStore {
  readonly db: DB;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000'); // wait out concurrent writers instead of erroring
    this.migrate();
  }

  migrate(): void {
    this.db.exec(SCHEMA_SQL);
    // Order matters: columns first, then the indexes that reference them.
    this.applyAdditiveColumns();
    for (const sql of ADDITIVE_INDEXES) this.db.exec(sql);
    this.backfillFtsIfEmpty();
  }

  /**
   * Index the bodies and item text that predate the FTS tables.
   *
   * `CREATE VIRTUAL TABLE IF NOT EXISTS` gives an existing database the index but
   * not its contents, so without this every capture you already had would be
   * invisible to body search — silently, and forever, because nothing else ever
   * revisits an old row. Searching your own history and getting nothing back is a
   * worse failure than a slow first start.
   *
   * Runs at most once per database: it is guarded on the index being empty while
   * the source table is not. Deliberately not a general "reindex" — a full
   * rebuild on every open would be a large cost paid for nothing.
   */
  private backfillFtsIfEmpty(): void {
    const pending: Array<{ fts: string; src: string; column: string }> = [
      { fts: 'captures_fts', src: 'captures', column: 'body' },
      { fts: 'items_fts', src: 'items', column: 'text' },
    ];
    for (const { fts, src, column } of pending) {
      const indexed = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${fts}`).get() as { n: number }).n;
      if (indexed > 0) continue;
      const rows = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${src}`).get() as { n: number }).n;
      if (rows === 0) continue;

      const insert = this.db.prepare(`INSERT INTO ${fts}(rowid, ${column}) VALUES (?, ?)`);
      const tx = this.db.transaction(() => {
        if (src === 'captures') {
          const all = this.db
            .prepare(
              `SELECT rowid AS rid, req_body, req_body_encoding, res_body, res_body_encoding
                 FROM captures`,
            )
            .all() as Array<{
            rid: number;
            req_body: string | Buffer | null;
            req_body_encoding: string | null;
            res_body: string | Buffer | null;
            res_body_encoding: string | null;
          }>;
          for (const r of all) {
            const body = [
              decodeBody(r.req_body, r.req_body_encoding),
              decodeBody(r.res_body, r.res_body_encoding),
            ]
              .filter((b) => b != null && b.length > 0)
              .join('\n');
            if (body.length > 0) insert.run(r.rid, body);
          }
        } else {
          const all = this.db.prepare(`SELECT rowid AS rid, text FROM items`).all() as Array<{
            rid: number;
            text: string;
          }>;
          for (const r of all) if (r.text.length > 0) insert.run(r.rid, r.text);
        }
      });
      tx();
    }
  }

  /**
   * Bring an existing database up to the current column set. `CREATE TABLE IF
   * NOT EXISTS` does nothing to a table that already exists, so without this a
   * new column would only ever appear in freshly-created stores.
   */
  private applyAdditiveColumns(): void {
    for (const [table, columns] of Object.entries(ADDITIVE_COLUMNS)) {
      const present = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      for (const [column, ddl] of Object.entries(columns)) {
        if (present.has(column)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      }
    }
  }

  // ── Captures ───────────────────────────────────────────────────────────────

  /**
   * Store one capture and keep its full-text index in step.
   *
   * Upserts with ON CONFLICT rather than INSERT OR REPLACE. REPLACE deletes the
   * row and re-inserts it, which assigns a NEW implicit rowid — and `captures_fts`
   * is joined back on rowid, so every re-inserted capture would silently orphan
   * its indexed body and inherit whichever body the recycled rowid used to hold.
   *
   * The whole thing is one transaction: a row whose FTS entry did not land would
   * be invisible to `body:` searches with nothing to signal it.
   */
  insertCapture(c: Capture): void {
    const req = encodeBody(c.reqBody);
    const res = encodeBody(c.resBody);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO captures
         (id, ts, source, adapter_id, method, url, host, path, status, duration_ms,
          req_headers, req_body, res_headers, res_body, pid, process_name,
          tab_id, tab_url, loader_id, page_load_id, navigation_id, direction, ws_id,
          classification, parsed_at, req_body_encoding, res_body_encoding)
         VALUES
         (@id, @ts, @source, @adapter_id, @method, @url, @host, @path, @status, @duration_ms,
          @req_headers, @req_body, @res_headers, @res_body, @pid, @process_name,
          @tab_id, @tab_url, @loader_id, @page_load_id, @navigation_id, @direction, @ws_id,
          @classification, @parsed_at, @req_body_encoding, @res_body_encoding)
         ON CONFLICT(id) DO UPDATE SET
           ts = excluded.ts, source = excluded.source, adapter_id = excluded.adapter_id,
           method = excluded.method, url = excluded.url, host = excluded.host,
           path = excluded.path, status = excluded.status, duration_ms = excluded.duration_ms,
           req_headers = excluded.req_headers, req_body = excluded.req_body,
           res_headers = excluded.res_headers, res_body = excluded.res_body,
           pid = excluded.pid, process_name = excluded.process_name,
           tab_id = excluded.tab_id, tab_url = excluded.tab_url,
           loader_id = excluded.loader_id, page_load_id = excluded.page_load_id,
           navigation_id = excluded.navigation_id,
           direction = excluded.direction, ws_id = excluded.ws_id,
           classification = excluded.classification, parsed_at = excluded.parsed_at,
           req_body_encoding = excluded.req_body_encoding,
           res_body_encoding = excluded.res_body_encoding`,
        )
        .run({
          id: c.id,
          ts: c.ts,
          source: c.source,
          adapter_id: c.adapterId,
          method: c.method,
          url: c.url,
          host: c.host,
          path: c.path,
          status: c.status,
          duration_ms: c.durationMs,
          req_headers: JSON.stringify(c.reqHeaders ?? {}),
          req_body: req.value,
          res_headers: JSON.stringify(c.resHeaders ?? {}),
          res_body: res.value,
          pid: c.pid ?? null,
          process_name: c.processName ?? null,
          tab_id: c.tabId ?? null,
          tab_url: c.tabUrl ?? null,
          loader_id: c.loaderId ?? null,
          page_load_id: c.pageLoadId ?? null,
          navigation_id: c.navigationId ?? null,
          direction: c.direction ?? null,
          ws_id: c.wsId ?? null,
          classification: c.classification ?? null,
          parsed_at: c.parsedAt ?? null,
          req_body_encoding: req.encoding,
          res_body_encoding: res.encoding,
        });

      const rowid = this.captureRowid(c.id);
      if (rowid === undefined) return;
      // Index the PLAINTEXT — the same already-redacted text that was just
      // compressed on its way into the row. A gzip BLOB cannot be tokenized, and
      // anything read from upstream of the redactor would put a searchable
      // plaintext copy of a secret in the database.
      this.db.prepare(`DELETE FROM captures_fts WHERE rowid = ?`).run(rowid);
      const body = [c.reqBody, c.resBody].filter((b) => b != null && b.length > 0).join('\n');
      if (body.length > 0) {
        this.db.prepare(`INSERT INTO captures_fts(rowid, body) VALUES (?, ?)`).run(rowid, body);
      }
    });
    tx();
  }

  private captureRowid(id: string): number | undefined {
    const row = this.db.prepare(`SELECT rowid AS rid FROM captures WHERE id = ?`).get(id) as
      | { rid: number }
      | undefined;
    return row?.rid;
  }

  /**
   * Record that these captures have been turned into entities.
   *
   * The alternative — an in-memory high-water timestamp — silently re-parsed the
   * entire store on every restart and could not express "this one capture failed
   * to parse" at all.
   */
  markParsed(ids: string[], ts: number = Date.now()): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE captures SET parsed_at = ? WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const id of ids) stmt.run(ts, id);
    });
    tx();
  }

  getCapture(id: string): Capture | undefined {
    const row = this.db.prepare(`SELECT * FROM captures WHERE id = ?`).get(id);
    return row ? rowToCapture(row as CaptureRow) : undefined;
  }

  listCaptures(q: CaptureQuery = {}): Capture[] {
    const { clause, params } = captureWhere(q);
    const limit = q.limit ?? 500;
    const rows = this.db
      .prepare(`SELECT * FROM captures ${clause} ORDER BY ts DESC LIMIT @limit`)
      .all({ ...params, limit }) as CaptureRow[];
    return rows.map(rowToCapture);
  }

  /**
   * Free-text search over capture bodies, safe for raw user input.
   *
   * Everything `listCaptures` accepts still applies, so a caller can scope a
   * search to one adapter or one tab. Returns [] rather than everything when the
   * text contains nothing searchable — an empty query is not a match-all.
   */
  searchCaptures(text: string, q: Omit<CaptureQuery, 'bodyMatch'> = {}): Capture[] {
    const match = ftsQuery(text);
    if (match === undefined) return [];
    return this.listCaptures({ ...q, bodyMatch: match });
  }

  /**
   * Drop old captures. Sluice captures ALL traffic with bodies up to 5 MB each
   * and had no expiry of any kind, so the DB grew without bound for as long as
   * capture ran — degrading every query over it and keeping
   * redacted-but-still-sensitive traffic on disk forever.
   *
   * Both bounds are optional and combine: `maxAgeMs` drops anything older than a
   * cutoff, `maxRows` keeps only the newest N. Returns how many rows went.
   */
  pruneCaptures(opts: { maxAgeMs?: number; maxRows?: number; vacuum?: boolean } = {}): number {
    let removed = 0;
    // The FTS rows must go FIRST, while their rowids still resolve. Deleting the
    // capture first leaves an orphaned index entry that keeps matching, so a
    // `body:` search would return rowids with no row behind them — for as long as
    // the database lives, since nothing would ever revisit them.
    const dropFts = this.db.prepare(`DELETE FROM captures_fts WHERE rowid = ?`);
    const forget = (rowids: Array<{ rid: number }>): void => {
      for (const { rid } of rowids) dropFts.run(rid);
    };
    const tx = this.db.transaction(() => {
      if (opts.maxAgeMs !== undefined && opts.maxAgeMs > 0) {
        const cutoff = Date.now() - opts.maxAgeMs;
        forget(
          this.db.prepare(`SELECT rowid AS rid FROM captures WHERE ts < ?`).all(cutoff) as Array<{
            rid: number;
          }>,
        );
        removed += this.db.prepare(`DELETE FROM captures WHERE ts < ?`).run(cutoff).changes;
      }
      if (opts.maxRows !== undefined && opts.maxRows >= 0) {
        // idx_captures_ts makes the ORDER BY / OFFSET cheap.
        const doomed = `SELECT id, rowid AS rid FROM captures ORDER BY ts DESC LIMIT -1 OFFSET ?`;
        forget(this.db.prepare(doomed).all(opts.maxRows) as Array<{ rid: number }>);
        removed += this.db
          .prepare(
            `DELETE FROM captures WHERE id IN (
               SELECT id FROM captures ORDER BY ts DESC LIMIT -1 OFFSET ?
             )`,
          )
          .run(opts.maxRows).changes;
      }
      if (removed > 0) this.gcOrphanFlows();
    });
    tx();
    // VACUUM cannot run inside a transaction, and it rewrites the whole file —
    // so it is opt-in rather than automatic on a live capture path.
    if (opts.vacuum && removed > 0) this.db.exec('VACUUM');
    return removed;
  }

  /**
   * Delete captures matching a query, and their FTS entries. Returns the count.
   *
   * Built on the SAME `captureWhere` that `countCaptures` uses, so a confirm
   * dialog can show `countCaptures(q)` and then `deleteCaptures(q)` delete exactly
   * that set — no host-heuristic-vs-adapter-id mismatch where the button deletes
   * a different set than it names. FTS rows go first (rowids still resolve), like
   * `pruneCaptures`. VACUUM is the caller's separate, disk-checked step.
   *
   * Refuses an EMPTY query: `deleteCaptures({})` would delete everything, which is
   * `wipe()`'s job and must be asked for by name, not reachable by forgetting a
   * filter.
   *
   * When `bodyMatch` is set, rowids are materialized first and deletes use that
   * fixed id set — never re-evaluate an FTS-dependent WHERE after FTS rows drop.
   */
  deleteCaptures(q: CaptureQuery): number {
    const { clause, params } = captureWhere(q);
    if (clause === '') {
      throw new Error('deleteCaptures needs a filter; use wipe() to remove everything.');
    }
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(`SELECT id, rowid AS rid FROM captures ${clause}`)
        .all(params) as Array<{ id: string; rid: number }>;
      if (rows.length === 0) return 0;
      const dropFts = this.db.prepare(`DELETE FROM captures_fts WHERE rowid = ?`);
      for (const { rid } of rows) dropFts.run(rid);
      // Delete by materialized ids so bodyMatch/FTS filters cannot see a half-deleted index.
      const del = this.db.prepare(`DELETE FROM captures WHERE id = ?`);
      let n = 0;
      for (const { id } of rows) n += del.run(id).changes;
      if (n > 0) this.gcOrphanFlows();
      return n;
    })();
  }

  /**
   * Reclaim free pages by rewriting the whole file. SYNCHRONOUS and blocking —
   * better-sqlite3 is, and this is one connection — so on a large store it
   * freezes every read/write for seconds. Callers gate it behind a disk-space
   * pre-check and a "server will pause" notice; it is never automatic on a live
   * path. Cannot run inside a transaction.
   */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /**
   * Per-table sizes and row counts, plus totals — what the dashboard's storage
   * panel renders. Sizes come from the `dbstat` virtual table (real on-disk
   * bytes, indexes included); if a build lacks it, `bytes` is 0 and the panel
   * degrades to row counts rather than failing.
   */
  storageStats(): {
    totalBytes: number;
    freeBytes: number;
    tables: Array<{ name: string; bytes: number; rows: number }>;
  } {
    const pageSize = (this.db.pragma('page_size', { simple: true }) as number) ?? 0;
    const pageCount = (this.db.pragma('page_count', { simple: true }) as number) ?? 0;
    const freelist = (this.db.pragma('freelist_count', { simple: true }) as number) ?? 0;

    let bytesByTable = new Map<string, number>();
    try {
      const rows = this.db
        .prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`)
        .all() as Array<{ name: string; bytes: number }>;
      bytesByTable = new Map(rows.map((r) => [r.name, r.bytes]));
    } catch {
      /* dbstat unavailable — bytes stay 0, panel shows row counts only */
    }

    const names = (
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    const tables = names.map((name) => {
      let rows = 0;
      try {
        rows = (this.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n;
      } catch {
        /* a virtual/FTS shadow table may not answer COUNT — leave 0 */
      }
      return { name, bytes: bytesByTable.get(name) ?? 0, rows };
    });

    return {
      totalBytes: pageSize * pageCount,
      freeBytes: pageSize * freelist,
      tables: tables.sort((a, b) => b.bytes - a.bytes),
    };
  }

  /**
   * Remove ALL captures and derived entities in place — the in-process form of
   * `sluice wipe`. Weaker than the CLI's file `rmSync` (it reuses the same file,
   * so freed pages are only scrubbed by a following VACUUM), which is why the
   * caller pairs it with `vacuum()`. Does NOT drop the materialized per-app
   * tables — the caller does that via the cartographer, which owns their names.
   */
  wipe(): { captures: number } {
    return this.db.transaction(() => {
      const captures = (this.db.prepare(`SELECT COUNT(*) AS n FROM captures`).get() as { n: number }).n;
      for (const t of [
        'captures_fts',
        'items_fts',
        'edges',
        'items',
        'containers',
        'actors',
        'workspaces',
        'cursors',
        'interaction_flow_steps',
        'interaction_flows',
        'flow_templates',
        'sessions',
        'captures',
      ]) {
        try {
          this.db.exec(`DELETE FROM ${t}`);
        } catch {
          /* a table that does not exist in an older store is nothing to clear */
        }
      }
      return { captures };
    })();
  }

  /** How many captures are stored, narrowed by the same query `listCaptures` takes. */
  countCaptures(q: CaptureQuery = {}): number {
    const { clause, params } = captureWhere(q);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM captures ${clause}`).get(params) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * When the newest matching capture landed, or null when nothing matches.
   *
   * Separate from `listCaptures({ limit: 1 })` on purpose: that answers the same
   * question by decoding a whole capture — up to 5 MB of body — to read one
   * integer off it, and the only caller that wants it is asking how STALE the
   * store is.
   */
  newestCaptureTs(q: CaptureQuery = {}): number | null {
    const { clause, params } = captureWhere(q);
    const row = this.db.prepare(`SELECT MAX(ts) AS ts FROM captures ${clause}`).get(params) as
      | { ts: number | null }
      | undefined;
    return row?.ts ?? null;
  }

  // ── Entities ───────────────────────────────────────────────────────────────

  upsertWorkspace(w: Workspace, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, adapter_id, name, domain, raw, updated_ts)
         VALUES (@id, @adapter_id, @name, @domain, @raw, @updated_ts)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           -- COALESCE, not assignment: a parse that did not OBSERVE a field must
           -- not erase what another one established. Gmail is the case that
           -- surfaced it — the account address appears only in the message-detail
           -- endpoint, so every later thread-list parse was wiping it back to
           -- null and the answer depended on which endpoint happened to run last.
           domain = COALESCE(excluded.domain, domain),
           raw = COALESCE(excluded.raw, raw),
           updated_ts = excluded.updated_ts`,
      )
      .run({
        id: w.id,
        adapter_id: w.adapterId,
        name: w.name,
        domain: w.domain ?? null,
        raw: j(w.raw),
        updated_ts: ts,
      });
  }

  upsertActor(a: Actor, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO actors (id, workspace_id, adapter_id, handle, display_name, avatar_url, raw, updated_ts)
         VALUES (@id, @workspace_id, @adapter_id, @handle, @display_name, @avatar_url, @raw, @updated_ts)
         ON CONFLICT(id) DO UPDATE SET
           handle = excluded.handle, display_name = excluded.display_name,
           -- workspace_id is assignable, like every other column. It used to be
           -- the one field an upsert could not correct, which meant a re-parse
           -- that MOVED an entity between workspaces silently did not: the row
           -- kept pointing at the old one and was then deleted along with it.
           workspace_id = excluded.workspace_id,
           avatar_url = excluded.avatar_url, raw = excluded.raw, updated_ts = excluded.updated_ts`,
      )
      .run({
        id: a.id,
        workspace_id: a.workspaceId,
        adapter_id: a.adapterId,
        handle: a.handle,
        display_name: a.displayName ?? null,
        avatar_url: a.avatarUrl ?? null,
        raw: j(a.raw),
        updated_ts: ts,
      });
  }

  upsertContainer(c: Container, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO containers (id, workspace_id, adapter_id, kind, name, topic, is_private, member_count, item_count, unread_count, raw, updated_ts)
         VALUES (@id, @workspace_id, @adapter_id, @kind, @name, @topic, @is_private, @member_count, @item_count, @unread_count, @raw, @updated_ts)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, topic = excluded.topic,
           is_private = excluded.is_private, member_count = excluded.member_count,
           -- COALESCE on these two only, and note the direction: a response that
           -- DOES report a count still overwrites, because a count is a snapshot
           -- and a stale unread number is a wrong one. What it protects against
           -- is the response that reports no counts at all — Gmail sends the
           -- label list and the label counts in separate slots of the same body
           -- and populates them independently, so assignment would blank last
           -- minute's totals every time one arrived without the other.
           item_count = COALESCE(excluded.item_count, item_count),
           unread_count = COALESCE(excluded.unread_count, unread_count),
           raw = excluded.raw, updated_ts = excluded.updated_ts`,
      )
      .run({
        id: c.id,
        workspace_id: c.workspaceId,
        adapter_id: c.adapterId,
        kind: c.kind,
        name: c.name,
        topic: c.topic ?? null,
        is_private: c.isPrivate === undefined ? null : c.isPrivate ? 1 : 0,
        member_count: c.memberCount ?? null,
        item_count: c.itemCount ?? null,
        unread_count: c.unreadCount ?? null,
        raw: j(c.raw),
        updated_ts: ts,
      });
  }

  upsertItem(i: Item): void {
    this.db
      .prepare(
        `INSERT INTO items (id, container_id, workspace_id, adapter_id, kind, author_id, ts, text, thread_id, source_capture_ids, raw)
         VALUES (@id, @container_id, @workspace_id, @adapter_id, @kind, @author_id, @ts, @text, @thread_id, @source_capture_ids, @raw)
         ON CONFLICT(container_id, id) DO UPDATE SET
           text = excluded.text, author_id = excluded.author_id, thread_id = excluded.thread_id,
           -- See upsertActor: an item re-parsed into a different workspace has to
           -- arrive there. The key is (container_id, id), and neither part
           -- changes when only the attribution does.
           workspace_id = excluded.workspace_id,
           source_capture_ids = excluded.source_capture_ids, raw = excluded.raw`,
      )
      .run({
        id: i.id,
        container_id: i.containerId,
        workspace_id: i.workspaceId,
        adapter_id: i.adapterId,
        kind: i.kind,
        author_id: i.authorId ?? null,
        ts: i.ts,
        text: i.text,
        thread_id: i.threadId ?? null,
        source_capture_ids: j(i.sourceCaptureIds),
        raw: j(i.raw),
      });

    // Same rowid-join contract as captures_fts. The upsert above already
    // preserves the rowid, so re-indexing is delete-then-insert on that rowid.
    const row = this.db
      .prepare(`SELECT rowid AS rid FROM items WHERE container_id = ? AND id = ?`)
      .get(i.containerId, i.id) as { rid: number } | undefined;
    if (row === undefined) return;
    this.db.prepare(`DELETE FROM items_fts WHERE rowid = ?`).run(row.rid);
    if (i.text.length > 0) {
      this.db.prepare(`INSERT INTO items_fts(rowid, text) VALUES (?, ?)`).run(row.rid, i.text);
    }
  }

  /**
   * An edge is content-addressed by its five endpoint columns, so re-observing
   * the same relationship refreshes it instead of duplicating it. That matters
   * because the same membership shows up in every paged response that mentions
   * it, and adapters are not expected to de-duplicate before emitting.
   */
  upsertEdge(e: Edge, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO edges (src_kind, src_id, rel, dst_kind, dst_id, adapter_id, workspace_id, raw, updated_ts)
         VALUES (@src_kind, @src_id, @rel, @dst_kind, @dst_id, @adapter_id, @workspace_id, @raw, @updated_ts)
         ON CONFLICT(src_kind, src_id, rel, dst_kind, dst_id) DO UPDATE SET
           adapter_id = excluded.adapter_id, workspace_id = excluded.workspace_id,
           raw = excluded.raw, updated_ts = excluded.updated_ts`,
      )
      .run({
        src_kind: e.srcKind,
        src_id: e.srcId,
        rel: e.rel,
        dst_kind: e.dstKind,
        dst_id: e.dstId,
        adapter_id: e.adapterId,
        workspace_id: e.workspaceId ?? null,
        raw: j(e.raw),
        updated_ts: ts,
      });
  }

  /** Edges touching an entity, in either direction unless `direction` narrows it. */
  listEdges(q: EdgeQuery = {}): Edge[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    for (const [key, column] of [
      ['srcKind', 'src_kind'],
      ['srcId', 'src_id'],
      ['dstKind', 'dst_kind'],
      ['dstId', 'dst_id'],
      ['rel', 'rel'],
      ['workspaceId', 'workspace_id'],
    ] as const) {
      const value = q[key];
      if (value === undefined) continue;
      where.push(`${column} = @${key}`);
      params[key] = value;
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM edges ${clause} ORDER BY updated_ts DESC LIMIT @limit`)
      .all({ ...params, limit: q.limit ?? 1000 }) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /** Apply a whole ParseResult in one transaction; returns per-kind counts. */
  applyParseResult(pr: ParseResult, ts: number): UpsertCounts {
    const counts: UpsertCounts = { workspaces: 0, actors: 0, containers: 0, items: 0, edges: 0 };
    const tx = this.db.transaction(() => {
      for (const w of pr.workspaces ?? []) {
        this.upsertWorkspace(w, ts);
        counts.workspaces++;
      }
      for (const a of pr.actors ?? []) {
        this.upsertActor(a, ts);
        counts.actors++;
      }
      for (const c of pr.containers ?? []) {
        this.upsertContainer(c, ts);
        counts.containers++;
      }
      for (const i of pr.items ?? []) {
        this.upsertItem(i);
        counts.items++;
      }
      for (const e of pr.edges ?? []) {
        this.upsertEdge(e, ts);
        counts.edges++;
      }
    });
    tx();
    return counts;
  }

  // ── Cursors — the pagination worklist ──────────────────────────────────────

  /**
   * Add pages to fetch. Idempotent by (adapter, action, container, cursor), so an
   * adapter that re-emits the same `next_cursor` from a re-parsed capture — which
   * happens every time a capture is replayed — does not enqueue it twice.
   *
   * Returns how many were genuinely new, which is what tells a drainer whether it
   * has more work or has converged.
   */
  enqueueCursors(seeds: CursorSeed[], ts: number = Date.now()): number {
    if (seeds.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO cursors
         (id, adapter_id, action_id, container_id, cursor, params, state, attempts, created_ts, updated_ts)
       VALUES (@id, @adapter_id, @action_id, @container_id, @cursor, @params, 'pending', 0, @ts, @ts)
       ON CONFLICT(adapter_id, action_id, IFNULL(container_id, ''), IFNULL(cursor, ''))
         DO NOTHING`,
    );
    let added = 0;
    const tx = this.db.transaction(() => {
      for (const s of seeds) {
        added += stmt.run({
          id: newId('cur'),
          adapter_id: s.adapterId,
          action_id: s.actionId,
          container_id: s.containerId ?? null,
          cursor: s.cursor ?? null,
          params: j(s.params),
          ts,
        }).changes;
      }
    });
    tx();
    return added;
  }

  /**
   * Take up to `limit` pending items and mark them running, atomically.
   *
   * The claim and the state flip are one transaction precisely so two drainers —
   * `sluice replay --all` in a terminal and the server draining in the
   * background — cannot both take the same page and replay it twice. Replays cost
   * real API quota, so a duplicate is not merely wasteful.
   */
  claimCursors(limit = 25, adapterId?: string): WorkItem[] {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM cursors
            WHERE state = 'pending' ${adapterId ? 'AND adapter_id = @adapterId' : ''}
            ORDER BY created_ts LIMIT @limit`,
        )
        .all({ limit, adapterId }) as CursorRow[];
      const mark = this.db.prepare(
        `UPDATE cursors SET state = 'running', attempts = attempts + 1, updated_ts = @ts WHERE id = @id`,
      );
      const ts = Date.now();
      for (const r of rows) mark.run({ id: r.id, ts });
      return rows.map((r) => rowToWorkItem({ ...r, state: 'running', attempts: r.attempts + 1 }));
    });
    return tx.immediate();
  }

  /** Settle a claimed item. Passing an error marks it failed and records why. */
  completeCursor(id: string, error?: string): void {
    this.db
      .prepare(`UPDATE cursors SET state = @state, last_error = @error, updated_ts = @ts WHERE id = @id`)
      .run({
        id,
        state: error === undefined ? 'done' : 'failed',
        error: error ?? null,
        ts: Date.now(),
      });
  }

  /**
   * Return anything left `running` to `pending`.
   *
   * A drainer that is killed mid-flight leaves its claims stranded, and nothing
   * would ever pick them up again — the worklist would look busy forever. Called
   * at startup, where "running" cannot legitimately mean anything else.
   */
  releaseStaleCursors(): number {
    return this.db.prepare(`UPDATE cursors SET state = 'pending' WHERE state = 'running'`).run()
      .changes;
  }

  listCursors(q: { state?: CursorState; adapterId?: string; limit?: number } = {}): WorkItem[] {
    const where: string[] = [];
    if (q.state) where.push('state = @state');
    if (q.adapterId) where.push('adapter_id = @adapterId');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM cursors ${clause} ORDER BY created_ts LIMIT @limit`)
      .all({ state: q.state, adapterId: q.adapterId, limit: q.limit ?? 500 }) as CursorRow[];
    return rows.map(rowToWorkItem);
  }

  /** How many work items sit in each state — the worklist tab's whole summary. */
  countCursors(): Record<CursorState, number> {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM cursors GROUP BY state`)
      .all() as Array<{ state: CursorState; n: number }>;
    const out: Record<CursorState, number> = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  // ── Interaction flows ──────────────────────────────────────────────────────

  /**
   * Insert or replace one flow and its steps. Replacing drops prior steps so a
   * re-cluster or pin edit cannot leave orphan companions attached.
   *
   * The primary must appear in `steps` (as role `primary`); if the caller forgot,
   * it is prepended. Empty step lists are rejected — a flow of nothing is not a
   * flow, and storing one would make list/get look like data when nothing is linked.
   */
  upsertFlow(input: FlowInput): InteractionFlow {
    if (input.steps.length === 0) {
      throw new Error('upsertFlow requires at least one step');
    }
    const id = input.id ?? newId();
    let steps = input.steps.slice().sort((a, b) => a.seq - b.seq);
    if (!steps.some((s) => s.captureId === input.primaryCaptureId)) {
      steps = [
        {
          captureId: input.primaryCaptureId,
          seq: 0,
          role: 'primary',
          required: true,
        },
        ...steps.map((s, i) => ({ ...s, seq: i + 1 })),
      ];
    } else {
      // Ensure the primary row is marked primary + required.
      steps = steps.map((s) =>
        s.captureId === input.primaryCaptureId
          ? { ...s, role: 'primary' as const, required: true }
          : s,
      );
    }

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO interaction_flows
             (id, adapter_id, label, primary_capture_id, started_at, ended_at, source)
           VALUES
             (@id, @adapter_id, @label, @primary_capture_id, @started_at, @ended_at, @source)
           ON CONFLICT(id) DO UPDATE SET
             adapter_id = excluded.adapter_id,
             label = excluded.label,
             primary_capture_id = excluded.primary_capture_id,
             started_at = excluded.started_at,
             ended_at = excluded.ended_at,
             source = excluded.source`,
        )
        .run({
          id,
          adapter_id: input.adapterId,
          label: input.label ?? null,
          primary_capture_id: input.primaryCaptureId,
          started_at: input.startedAt,
          ended_at: input.endedAt,
          source: input.source,
        });

      this.db.prepare(`DELETE FROM interaction_flow_steps WHERE flow_id = ?`).run(id);
      const ins = this.db.prepare(
        `INSERT INTO interaction_flow_steps
           (flow_id, capture_id, seq, role, operation, required)
         VALUES
           (@flow_id, @capture_id, @seq, @role, @operation, @required)`,
      );
      for (const s of steps) {
        ins.run({
          flow_id: id,
          capture_id: s.captureId,
          seq: s.seq,
          role: s.role,
          operation: s.operation ?? null,
          required: s.required ? 1 : 0,
        });
      }
    });
    tx();

    const got = this.getFlow(id);
    if (!got) throw new Error(`upsertFlow failed to read back ${id}`);
    return got;
  }

  getFlow(id: string): InteractionFlow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM interaction_flows WHERE id = ?`)
      .get(id) as FlowRow | undefined;
    if (!row) return undefined;
    return this.flowFromRow(row);
  }

  listFlows(q: FlowQuery = {}): InteractionFlow[] {
    const parts: string[] = [];
    const params: Record<string, unknown> = { limit: q.limit ?? 200 };
    if (q.adapterId) {
      parts.push('adapter_id = @adapterId');
      params.adapterId = q.adapterId;
    }
    if (q.source) {
      parts.push('source = @source');
      params.source = q.source;
    }
    if (q.sinceTs !== undefined) {
      parts.push('started_at >= @sinceTs');
      params.sinceTs = q.sinceTs;
    }
    if (q.q && q.q.trim().length > 0) {
      parts.push(`(
        IFNULL(label, '') LIKE @qq ESCAPE '\\'
        OR primary_capture_id IN (
          SELECT capture_id FROM interaction_flow_steps
           WHERE role = 'primary' AND IFNULL(operation, '') LIKE @qq ESCAPE '\\'
        )
        OR id IN (
          SELECT flow_id FROM interaction_flow_steps
           WHERE IFNULL(operation, '') LIKE @qq ESCAPE '\\'
        )
      )`);
      params.qq = `%${escapeLike(q.q.trim())}%`;
    }
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM interaction_flows ${where}
          ORDER BY started_at DESC LIMIT @limit`,
      )
      .all(params) as FlowRow[];
    return rows.map((r) => this.flowFromRow(r));
  }

  /** Drop a flow and its steps. Captures are never touched. */
  deleteFlow(id: string): boolean {
    const n = this.db.prepare(`DELETE FROM interaction_flows WHERE id = ?`).run(id).changes;
    return n > 0;
  }

  /**
   * Mark an existing flow as manually pinned so template learning keeps it
   * even when heuristics would have clustered differently.
   */
  pinFlow(id: string): InteractionFlow | undefined {
    return this.setFlowSource(id, 'pinned');
  }

  /** Revert a pinned flow to ordinary observed status. */
  unpinFlow(id: string): InteractionFlow | undefined {
    return this.setFlowSource(id, 'observed');
  }

  /**
   * Manually assemble a pinned flow from ordered capture ids.
   * Captures must exist; adapterId defaults to the primary capture's adapter.
   */
  createPinnedFlow(input: {
    id?: string;
    adapterId?: string;
    label?: string;
    primaryCaptureId: string;
    /** Ordered capture ids for the burst (primary may be anywhere; will be marked). */
    captureIds: string[];
  }): InteractionFlow {
    if (input.captureIds.length === 0) {
      throw new Error('createPinnedFlow requires at least one capture id');
    }
    const primary = this.getCapture(input.primaryCaptureId);
    if (!primary) throw new Error(`unknown primary capture "${input.primaryCaptureId}"`);
    const raw = input.captureIds.includes(input.primaryCaptureId)
      ? input.captureIds.slice()
      : [input.primaryCaptureId, ...input.captureIds];
    // Dedupe while preserving order — duplicate ids violate UNIQUE(flow_id, capture_id).
    const seen = new Set<string>();
    const ids = raw.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
    const caps = ids.map((cid) => {
      const c = this.getCapture(cid);
      if (!c) throw new Error(`unknown capture "${cid}"`);
      return c;
    });
    const startedAt = Math.min(...caps.map((c) => c.ts));
    const endedAt = Math.max(...caps.map((c) => c.ts + (c.durationMs ?? 0)));
    const adapterId = input.adapterId ?? primary.adapterId;
    if (!adapterId) throw new Error('createPinnedFlow needs adapterId (primary has none)');

    const steps = caps.map((c, i) => ({
      captureId: c.id,
      seq: i,
      role: (c.id === input.primaryCaptureId ? 'primary' : 'companion') as FlowStepRole,
      operation: c.classification ?? undefined,
      required: c.id === input.primaryCaptureId,
    }));

    return this.upsertFlow({
      id: input.id,
      adapterId,
      label: input.label,
      primaryCaptureId: input.primaryCaptureId,
      startedAt,
      endedAt,
      source: 'pinned',
      steps,
    });
  }

  private setFlowSource(id: string, source: FlowSource): InteractionFlow | undefined {
    const n = this.db
      .prepare(`UPDATE interaction_flows SET source = ? WHERE id = ?`)
      .run(source, id).changes;
    if (n === 0) return undefined;
    return this.getFlow(id);
  }

  private flowFromRow(row: FlowRow): InteractionFlow {
    const steps = (
      this.db
        .prepare(
          `SELECT capture_id, seq, role, operation, required
             FROM interaction_flow_steps
            WHERE flow_id = ?
            ORDER BY seq ASC`,
        )
        .all(row.id) as FlowStepRow[]
    ).map(
      (s): FlowStep => ({
        captureId: s.capture_id,
        seq: s.seq,
        role: s.role as FlowStepRole,
        operation: s.operation ?? undefined,
        required: s.required === 1,
      }),
    );
    return {
      id: row.id,
      adapterId: row.adapter_id,
      label: row.label ?? undefined,
      primaryCaptureId: row.primary_capture_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      source: row.source as FlowSource,
      steps,
    };
  }

  /**
   * Delete all flows for an adapter (and their steps). Captures untouched.
   * Used by clearApp so derived flow rows do not outlive their app.
   */
  deleteFlows(opts: { adapterId: string }): number {
    const ids = (
      this.db
        .prepare(`SELECT id FROM interaction_flows WHERE adapter_id = ?`)
        .all(opts.adapterId) as Array<{ id: string }>
    ).map((r) => r.id);
    if (ids.length === 0) return 0;
    const dropSteps = this.db.prepare(`DELETE FROM interaction_flow_steps WHERE flow_id = ?`);
    const dropFlow = this.db.prepare(`DELETE FROM interaction_flows WHERE id = ?`);
    return this.db.transaction(() => {
      let n = 0;
      for (const id of ids) {
        dropSteps.run(id);
        n += dropFlow.run(id).changes;
      }
      return n;
    })();
  }

  /**
   * Drop flows whose primary capture is gone, or that have zero remaining steps
   * pointing at existing captures. Called after capture prune/delete.
   */
  gcOrphanFlows(): number {
    // Steps whose capture no longer exists.
    this.db.exec(`
      DELETE FROM interaction_flow_steps
       WHERE capture_id NOT IN (SELECT id FROM captures)
    `);
    // Flows whose primary is gone, or that lost every step.
    const doomed = this.db
      .prepare(
        `SELECT id FROM interaction_flows
          WHERE primary_capture_id NOT IN (SELECT id FROM captures)
             OR id NOT IN (SELECT DISTINCT flow_id FROM interaction_flow_steps)`,
      )
      .all() as Array<{ id: string }>;
    if (doomed.length === 0) return 0;
    const dropSteps = this.db.prepare(`DELETE FROM interaction_flow_steps WHERE flow_id = ?`);
    const dropFlow = this.db.prepare(`DELETE FROM interaction_flows WHERE id = ?`);
    let n = 0;
    for (const { id } of doomed) {
      dropSteps.run(id);
      n += dropFlow.run(id).changes;
    }
    return n;
  }

  // ── Flow templates ─────────────────────────────────────────────────────────

  /**
   * Insert or replace a learned multi-step plan. Unique on (adapter_id, primary_key)
   * so re-learning the same primary overwrites rather than stacking duplicates.
   */
  upsertFlowTemplate(input: FlowTemplateInput): FlowTemplate {
    if (input.steps.length === 0) {
      throw new Error('upsertFlowTemplate requires at least one step');
    }
    // Prefer the existing row for this primary so re-learn overwrites cleanly
    // even when the caller omits id (or passes a stale one).
    const existing = this.getFlowTemplateByPrimary(input.adapterId, input.primaryKey);
    const id = existing?.id ?? input.id ?? newId();
    this.db
      .prepare(
        `INSERT INTO flow_templates
           (id, adapter_id, primary_key, label, sample_count, version, learned_at, steps_json, flow_params_json)
         VALUES
           (@id, @adapter_id, @primary_key, @label, @sample_count, @version, @learned_at, @steps_json, @flow_params_json)
         ON CONFLICT(id) DO UPDATE SET
           adapter_id = excluded.adapter_id,
           primary_key = excluded.primary_key,
           label = excluded.label,
           sample_count = excluded.sample_count,
           version = excluded.version,
           learned_at = excluded.learned_at,
           steps_json = excluded.steps_json,
           flow_params_json = excluded.flow_params_json`,
      )
      .run({
        id,
        adapter_id: input.adapterId,
        primary_key: input.primaryKey,
        label: input.label ?? null,
        sample_count: input.sampleCount,
        version: input.version,
        learned_at: input.learnedAt,
        steps_json: JSON.stringify(input.steps),
        flow_params_json: JSON.stringify(input.flowParams),
      });
    const got = this.getFlowTemplate(id);
    if (!got) throw new Error(`upsertFlowTemplate failed to read back ${id}`);
    return got;
  }

  getFlowTemplate(id: string): FlowTemplate | undefined {
    const row = this.db
      .prepare(`SELECT * FROM flow_templates WHERE id = ?`)
      .get(id) as FlowTemplateRow | undefined;
    return row ? rowToFlowTemplate(row) : undefined;
  }

  getFlowTemplateByPrimary(adapterId: string, primaryKey: string): FlowTemplate | undefined {
    const row = this.db
      .prepare(`SELECT * FROM flow_templates WHERE adapter_id = ? AND primary_key = ?`)
      .get(adapterId, primaryKey) as FlowTemplateRow | undefined;
    return row ? rowToFlowTemplate(row) : undefined;
  }

  listFlowTemplates(q: FlowTemplateQuery = {}): FlowTemplate[] {
    const parts: string[] = [];
    const params: Record<string, unknown> = { limit: q.limit ?? 200 };
    if (q.adapterId) {
      parts.push('adapter_id = @adapterId');
      params.adapterId = q.adapterId;
    }
    if (q.primaryKey) {
      parts.push('primary_key = @primaryKey');
      params.primaryKey = q.primaryKey;
    }
    if (q.q && q.q.trim().length > 0) {
      parts.push(`(IFNULL(label, '') LIKE @qq ESCAPE '\\' OR primary_key LIKE @qq ESCAPE '\\')`);
      params.qq = `%${escapeLike(q.q.trim())}%`;
    }
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM flow_templates ${where}
          ORDER BY learned_at DESC LIMIT @limit`,
      )
      .all(params) as FlowTemplateRow[];
    return rows.map(rowToFlowTemplate);
  }

  deleteFlowTemplate(id: string): boolean {
    return this.db.prepare(`DELETE FROM flow_templates WHERE id = ?`).run(id).changes > 0;
  }

  /** Delete all learned templates for an adapter (clearApp). */
  deleteFlowTemplates(opts: { adapterId: string }): number {
    return this.db.prepare(`DELETE FROM flow_templates WHERE adapter_id = ?`).run(opts.adapterId)
      .changes;
  }

  listWorkspaces(): Workspace[] {
    return (this.db.prepare(`SELECT * FROM workspaces ORDER BY name`).all() as WorkspaceRow[]).map(
      rowToWorkspace,
    );
  }

  /**
   * Remove a workspace and everything filed under it — actors, containers,
   * items, edges. CAPTURES ARE NOT TOUCHED.
   *
   * That last part is the contract, not an omission. Captures are the evidence
   * and entities are one reading of it, so anything that drops entities has to
   * leave the recording intact or it is a destructive operation wearing a
   * bookkeeping name. Everything this deletes can be rebuilt by re-parsing.
   *
   * The case it exists for is an identity that was provisional and has since
   * been resolved: the same mail re-parsed under the mailbox it actually belongs
   * to, with the placeholder it was parked under cleared away. Deleting rather
   * than re-pointing is deliberate — container ids EMBED the workspace id, so
   * "move these rows" would mean rewriting primary keys and every reference to
   * them, while re-parse-then-delete gets the same result out of code that is
   * already exercised on every capture.
   *
   * One transaction: a half-deleted workspace leaves items whose container is
   * gone, which reads as data loss rather than as a failed cleanup.
   */
  deleteWorkspace(workspaceId: string): { containers: number; items: number; actors: number; edges: number } {
    return this.db.transaction(() => {
      // FTS first, and via the rowid join, because `items_fts` is contentless:
      // it cannot find its own rows by value, so once the `items` rows are gone
      // their index entries are unreachable and stay in the index forever,
      // matching searches with nothing behind them.
      const orphans = this.db
        .prepare(`SELECT rowid AS rid FROM items WHERE workspace_id = ?`)
        .all(workspaceId) as Array<{ rid: number }>;
      const dropFts = this.db.prepare(`DELETE FROM items_fts WHERE rowid = ?`);
      for (const { rid } of orphans) dropFts.run(rid);

      const del = (table: string): number =>
        this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId).changes;
      const items = del('items');
      const containers = del('containers');
      const actors = del('actors');
      const edges = del('edges');
      this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(workspaceId);
      return { containers, items, actors, edges };
    })();
  }

  listContainers(workspaceId?: string): Container[] {
    const rows = workspaceId
      ? (this.db
          .prepare(`SELECT * FROM containers WHERE workspace_id = ? ORDER BY name`)
          .all(workspaceId) as ContainerRow[])
      : (this.db.prepare(`SELECT * FROM containers ORDER BY name`).all() as ContainerRow[]);
    return rows.map(rowToContainer);
  }

  listActors(workspaceId?: string): Actor[] {
    const rows = workspaceId
      ? (this.db
          .prepare(`SELECT * FROM actors WHERE workspace_id = ? ORDER BY handle`)
          .all(workspaceId) as ActorRow[])
      : (this.db.prepare(`SELECT * FROM actors ORDER BY handle`).all() as ActorRow[]);
    return rows.map(rowToActor);
  }

  /** Items in one container, newest first. */
  listItems(containerId: string, q: ItemQuery = {}): Item[] {
    return this.queryItems({ ...q, containerId });
  }

  /**
   * Items across containers, newest first.
   *
   * `listItems` is the one-container case and stays because it is by far the
   * common one; this exists because some questions are not container-shaped at
   * all. "Every thread in this mailbox" spans one container per label, and
   * answering it by looping `listItems` over each of them spends the LIMIT
   * per-container and then has to merge and re-sort in memory — which returns the
   * wrong page as soon as there is more than one page.
   */
  queryItems(q: ItemFilter = {}): Item[] {
    const { clause, params } = itemWhere(q);
    const rows = this.db
      .prepare(`SELECT * FROM items ${clause} ORDER BY ts DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: q.limit ?? 200, offset: q.offset ?? 0 }) as ItemRow[];
    return rows.map(rowToItem);
  }

  /**
   * Items whose parse cited this capture as a source — the "what did this
   * exchange yield?" lookup behind the inspector's Entities tab.
   *
   * `source_capture_ids` is a JSON array with no index, so this is a bounded LIKE
   * scan. The capture id is a full quoted token (`"<id>"`), which is selective —
   * one id cannot be a prefix of another when both are quoted on each side — and
   * the LIMIT caps the work. Only `items` carry the capture linkage today.
   */
  itemsForCapture(captureId: string, limit = 200): Item[] {
    const esc = captureId.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare(
        `SELECT * FROM items WHERE source_capture_ids LIKE @needle ESCAPE '\\' ORDER BY ts DESC LIMIT @limit`,
      )
      .all({ needle: `%"${esc}"%`, limit }) as ItemRow[];
    return rows.map(rowToItem);
  }

  /** How many items match, ignoring `limit`/`offset` — the total behind a page. */
  countItems(q: ItemFilter = {}): number {
    const { clause, params } = itemWhere(q);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM items ${clause}`).get(params) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * Full-text search over item text, optionally within one container or one
   * adapter.
   *
   * Stemmed (`porter`), unlike the capture-body index: item text is prose a human
   * wrote, so matching "running" for "run" is what someone searching their own
   * message history expects. Capture bodies are machine JSON, where stemming
   * would only mangle identifiers.
   *
   * `adapterId` filters in SQL rather than leaving it to the caller, because the
   * two are not the same search: filtering afterwards drops rows the LIMIT
   * already spent, so a mailbox search in a store that also holds Slack comes
   * back short — and looks like the mail simply is not there.
   */
  searchItems(text: string, q: ItemSearchQuery = {}): Item[] {
    const match = ftsQuery(text);
    if (match === undefined) return [];
    const where = ['rowid IN (SELECT rowid FROM items_fts WHERE items_fts MATCH @match)'];
    if (q.containerId) where.push('container_id = @containerId');
    if (q.adapterId) where.push('adapter_id = @adapterId');
    const rows = this.db
      .prepare(
        `SELECT * FROM items WHERE ${where.join(' AND ')}
          ORDER BY ts DESC LIMIT @limit OFFSET @offset`,
      )
      .all({
        match,
        containerId: q.containerId,
        adapterId: q.adapterId,
        limit: q.limit ?? 200,
        offset: q.offset ?? 0,
      }) as ItemRow[];
    return rows.map(rowToItem);
  }

  // ── Sessions (redacted only) ─────────────────────────────────────────────────

  upsertSession(s: RedactedSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, adapter_id, workspace_id, label, source, discovered_at, credential_kinds)
         VALUES (@id, @adapter_id, @workspace_id, @label, @source, @discovered_at, @credential_kinds)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label, workspace_id = excluded.workspace_id,
           credential_kinds = excluded.credential_kinds`,
      )
      .run({
        id: s.id,
        adapter_id: s.adapterId,
        workspace_id: s.workspaceId ?? null,
        label: s.label,
        source: s.source,
        discovered_at: s.discoveredAt,
        credential_kinds: JSON.stringify(s.credentialKinds),
      });
  }

  listSessions(): RedactedSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY discovered_at DESC`)
      .all() as SessionRow[];
    return rows.map((r) => ({
      id: r.id,
      adapterId: r.adapter_id,
      workspaceId: r.workspace_id ?? undefined,
      label: r.label,
      source: r.source as RedactedSession['source'],
      discoveredAt: r.discovered_at,
      credentialKinds: (unj<string[]>(r.credential_kinds) ?? []) as string[],
    }));
  }

  close(): void {
    this.db.close();
  }
}

// ── Row shapes + mappers ───────────────────────────────────────────────────────

interface CaptureRow {
  id: string;
  ts: number;
  source: string;
  adapter_id: string | null;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  duration_ms: number | null;
  req_headers: string;
  /** string when plain, Buffer when the matching `*_body_encoding` says gzip. */
  req_body: string | Buffer | null;
  res_headers: string;
  res_body: string | Buffer | null;
  pid: number | null;
  process_name: string | null;
  tab_id: string | null;
  tab_url: string | null;
  loader_id: string | null;
  page_load_id: string | null;
  navigation_id: string | null;
  direction: string | null;
  ws_id: string | null;
  classification: string | null;
  parsed_at: number | null;
  req_body_encoding: string | null;
  res_body_encoding: string | null;
}
interface EdgeRow {
  src_kind: string;
  src_id: string;
  rel: string;
  dst_kind: string;
  dst_id: string;
  adapter_id: string;
  workspace_id: string | null;
  raw: string | null;
  updated_ts: number;
}
interface CursorRow {
  id: string;
  adapter_id: string;
  action_id: string;
  container_id: string | null;
  cursor: string | null;
  params: string | null;
  state: string;
  attempts: number;
  last_error: string | null;
  created_ts: number;
  updated_ts: number;
}
interface FlowRow {
  id: string;
  adapter_id: string;
  label: string | null;
  primary_capture_id: string;
  started_at: number;
  ended_at: number;
  source: string;
}
interface FlowStepRow {
  capture_id: string;
  seq: number;
  role: string;
  operation: string | null;
  required: number;
}
interface FlowTemplateRow {
  id: string;
  adapter_id: string;
  primary_key: string;
  label: string | null;
  sample_count: number;
  version: number;
  learned_at: number;
  steps_json: string;
  flow_params_json: string;
}
interface WorkspaceRow {
  id: string;
  adapter_id: string;
  name: string;
  domain: string | null;
  raw: string | null;
  updated_ts: number;
}
interface ActorRow {
  id: string;
  workspace_id: string;
  adapter_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  raw: string | null;
  updated_ts: number;
}
interface ContainerRow {
  id: string;
  workspace_id: string;
  adapter_id: string;
  kind: string;
  name: string;
  topic: string | null;
  is_private: number | null;
  member_count: number | null;
  item_count: number | null;
  unread_count: number | null;
  raw: string | null;
  updated_ts: number;
}
interface ItemRow {
  id: string;
  container_id: string;
  workspace_id: string;
  adapter_id: string;
  kind: string;
  author_id: string | null;
  ts: number;
  text: string;
  thread_id: string | null;
  source_capture_ids: string | null;
  raw: string | null;
}
interface SessionRow {
  id: string;
  adapter_id: string;
  workspace_id: string | null;
  label: string;
  source: string;
  discovered_at: number;
  credential_kinds: string;
}

function rowToCapture(r: CaptureRow): Capture {
  return {
    id: r.id,
    ts: r.ts,
    source: r.source as Capture['source'],
    adapterId: r.adapter_id,
    method: r.method,
    url: r.url,
    host: r.host,
    path: r.path,
    status: r.status,
    durationMs: r.duration_ms,
    reqHeaders: (unj<Record<string, string>>(r.req_headers) ?? {}) as Record<string, string>,
    // Decoding here is what keeps `Capture.reqBody`/`resBody` a plain string for
    // the ~20 readers downstream — none of them know compression exists.
    reqBody: decodeBody(r.req_body, r.req_body_encoding),
    resHeaders: (unj<Record<string, string>>(r.res_headers) ?? {}) as Record<string, string>,
    resBody: decodeBody(r.res_body, r.res_body_encoding),
    pid: r.pid,
    processName: r.process_name,
    tabId: r.tab_id,
    tabUrl: r.tab_url,
    loaderId: r.loader_id,
    pageLoadId: r.page_load_id,
    navigationId: r.navigation_id,
    direction: (r.direction as Capture['direction']) ?? null,
    wsId: r.ws_id,
    classification: r.classification,
    parsedAt: r.parsed_at,
  };
}
function rowToEdge(r: EdgeRow): Edge {
  return {
    srcKind: r.src_kind as Edge['srcKind'],
    srcId: r.src_id,
    rel: r.rel,
    dstKind: r.dst_kind as Edge['dstKind'],
    dstId: r.dst_id,
    adapterId: r.adapter_id,
    workspaceId: r.workspace_id ?? undefined,
    raw: unj(r.raw),
  };
}
function rowToWorkItem(r: CursorRow): WorkItem {
  return {
    id: r.id,
    adapterId: r.adapter_id,
    actionId: r.action_id,
    containerId: r.container_id ?? undefined,
    cursor: r.cursor ?? undefined,
    params: unj<Record<string, string>>(r.params),
    state: r.state as CursorState,
    attempts: r.attempts,
    lastError: r.last_error ?? undefined,
    createdTs: r.created_ts,
    updatedTs: r.updated_ts,
  };
}
function rowToFlowTemplate(r: FlowTemplateRow): FlowTemplate {
  return {
    id: r.id,
    adapterId: r.adapter_id,
    primaryKey: r.primary_key,
    label: r.label ?? undefined,
    sampleCount: r.sample_count,
    version: r.version,
    learnedAt: r.learned_at,
    steps: (unj<FlowTemplate['steps']>(r.steps_json) ?? []) as FlowTemplate['steps'],
    flowParams: (unj<FlowTemplate['flowParams']>(r.flow_params_json) ??
      []) as FlowTemplate['flowParams'],
  };
}
function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    adapterId: r.adapter_id,
    name: r.name,
    domain: r.domain ?? undefined,
    raw: unj(r.raw),
  };
}
function rowToActor(r: ActorRow): Actor {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    adapterId: r.adapter_id,
    handle: r.handle,
    displayName: r.display_name ?? undefined,
    avatarUrl: r.avatar_url ?? undefined,
    raw: unj(r.raw),
  };
}
function rowToContainer(r: ContainerRow): Container {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    adapterId: r.adapter_id,
    kind: r.kind as Container['kind'],
    name: r.name,
    topic: r.topic ?? undefined,
    isPrivate: r.is_private === null ? undefined : r.is_private === 1,
    memberCount: r.member_count ?? undefined,
    itemCount: r.item_count ?? undefined,
    unreadCount: r.unread_count ?? undefined,
    raw: unj(r.raw),
  };
}
function rowToItem(r: ItemRow): Item {
  return {
    id: r.id,
    containerId: r.container_id,
    workspaceId: r.workspace_id,
    adapterId: r.adapter_id,
    kind: r.kind as Item['kind'],
    authorId: r.author_id ?? undefined,
    ts: r.ts,
    text: r.text,
    threadId: r.thread_id ?? undefined,
    sourceCaptureIds: unj<string[]>(r.source_capture_ids),
    raw: unj(r.raw),
  };
}

/**
 * Project a store down to {@link ReadOnlyStore} — the view an app's MCP tools get.
 *
 * A fresh object with bound methods rather than the store itself. `SqliteStore`
 * already satisfies `ReadOnlyStore` structurally, so passing it directly would
 * type-check and would hand an app tool `insertCapture`, `pruneCaptures` and the
 * raw `db` handle along with the reads. Narrowing by TYPE alone is a promise the
 * receiver can walk straight through with a cast; narrowing by VALUE is not.
 */
export function readOnlyStore(store: SqliteStore): ReadOnlyStore {
  return {
    listWorkspaces: () => store.listWorkspaces(),
    listContainers: (workspaceId) => store.listContainers(workspaceId),
    listItems: (containerId, q) => store.listItems(containerId, q),
    queryItems: (q) => store.queryItems(q),
    countItems: (q) => store.countItems(q),
    searchItems: (text, q) => store.searchItems(text, q),
    listEdges: (q) => store.listEdges(q),
    countCaptures: (q) => store.countCaptures(q),
    newestCaptureTs: (q) => store.newestCaptureTs(q),
  };
}
