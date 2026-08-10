// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Schema inference — the pure, store-agnostic core of the cartographer.
 *
 *  - `inferJsonSchema` builds a merged, recursive JSON schema from many sample
 *    values (used for the endpoint catalog's response shape).
 *  - `inferSchema` flattens a collection of record objects into a per-column
 *    SQLite type plan (used to materialize per-app tables).
 *
 * Both infer *shape* only. Values are never retained, so a secret that somehow
 * rode along in a response can't leak out through a schema.
 */

export type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

/** A recursively-inferred schema for a JSON value observed across many samples. */
export interface JsonSchema {
  /** union of JSON types observed at this position (deduped, sorted) */
  types: JsonType[];
  /** true if a null was observed here, or (for a property) it was absent in some parent samples */
  nullable: boolean;
  /** when an object was observed: per-key schema */
  properties?: Record<string, JsonSchema>;
  /** when an array was observed: the merged schema of all its elements */
  items?: JsonSchema;
  /** (object properties only) number of parent object samples that carried this key */
  present?: number;
  /** (object properties only) number of parent object samples observed in total */
  total?: number;
}

export function jsonTypeOf(v: unknown): JsonType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  switch (typeof v) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      // undefined / function / symbol / bigint → treat as absent-ish
      return 'null';
  }
}

interface Acc {
  types: Set<JsonType>;
  nullSeen: boolean;
  objectSamples: number;
  props: Map<string, { acc: Acc; present: number }>;
  arraySeen: boolean;
  items?: Acc;
}

function newAcc(): Acc {
  return {
    types: new Set(),
    nullSeen: false,
    objectSamples: 0,
    props: new Map(),
    arraySeen: false,
  };
}

function mergeInto(acc: Acc, value: unknown): void {
  const t = jsonTypeOf(value);
  acc.types.add(t);
  if (t === 'null') {
    acc.nullSeen = true;
    return;
  }
  if (t === 'object') {
    acc.objectSamples++;
    const rec = value as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      let entry = acc.props.get(key);
      if (!entry) {
        entry = { acc: newAcc(), present: 0 };
        acc.props.set(key, entry);
      }
      entry.present++;
      mergeInto(entry.acc, rec[key]);
    }
    return;
  }
  if (t === 'array') {
    acc.arraySeen = true;
    for (const el of value as unknown[]) {
      acc.items = acc.items ?? newAcc();
      mergeInto(acc.items, el);
    }
  }
}

function finalize(acc: Acc): JsonSchema {
  const schema: JsonSchema = {
    types: [...acc.types].sort(),
    nullable: acc.nullSeen,
  };
  if (acc.objectSamples > 0) {
    const properties: Record<string, JsonSchema> = {};
    for (const [key, entry] of acc.props) {
      const child = finalize(entry.acc);
      child.present = entry.present;
      child.total = acc.objectSamples;
      // nullable if an explicit null was seen OR the key was absent in some samples
      child.nullable = child.nullable || entry.present < acc.objectSamples;
      properties[key] = child;
    }
    schema.properties = properties;
  }
  if (acc.arraySeen) {
    schema.items = acc.items ? finalize(acc.items) : { types: [], nullable: false };
  }
  return schema;
}

/** Merge many JSON sample values into one recursive schema. */
export function inferJsonSchema(values: Iterable<unknown>): JsonSchema {
  const acc = newAcc();
  for (const v of values) mergeInto(acc, v);
  return finalize(acc);
}

// ── Tabular inference (for SQLite materialization) ──────────────────────────────

export type SqliteType = 'TEXT' | 'INTEGER' | 'REAL';

export interface InferredColumn {
  sqliteType: SqliteType;
  /** true if the field was null or absent in at least one record */
  nullable: boolean;
  /** number of records that carried this field */
  present: number;
  /** total number of records inspected */
  total: number;
}

export interface InferredTable {
  columns: Record<string, InferredColumn>;
  total: number;
}

interface ColAcc {
  present: number;
  sawNull: boolean;
  text: boolean;
  real: boolean;
  int: boolean;
  bool: boolean;
}

/**
 * Flatten record objects into a per-column SQLite plan.
 *   boolean → INTEGER (stored 0/1), integer → INTEGER, float → REAL,
 *   string / nested object / array → TEXT (nested values are stored as JSON).
 * Any column that mixes a text/nested value in with numbers collapses to TEXT.
 */
export function inferSchema(records: Array<Record<string, unknown>>): InferredTable {
  const total = records.length;
  const cols = new Map<string, ColAcc>();
  const order: string[] = [];

  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      let c = cols.get(key);
      if (!c) {
        c = { present: 0, sawNull: false, text: false, real: false, int: false, bool: false };
        cols.set(key, c);
        order.push(key);
      }
      c.present++;
      const v = rec[key];
      if (v === null || v === undefined) {
        c.sawNull = true;
        continue;
      }
      switch (typeof v) {
        case 'string':
          c.text = true;
          break;
        case 'boolean':
          c.bool = true;
          break;
        case 'number':
          if (Number.isInteger(v)) c.int = true;
          else c.real = true;
          break;
        default:
          // object / array / other → serialized as JSON text
          c.text = true;
      }
    }
  }

  const columns: Record<string, InferredColumn> = {};
  for (const key of order) {
    const c = cols.get(key);
    if (!c) continue;
    let sqliteType: SqliteType;
    if (c.text) sqliteType = 'TEXT';
    else if (c.real) sqliteType = 'REAL';
    else if (c.int) sqliteType = 'INTEGER';
    else if (c.bool) sqliteType = 'INTEGER';
    else sqliteType = 'TEXT';
    columns[key] = {
      sqliteType,
      nullable: c.sawNull || c.present < total,
      present: c.present,
      total,
    };
  }
  return { columns, total };
}
