// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Per-app table derivation + materialization.
 *
 * `deriveTables` scans response bodies for array-of-objects collections
 * (conversations.list → `channels`, users.list → `members`,
 * conversations.history → `messages`, …) and proposes one prefixed table per
 * (app, collection). `materialize` then CREATEs those tables in the SAME SQLite
 * db the store owns and upserts the observed records — idempotently.
 *
 * Only *response* record objects are materialized (never request bodies, which
 * are where the redacted token lives), and rows are keyed so a re-run never
 * duplicates data.
 *
 * ## Primary-key strategy is sticky
 *
 * A fresh table keys on `id` when the *current* batch's records carry one, else
 * on a content-hash column `__pk`. Live materialize is incremental (`sinceTs`),
 * so a later batch can disagree with the first — e.g. one Slack endpoint emits
 * items with `id`, another emits id-less rows into the same `slack_item`
 * collector. `CREATE TABLE IF NOT EXISTS` will not rewrite the first schema, and
 * blindly inserting `__pk` into an id-keyed table throws
 * `table … has no column named __pk` and aborts the whole transaction (every
 * app's rebuild). Inserts always follow the **existing** table's key column;
 * id-less rows are skipped on an id-keyed table rather than crashing.
 */
import { createHash } from 'node:crypto';
import { CORE_TABLE_NAMES, safeJsonObject } from '@sluice/core';
import type { SqliteStore } from '@sluice/core';
import { inferSchema } from './infer.js';
import type { InferredColumn, InferredTable } from './infer.js';
import { quoteIdent, sanitizeName } from './util.js';

const ALL = 1_000_000;

/** Map a Slack-ish collection key to a singular table base name. */
const COLLECTION_ALIASES: Record<string, string> = {
  channels: 'channel',
  ims: 'channel',
  groups: 'channel',
  mpims: 'channel',
  members: 'user',
  users: 'user',
  messages: 'message',
  files: 'file',
};

export interface TableSpec {
  /** prefixed table name, e.g. `slack_channel` */
  name: string;
  /** owning app / adapter id, e.g. `slack` */
  adapterId: string;
  /** singular base name, e.g. `channel` */
  base: string;
  /** the response keys that fed this table, e.g. `['channels']` (or ims/groups too) */
  sourceKeys: string[];
  /** `'id'` when the records carry an id column, else null */
  primaryKey: string | null;
  columns: Record<string, InferredColumn>;
  /** number of source records observed across all captures */
  rows: number;
  /** the full inferred table (columns + record total) */
  table: InferredTable;
}

export interface MaterializeResult {
  tables: { name: string; rows: number }[];
}

export interface MaterializeOptions {
  /**
   * Only process captures with `ts` at or after this watermark. Upserts are
   * keyed and idempotent, so a bounded scan yields the same tables as a full one
   * while costing a fraction of the work on a large store.
   */
  sinceTs?: number;
}

function baseNameFor(key: string): string {
  const alias = COLLECTION_ALIASES[key];
  if (alias) return alias;
  if (key.endsWith('ies')) return `${key.slice(0, -3)}y`;
  if (key.endsWith('ses')) return key.slice(0, -2);
  if (key.endsWith('s')) return key.slice(0, -1);
  return key;
}

/** A non-empty array whose every element is a plain object, else null. */
function arrayOfObjects(v: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const el of v) {
    if (el === null || typeof el !== 'object' || Array.isArray(el)) return null;
    out.push(el as Record<string, unknown>);
  }
  return out;
}

interface Collector {
  adapterId: string;
  base: string;
  sourceKeys: Set<string>;
  records: Array<Record<string, unknown>>;
}

interface Derived {
  spec: TableSpec;
  records: Array<Record<string, unknown>>;
}

/** Shared scan used by deriveTables and materialize; `sinceTs` bounds it (see MaterializeOptions). */
function collect(store: SqliteStore, sinceTs?: number): Derived[] {
  const captures = store.listCaptures({ limit: ALL, sinceTs });
  const collectors = new Map<string, Collector>();

  for (const c of captures) {
    const adapterId = c.adapterId;
    if (!adapterId) continue; // unclassified traffic → no per-app table
    const body = safeJsonObject(c.resBody);
    if (!body) continue;
    for (const key of Object.keys(body)) {
      const recs = arrayOfObjects(body[key]);
      if (!recs) continue;
      const base = baseNameFor(key);
      const name = `${sanitizeName(adapterId)}_${sanitizeName(base)}`;
      // An adapter id plus a body key can spell a core table (`interaction` +
      // `flowss` → interaction_flows) or an FTS one; never derive into those.
      if (isReservedTable(name)) continue;
      let col = collectors.get(name);
      if (!col) {
        col = { adapterId, base, sourceKeys: new Set(), records: [] };
        collectors.set(name, col);
      }
      col.sourceKeys.add(key);
      for (const r of recs) col.records.push(r);
    }
  }

  const derived: Derived[] = [];
  for (const [name, col] of collectors) {
    const table = inferSchema(col.records);
    const primaryKey = Object.hasOwn(table.columns, 'id') ? 'id' : null;
    derived.push({
      spec: {
        name,
        adapterId: col.adapterId,
        base: col.base,
        sourceKeys: [...col.sourceKeys].sort(),
        primaryKey,
        columns: table.columns,
        rows: col.records.length,
        table,
      },
      records: col.records,
    });
  }
  derived.sort((a, b) => a.spec.name.localeCompare(b.spec.name));
  return derived;
}

/** Propose per-app tables from array-of-objects collections in response bodies. */
export function deriveTables(store: SqliteStore): TableSpec[] {
  return collect(store).map((d) => d.spec);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
}

/** Stable content hash — the synthetic primary key for collections that lack an `id`. */
function contentHash(rec: Record<string, unknown>): string {
  return createHash('sha1').update(stableStringify(rec)).digest('hex');
}

/** Coerce a JS value into something better-sqlite3 will bind. */
function toBindable(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

interface ColInfo {
  name: string;
}

function tableInfo(store: SqliteStore, table: string): ColInfo[] {
  return store.db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as ColInfo[];
}

/** Column names of a table, in declaration order. Allowlist `table` first (see listMaterializedTables). */
export function tableColumns(store: SqliteStore, table: string): string[] {
  return tableInfo(store, table).map((c) => c.name);
}

/**
 * How rows are keyed in an already-created table, or how a new one should be.
 *
 * Existing wins (`__pk` if it has one, else `id` when present): an incremental
 * batch must not invent `__pk` against an id-keyed table (or drop `id` as the
 * conflict target). Fresh tables follow the batch.
 */
function keyMode(store: SqliteStore, spec: TableSpec): 'id' | '__pk' {
  const cols = tableInfo(store, spec.name);
  if (cols.length === 0) return spec.primaryKey === 'id' ? 'id' : '__pk';
  if (cols.some((c) => c.name === '__pk')) return '__pk';
  return cols.some((c) => c.name === 'id') ? 'id' : '__pk';
}

function createOrAlterTable(store: SqliteStore, spec: TableSpec): void {
  const existing = tableInfo(store, spec.name);
  if (existing.length === 0) {
    const useId = spec.primaryKey === 'id';
    const defs: string[] = [];
    if (!useId) defs.push(`"__pk" TEXT PRIMARY KEY`);
    for (const [name, col] of Object.entries(spec.columns)) {
      let def = `${quoteIdent(name)} ${col.sqliteType}`;
      if (useId && name === 'id') def += ' PRIMARY KEY';
      defs.push(def);
    }
    store.db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(spec.name)} (${defs.join(', ')})`);
  }

  // The runner may re-materialize as new fields appear; add any missing columns.
  // Never add `__pk` to an id-keyed table — inserts follow keyMode(), and a
  // half-migrated PK is worse than skipping id-less rows.
  const have = new Set(tableInfo(store, spec.name).map((r) => r.name));
  for (const [name, col] of Object.entries(spec.columns)) {
    if (!have.has(name)) {
      store.db.exec(
        `ALTER TABLE ${quoteIdent(spec.name)} ADD COLUMN ${quoteIdent(name)} ${col.sqliteType}`,
      );
    }
  }
}

function insertRecords(
  store: SqliteStore,
  spec: TableSpec,
  records: Array<Record<string, unknown>>,
): void {
  const colNames = Object.keys(spec.columns);
  const mode = keyMode(store, spec);
  const allCols = mode === 'id' ? colNames : ['__pk', ...colNames];
  // Ensure every INSERT column exists (createOrAlter only adds spec.columns).
  if (mode === '__pk' && !tableColumns(store, spec.name).includes('__pk')) {
    // Table existed without __pk and without an id PK — last-resort column so
    // inserts can proceed. Not a PRIMARY KEY (SQLite can't ADD that); uniqueness
    // is best-effort via REPLACE on the rowid-less path only when __pk was PK.
    // Prefer drop+rebuild via sluice build-db for a clean schema.
    store.db.exec(`ALTER TABLE ${quoteIdent(spec.name)} ADD COLUMN "__pk" TEXT`);
  }
  const columnList = allCols.map(quoteIdent).join(', ');
  const placeholders = allCols.map(() => '?').join(', ');
  const stmt = store.db.prepare(
    `INSERT OR REPLACE INTO ${quoteIdent(spec.name)} (${columnList}) VALUES (${placeholders})`,
  );
  for (const rec of records) {
    if (mode === 'id') {
      // Id-keyed table: skip id-less rows rather than inventing a second key.
      if (rec.id === undefined || rec.id === null) continue;
      stmt.run(colNames.map((n) => toBindable(rec[n])));
    } else {
      stmt.run([contentHash(rec), ...colNames.map((n) => toBindable(rec[n]))]);
    }
  }
}

/**
 * Core tables materialize must never create, write or drop, whatever an adapter
 * is named. Core owns the list, so a table it adds cannot drift out of it.
 */
const CORE_TABLES: ReadonlySet<string> = new Set(CORE_TABLE_NAMES);

/** A table materialize must never create, write, or drop: a core table, an FTS5 table or shadow table, or SQLite's own. */
function isReservedTable(name: string): boolean {
  return CORE_TABLES.has(name) || name.endsWith('_fts') || name.includes('_fts_') || name.startsWith('sqlite_');
}

/** A materialized per-app table and the adapter that owns it. */
export interface MaterializedTable {
  name: string;
  adapterId: string;
}

/**
 * The materialized per-app tables for the given adapters, by name.
 *
 * The one listing of what materialize created: a table belongs to the adapter
 * whose `<sanitizeName(id)>_` prefix it carries (the longest one, when ids nest),
 * and a reserved table never belongs to anyone. Callers that interpolate a table
 * name into SQL should allowlist against this.
 */
export function listMaterializedTables(store: SqliteStore, adapterIds: readonly string[]): MaterializedTable[] {
  const prefixes = adapterIds.map((id) => ({ id, prefix: `${sanitizeName(id)}_` }));
  const names = (
    store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out: MaterializedTable[] = [];
  for (const name of names) {
    if (isReservedTable(name)) continue;
    let best: { id: string; prefix: string } | undefined;
    for (const p of prefixes) {
      if (name.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
    }
    if (best) out.push({ name, adapterId: best.id });
  }
  return out;
}

/**
 * Drop exactly the tables {@link listMaterializedTables} lists for the given
 * adapters, returning their names — the drop half of {@link rebuildMaterialized},
 * so it can only remove tables materialize itself created.
 */
export function dropMaterialized(store: SqliteStore, adapterIds: readonly string[]): string[] {
  const names = listMaterializedTables(store, adapterIds).map((t) => t.name);
  const tx = store.db.transaction(() => {
    for (const name of names) store.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
  });
  tx();
  return names;
}

/**
 * `meta` key holding the timestamp the derived tables are built through.
 *
 * Shared by the CLI's boot pass and the server's debounced live pass, because a
 * watermark only works if every writer agrees where it is.
 */
export const MATERIALIZE_WATERMARK_KEY = 'materialize.through_ts';

/**
 * How far the watermark is rewound when it is written.
 *
 * A capture inserted while a pass was scanning would otherwise fall in the gap
 * between "the pass started" and "the watermark says done". Re-processing a few
 * seconds of captures is idempotent and cheap; missing one is permanent.
 */
const WATERMARK_REWIND_MS = 5_000;

export interface IncrementalResult extends MaterializeResult {
  /** True when no usable watermark existed, so this pass scanned the whole store. */
  fullRebuild: boolean;
  /** Wall-clock cost of the pass, for callers that report slow first builds. */
  elapsedMs: number;
}

/**
 * Materialize only what arrived since the last pass, then move the watermark, so a
 * boot on a large store does not block the event loop re-deriving every row before
 * the dashboard binds. The first call on an existing store pays the one full scan
 * that establishes the watermark.
 */
export function materializeIncremental(store: SqliteStore): IncrementalResult {
  const sinceTs = store.getMetaNumber(MATERIALIZE_WATERMARK_KEY);
  const startedAt = Date.now();
  const { tables } = materialize(store, { sinceTs });
  store.setMetaNumber(MATERIALIZE_WATERMARK_KEY, startedAt - WATERMARK_REWIND_MS);
  return { tables, fullRebuild: sinceTs === undefined, elapsedMs: Date.now() - startedAt };
}

/**
 * Drop + fully rebuild the derived tables for the given adapters, returning the
 * tables the rebuild produced.
 *
 * The integrity rule: `materialize` is INSERT-OR-REPLACE only, so it never
 * removes rows for captures that were just deleted. After ANY capture delete,
 * the derived tables must be dropped and rebuilt from scratch — an incremental
 * re-materialize would leave the deleted captures' rows behind, and a surviving
 * watermark would let the next incremental pass skip the captures that remain.
 *
 * Known limits: tables of an adapter this process has not loaded (an external
 * adapter missing from the registry) are not dropped. A full materialize is
 * synchronous — tens of seconds on a large store — which is the price of
 * retention actually removing derived message text.
 */
export function rebuildMaterialized(store: SqliteStore, adapterIds: readonly string[]): MaterializeResult['tables'] {
  dropMaterialized(store, adapterIds);
  store.deleteMeta(MATERIALIZE_WATERMARK_KEY); // if the rebuild below throws, the next incremental pass must be full
  const startedAt = Date.now(); // before collect() reads: a capture stored mid-rebuild must stay above the watermark
  const { tables } = materialize(store);
  store.setMetaNumber(MATERIALIZE_WATERMARK_KEY, startedAt - WATERMARK_REWIND_MS);
  return tables;
}

/**
 * CREATE (if needed) and upsert every derived table into the store's db.
 * Idempotent: re-running with the same captures yields the same rows.
 *
 * Pass `sinceTs` to process only captures newer than a watermark — the live
 * rebuild path does this so its cost tracks new traffic rather than total store
 * size. Omit it for a full rebuild (`sluice build-db`).
 */
export function materialize(store: SqliteStore, opts: MaterializeOptions = {}): MaterializeResult {
  const derived = collect(store, opts.sinceTs);
  const tables: { name: string; rows: number }[] = [];
  const tx = store.db.transaction(() => {
    for (const { spec, records } of derived) {
      createOrAlterTable(store, spec);
      insertRecords(store, spec, records);
      const row = store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(spec.name)}`)
        .get() as { n: number };
      tables.push({ name: spec.name, rows: row.n });
    }
  });
  tx();
  return { tables };
}
