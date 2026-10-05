// SPDX-License-Identifier: AGPL-3.0-or-later

export const PROJECT_GRAPH_SCHEMA_VERSION = 1;

export const PROJECT_GRAPH_SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS graph_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  path         TEXT,
  start_line   INTEGER,
  end_line     INTEGER,
  language     TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT,
  source       TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind ON graph_nodes(kind, name);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_path ON graph_nodes(path);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_source ON graph_nodes(source);

CREATE TABLE IF NOT EXISTS graph_edges (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  metadata    TEXT NOT NULL DEFAULT '{}',
  confidence  REAL NOT NULL DEFAULT 1.0,
  source      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_id, kind);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_id, kind);
CREATE INDEX IF NOT EXISTS idx_graph_edges_kind ON graph_edges(kind);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source);

CREATE TABLE IF NOT EXISTS graph_chunks (
  id         TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL,
  path       TEXT,
  title      TEXT NOT NULL,
  start_line INTEGER,
  end_line   INTEGER,
  source     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_chunks_node ON graph_chunks(node_id);
CREATE INDEX IF NOT EXISTS idx_graph_chunks_source ON graph_chunks(source);

CREATE VIRTUAL TABLE IF NOT EXISTS graph_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  node_id UNINDEXED,
  path UNINDEXED,
  title,
  text,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS graph_files (
  path      TEXT PRIMARY KEY,
  hash      TEXT NOT NULL,
  size      INTEGER NOT NULL,
  binary    INTEGER NOT NULL,
  language  TEXT,
  indexed_at INTEGER NOT NULL
);
`;
