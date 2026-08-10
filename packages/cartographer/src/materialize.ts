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
 */
import { createHash } from 'node:crypto';
import type { SqliteStore } from '@sluice/core';
import { inferSchema } from './infer.js';
import type { InferredColumn, InferredTable } from './infer.js';
import { parseJsonObject, quoteIdent, sanitizeName } from './util.js';

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

/**
 * Shared scan used by both deriveTables and materialize.
 *
 * `sinceTs` bounds the scan to captures newer than a watermark. This matters a
 * lot on the live path: the runner re-materializes every couple of seconds while
 * capture is running, and a full scan means loading every row — response bodies
 * included, up to 5 MB each — and re-upserting every record ever seen, on the
 * event loop, forever growing. Upserts are keyed and idempotent, so processing
 * only new captures leaves exactly the same table contents.
 */
function collect(store: SqliteStore, sinceTs?: number): Derived[] {
  const captures = store.listCaptures({ limit: ALL, sinceTs });
  const collectors = new Map<string, Collector>();

  for (const c of captures) {
    const adapterId = c.adapterId;
    if (!adapterId) continue; // unclassified traffic → no per-app table
    const body = parseJsonObject(c.resBody);
    if (!body) continue;
    for (const key of Object.keys(body)) {
      const recs = arrayOfObjects(body[key]);
      if (!recs) continue;
      const base = baseNameFor(key);
      const name = `${sanitizeName(adapterId)}_${sanitizeName(base)}`;
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

function createOrAlterTable(store: SqliteStore, spec: TableSpec): void {
  const hasId = spec.primaryKey === 'id';
  const defs: string[] = [];
  if (!hasId) defs.push(`"__pk" TEXT PRIMARY KEY`);
  for (const [name, col] of Object.entries(spec.columns)) {
    let def = `${quoteIdent(name)} ${col.sqliteType}`;
    if (hasId && name === 'id') def += ' PRIMARY KEY';
    defs.push(def);
  }
  store.db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(spec.name)} (${defs.join(', ')})`);

  // The runner may re-materialize as new fields appear; add any missing columns.
  const existing = new Set(
    (store.db.prepare(`PRAGMA table_info(${quoteIdent(spec.name)})`).all() as Array<{
      name: string;
    }>).map((r) => r.name),
  );
  for (const [name, col] of Object.entries(spec.columns)) {
    if (!existing.has(name)) {
      store.db.exec(`ALTER TABLE ${quoteIdent(spec.name)} ADD COLUMN ${quoteIdent(name)} ${col.sqliteType}`);
    }
  }
}

function insertRecords(
  store: SqliteStore,
  spec: TableSpec,
  records: Array<Record<string, unknown>>,
): void {
  const colNames = Object.keys(spec.columns);
  const hasId = spec.primaryKey === 'id';
  const allCols = hasId ? colNames : ['__pk', ...colNames];
  const columnList = allCols.map(quoteIdent).join(', ');
  const placeholders = allCols.map(() => '?').join(', ');
  const stmt = store.db.prepare(
    `INSERT OR REPLACE INTO ${quoteIdent(spec.name)} (${columnList}) VALUES (${placeholders})`,
  );
  for (const rec of records) {
    const values = colNames.map((n) => toBindable(rec[n]));
    stmt.run(hasId ? values : [contentHash(rec), ...values]);
  }
}

/**
 * CREATE (if needed) and upsert every derived table into the store's db.
 * Idempotent: re-running with the same captures yields the same rows.
 *
 * Pass `sinceTs` to process only captures newer than a watermark — the live
 * rebuild path does this so its cost tracks new traffic rather than total store
 * size. Omit it for a full rebuild (`sluice build-db`).
 */
/**
 * Core tables `dropMaterialized` must NEVER drop, whatever an adapter is named.
 * Belt to the prefix suspenders below: even an adapter id that collided with a
 * core name could not take one of these out.
 */
const CORE_TABLES = new Set([
  'captures',
  'workspaces',
  'actors',
  'containers',
  'items',
  'edges',
  'cursors',
  'sessions',
]);

/**
 * Drop the materialized per-app tables for the given adapters, returning the
 * names dropped.
 *
 * Materialize is INSERT-OR-REPLACE only — it never deletes — so after any
 * capture-delete the derived tables still describe captures that are gone. The
 * fix is drop + full rebuild, and this is the drop half. It matches on the
 * `<adapterId>_` prefix these tables are minted with, and refuses to touch a
 * core table, so it can only ever remove tables materialize itself created.
 */
export function dropMaterialized(store: SqliteStore, adapterIds: string[]): string[] {
  const prefixes = adapterIds.map((id) => `${sanitizeName(id)}_`);
  const all = (
    store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const dropped: string[] = [];
  const tx = store.db.transaction(() => {
    for (const name of all) {
      if (CORE_TABLES.has(name)) continue;
      if (name.endsWith('_fts') || name.includes('_fts_')) continue; // FTS shadow tables
      if (prefixes.some((p) => name.startsWith(p))) {
        store.db.exec(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
        dropped.push(name);
      }
    }
  });
  tx();
  return dropped;
}

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
