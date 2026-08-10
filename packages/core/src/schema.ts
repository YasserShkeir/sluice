// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite schema. Idempotent (IF NOT EXISTS) so migrate() is safe to call on
 * every startup. No table here may ever hold a secret — the `captures` rows are
 * secret-redacted before insertion, and there is deliberately no credentials table.
 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS captures (
  id           TEXT PRIMARY KEY,
  ts           INTEGER NOT NULL,
  source       TEXT NOT NULL,
  adapter_id   TEXT,
  method       TEXT NOT NULL,
  url          TEXT NOT NULL,
  host         TEXT NOT NULL,
  path         TEXT NOT NULL,
  status       INTEGER,
  duration_ms  INTEGER,
  req_headers  TEXT NOT NULL DEFAULT '{}',
  req_body     TEXT,
  res_headers  TEXT NOT NULL DEFAULT '{}',
  res_body     TEXT,
  pid          INTEGER,
  process_name TEXT,
  tab_id       TEXT,
  tab_url      TEXT,
  direction    TEXT,
  ws_id        TEXT,
  classification    TEXT,
  parsed_at         INTEGER,
  req_body_encoding TEXT,
  res_body_encoding TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_ts   ON captures(ts);
CREATE INDEX IF NOT EXISTS idx_captures_host ON captures(host);
CREATE INDEX IF NOT EXISTS idx_captures_adapter ON captures(adapter_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  domain     TEXT,
  raw        TEXT,
  updated_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  adapter_id   TEXT NOT NULL,
  handle       TEXT NOT NULL,
  display_name TEXT,
  avatar_url   TEXT,
  raw          TEXT,
  updated_ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actors_ws ON actors(workspace_id);

CREATE TABLE IF NOT EXISTS containers (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  adapter_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  topic        TEXT,
  is_private   INTEGER,
  member_count INTEGER,
  item_count   INTEGER,
  unread_count INTEGER,
  raw          TEXT,
  updated_ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_containers_ws ON containers(workspace_id);

CREATE TABLE IF NOT EXISTS items (
  id                 TEXT NOT NULL,
  container_id       TEXT NOT NULL,
  workspace_id       TEXT NOT NULL,
  adapter_id         TEXT NOT NULL,
  kind               TEXT NOT NULL,
  author_id          TEXT,
  ts                 INTEGER NOT NULL,
  text               TEXT NOT NULL DEFAULT '',
  thread_id          TEXT,
  source_capture_ids TEXT,
  raw                TEXT,
  PRIMARY KEY (container_id, id)
);
CREATE INDEX IF NOT EXISTS idx_items_container_ts ON items(container_id, ts);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  adapter_id       TEXT NOT NULL,
  workspace_id     TEXT,
  label            TEXT NOT NULL,
  source           TEXT NOT NULL,
  discovered_at    INTEGER NOT NULL,
  credential_kinds TEXT NOT NULL DEFAULT '[]'
);

-- Relationships between normalized entities. Everything before this table could
-- only express the containment already implied by a foreign-key column
-- (item→container→workspace); anything else — "this actor is a member of that
-- container", "this item mentions that actor" — had nowhere to go.
--
-- Endpoints are (kind, id) pairs rather than real foreign keys because an edge
-- may point at any entity table, and because a capture routinely names an entity
-- Sluice has not seen yet: a message mentioning a user whose profile never
-- appeared in any response. A dangling edge is normal and is not an error.
CREATE TABLE IF NOT EXISTS edges (
  src_kind     TEXT NOT NULL,
  src_id       TEXT NOT NULL,
  rel          TEXT NOT NULL,
  dst_kind     TEXT NOT NULL,
  dst_id       TEXT NOT NULL,
  adapter_id   TEXT NOT NULL,
  workspace_id TEXT,
  raw          TEXT,
  updated_ts   INTEGER NOT NULL,
  PRIMARY KEY (src_kind, src_id, rel, dst_kind, dst_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_kind, dst_id, rel);
CREATE INDEX IF NOT EXISTS idx_edges_ws  ON edges(workspace_id);

-- The pagination worklist. An adapter that sees a paged response emits the next
-- cursor here; 'sluice replay --all' drains it. Without this table there was
-- nothing for '--all' to drain and no way to know a container's history was
-- incomplete — four Slack replay actions declare a 'cursor' param and nothing in
-- the repo ever read a 'next_cursor'.
--
-- 'state' is the whole concurrency story: claiming flips pending→running inside
-- a transaction, so two drainers cannot take the same work item.
CREATE TABLE IF NOT EXISTS cursors (
  id           TEXT PRIMARY KEY,
  adapter_id   TEXT NOT NULL,
  action_id    TEXT NOT NULL,
  container_id TEXT,
  cursor       TEXT,
  params       TEXT,
  state        TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_ts   INTEGER NOT NULL,
  updated_ts   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cursors_state ON cursors(state, updated_ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cursors_dedupe
  ON cursors(adapter_id, action_id, IFNULL(container_id, ''), IFNULL(cursor, ''));

-- Full-text search over capture bodies (the U1 'body:"…"' predicate and
-- /api/captures/search) and over item text.
--
-- Both are CONTENTLESS (content='') so they store only the inverted index, never
-- a second copy of the text — the point of compressing bodies would be lost if
-- the FTS table kept them in plain text alongside. contentless_delete=1 (SQLite
-- >= 3.43; better-sqlite3 bundles 3.49) is what makes DELETE work at all on a
-- contentless table, which pruneCaptures needs.
--
-- Consequence of contentless: the indexed columns read back as NULL, so results
-- are joined back to the source table on rowid. That is why insertCapture upserts
-- with ON CONFLICT rather than INSERT OR REPLACE — REPLACE assigns a NEW rowid
-- and would silently orphan every indexed body.
CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
  body,
  tokenize = 'unicode61',
  content = '',
  contentless_delete = 1
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  text,
  tokenize = 'porter unicode61',
  content = '',
  contentless_delete = 1
);
`;

/**
 * Columns added after the initial schema, applied by `SqliteStore.migrate()`.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already exists, so
 * adding a column to SCHEMA_SQL alone only reaches brand-new stores — every
 * existing `~/.sluice/sluice.db` would silently never gain it, and the code
 * reading that column would break for exactly the users who have data.
 *
 * So: add a column to BOTH the CREATE TABLE above (for fresh databases) and this
 * table (for existing ones). Entries are `column → the type/default clause`, and
 * applying them is idempotent — anything already present is skipped.
 *
 * Additive only. SQLite cannot drop or retype a column without rebuilding the
 * table, and a capture store is append-only data the user may care about, so a
 * destructive migration needs a deliberate, separate mechanism.
 */
/**
 * Indexes that reference a column from ADDITIVE_COLUMNS, applied AFTER those
 * columns exist.
 *
 * They cannot live in SCHEMA_SQL: on a database that already has the table, the
 * `CREATE TABLE IF NOT EXISTS` above is a no-op, so the index statement would run
 * against the old column set and fail with "no such column" — breaking startup
 * for exactly the users who already have captured data.
 */
export const ADDITIVE_INDEXES: string[] = [
  'CREATE INDEX IF NOT EXISTS idx_captures_tab ON captures(tab_id)',
  // Drives the "what still needs parsing?" query that replaced the in-memory
  // watermark. `parsed_at IS NULL` is the hot predicate, so the partial index is
  // both smaller and the one SQLite actually picks.
  'CREATE INDEX IF NOT EXISTS idx_captures_unparsed ON captures(ts) WHERE parsed_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_captures_classification ON captures(classification)',
];

export const ADDITIVE_COLUMNS: Record<string, Record<string, string>> = {
  captures: {
    // Which browser tab produced this exchange (Engine C). Lets the traffic view
    // separate "the Slack tab" from "the Trello tab" from background noise.
    tab_id: 'TEXT',
    tab_url: 'TEXT',
    // WebSocket frames: direction of travel, and the socket they belong to.
    direction: 'TEXT',
    ws_id: 'TEXT',
    // The adapter's semantic name for this exchange — `conversations.history`
    // rather than `POST /api/conversations.history`. It is what the traffic
    // table's Operation column shows and what `op:conversations.*` filters on,
    // and it is derived once at ingest instead of re-derived per render.
    classification: 'TEXT',
    // When this capture was last turned into entities. NULL means "never", which
    // is what makes parsing resumable across a restart: the previous watermark
    // lived in memory and reset every time the process did.
    parsed_at: 'INTEGER',
    // NULL = the body column holds plain text (which is true of every row
    // written before compression existed). See body-codec.ts.
    req_body_encoding: 'TEXT',
    res_body_encoding: 'TEXT',
  },
  containers: {
    // The SERVICE's own totals for this container — see Container.itemCount.
    // What makes "is my capture complete?" answerable instead of a guess.
    item_count: 'INTEGER',
    unread_count: 'INTEGER',
  },
};
