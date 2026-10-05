// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { PROJECT_GRAPH_SCHEMA, PROJECT_GRAPH_SCHEMA_VERSION } from './schema.js';
import type {
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphStatus,
  GraphValidation,
  NoteInput,
  RepositoryState,
} from './types.js';

interface NodeRow {
  id: string;
  kind: GraphNode['kind'];
  name: string;
  description: string;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  language: string | null;
  metadata: string;
  content_hash: string | null;
  source: GraphNode['source'];
  updated_at: number;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  kind: string;
  description: string;
  metadata: string;
  confidence: number;
  source: GraphEdge['source'];
  updated_at: number;
}

const parseObject = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const mapNode = (row: NodeRow): GraphNode => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  description: row.description,
  path: row.path ?? undefined,
  startLine: row.start_line ?? undefined,
  endLine: row.end_line ?? undefined,
  language: row.language ?? undefined,
  metadata: parseObject(row.metadata),
  contentHash: row.content_hash ?? undefined,
  source: row.source,
  updatedAt: row.updated_at,
});

const mapEdge = (row: EdgeRow): GraphEdge => ({
  id: row.id,
  from: row.from_id,
  to: row.to_id,
  kind: row.kind,
  description: row.description || undefined,
  metadata: parseObject(row.metadata),
  confidence: row.confidence,
  source: row.source,
  updatedAt: row.updated_at,
});

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

const shortHash = (value: string): string => sha256(value).slice(0, 20);

const inList = (values: readonly unknown[]): string => values.map(() => '?').join(', ');

/**
 * Token shapes that must never be persisted in a manual note. Every pattern
 * requires a value long enough to be a real credential, so prose that merely
 * names a prefix (for example "xoxc-" tokens) stays allowed.
 */
const SECRET_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['slack-token', /\bxox[a-z]-[A-Za-z0-9%-]{10,}/i],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['secret-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ['live-key', /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['jwt', /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  [
    'credential-assignment',
    /\b(?:cookie|set-cookie|authorization|token|secret|password|api[_-]?key|d)\s*[:=]\s*["']?[^\s"';]{24,}/i,
  ],
];

/** Names the first credential shape found in any value, never the value itself. */
function findSecretShape(values: readonly string[]): string | null {
  for (const value of values) {
    for (const [name, pattern] of SECRET_SHAPES) {
      if (pattern.test(value)) return name;
    }
  }
  return null;
}

export function graphEdgeId(edge: Pick<GraphEdge, 'from' | 'to' | 'kind' | 'source'>): string {
  return `edge:${shortHash(`${edge.source}\0${edge.kind}\0${edge.from}\0${edge.to}`)}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56) || 'note';
}

function ftsQuery(input: string): string | null {
  const tokens = input
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_@./:-]{2,}/gu)
    ?.map((token) => token.replaceAll('"', '""'))
    .slice(0, 16);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"*`).join(' OR ');
}

/**
 * The project graph's durable local store.
 *
 * It is deliberately separate from ~/.sluice/sluice.db: that database holds
 * redacted runtime traffic, while this one holds repository structure and
 * agent-authored notes. Generated rows can be replaced atomically without
 * touching manual notes.
 */
export class ProjectGraphStore {
  readonly db: Database.Database;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') {
      const parent = dirname(path);
      // Tighten only a directory this call created: --db may point into $HOME
      // or another existing shared directory whose mode is not ours to change.
      if (mkdirSync(parent, { recursive: true, mode: 0o700 }) !== undefined) {
        try {
          chmodSync(parent, 0o700);
        } catch {
          // Best effort on filesystems without POSIX modes.
        }
      }
      // SQLite gives -wal/-shm the main file's mode, so the main file must be
      // private before it opens. Stale sidecars from a crash are tightened too.
      // Only a missing file is opened here: closing any descriptor on a SQLite
      // file drops this process's POSIX locks on it.
      if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        try {
          if (existsSync(file)) chmodSync(file, 0o600);
        } catch {
          // Best effort on filesystems without POSIX modes.
        }
      }
    }
    this.db = new Database(path);
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(PROJECT_GRAPH_SCHEMA);
    this.setMeta('schema_version', String(PROJECT_GRAPH_SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO graph_meta (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM graph_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  replaceGenerated(
    snapshot: GraphSnapshot,
    metadata: { repositoryRoot: string; indexedHead: string | null },
  ): void {
    const now = Date.now();
    const insertNode = this.db.prepare(
      `INSERT INTO graph_nodes
       (id, kind, name, description, path, start_line, end_line, language, metadata,
        content_hash, source, updated_at)
       VALUES (@id, @kind, @name, @description, @path, @start_line, @end_line,
               @language, @metadata, @content_hash, @source, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         name = excluded.name,
         description = excluded.description,
         path = excluded.path,
         start_line = excluded.start_line,
         end_line = excluded.end_line,
         language = excluded.language,
         metadata = excluded.metadata,
         content_hash = excluded.content_hash,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    );
    const insertEdge = this.db.prepare(
      `INSERT INTO graph_edges
       (id, from_id, to_id, kind, description, metadata, confidence, source, updated_at)
       VALUES (@id, @from_id, @to_id, @kind, @description, @metadata, @confidence,
               @source, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         from_id = excluded.from_id,
         to_id = excluded.to_id,
         kind = excluded.kind,
         description = excluded.description,
         metadata = excluded.metadata,
         confidence = excluded.confidence,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    );
    const insertChunk = this.db.prepare(
      `INSERT INTO graph_chunks
       (id, node_id, path, title, start_line, end_line, source)
       VALUES (@id, @node_id, @path, @title, @start_line, @end_line, @source)`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO graph_chunks_fts (chunk_id, node_id, path, title, text)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertFile = this.db.prepare(
      `INSERT INTO graph_files (path, hash, size, binary, language, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM graph_chunks_fts
        WHERE chunk_id IN (SELECT id FROM graph_chunks WHERE source != 'manual');
        DELETE FROM graph_chunks WHERE source != 'manual';
        DELETE FROM graph_edges WHERE source != 'manual';
        DELETE FROM graph_nodes WHERE source != 'manual';
        DELETE FROM graph_files;
      `);

      for (const node of snapshot.nodes) {
        insertNode.run({
          id: node.id,
          kind: node.kind,
          name: node.name,
          description: node.description,
          path: node.path ?? null,
          start_line: node.startLine ?? null,
          end_line: node.endLine ?? null,
          language: node.language ?? null,
          metadata: JSON.stringify(node.metadata ?? {}),
          content_hash: node.contentHash ?? null,
          source: node.source,
          updated_at: node.updatedAt ?? now,
        });
      }

      for (const edge of snapshot.edges) {
        insertEdge.run({
          id: edge.id ?? graphEdgeId(edge),
          from_id: edge.from,
          to_id: edge.to,
          kind: edge.kind,
          description: edge.description ?? '',
          metadata: JSON.stringify(edge.metadata ?? {}),
          confidence: edge.confidence ?? 1,
          source: edge.source,
          updated_at: edge.updatedAt ?? now,
        });
      }

      for (const chunk of snapshot.chunks) {
        insertChunk.run({
          id: chunk.id,
          node_id: chunk.nodeId,
          path: chunk.path ?? null,
          title: chunk.title,
          start_line: chunk.startLine ?? null,
          end_line: chunk.endLine ?? null,
          source: chunk.source,
        });
        insertFts.run(chunk.id, chunk.nodeId, chunk.path ?? null, chunk.title, chunk.text);
      }

      for (const file of snapshot.files) {
        insertFile.run(
          file.path,
          file.hash,
          file.size,
          file.binary ? 1 : 0,
          file.language ?? null,
          now,
        );
      }

      this.setMeta('repository_root', metadata.repositoryRoot);
      this.setMeta('indexed_head', metadata.indexedHead ?? '');
      this.setMeta('indexed_fingerprint', snapshot.fingerprint);
      this.setMeta('indexed_at', String(now));
      this.setMeta('unresolved_imports', String(snapshot.diagnostics.unresolvedImports.length));
      this.setMeta('skipped_content', String(snapshot.diagnostics.skippedContent.length));
    })();
  }

  getNode(id: string): GraphNode | null {
    const row = this.db.prepare('SELECT * FROM graph_nodes WHERE id = ?').get(id) as
      | NodeRow
      | undefined;
    return row ? mapNode(row) : null;
  }

  resolveNode(idOrPath: string): GraphNode | null {
    const exact = this.getNode(idOrPath);
    if (exact) return exact;
    const normalized = idOrPath.replace(/^\.\//, '');
    const byPath = this.db
      .prepare(
        `SELECT * FROM graph_nodes
         WHERE path = ? OR id = ?
         ORDER BY CASE kind WHEN 'file' THEN 0 WHEN 'symbol' THEN 1 ELSE 2 END
         LIMIT 1`,
      )
      .get(normalized, `file:${normalized}`) as NodeRow | undefined;
    if (byPath) return mapNode(byPath);
    const byName = this.db
      .prepare('SELECT * FROM graph_nodes WHERE name = ? COLLATE NOCASE ORDER BY kind LIMIT 1')
      .get(idOrPath) as NodeRow | undefined;
    return byName ? mapNode(byName) : null;
  }

  listNodes(kind: string, limit = 500): GraphNode[] {
    const sql = 'SELECT * FROM graph_nodes WHERE kind = ? ORDER BY name LIMIT ?';
    return (this.db.prepare(sql).all(kind, limit) as NodeRow[]).map(mapNode);
  }

  edgesFor(
    nodeId: string,
    options: { direction?: 'in' | 'out' | 'both'; kinds?: string[]; limit?: number } = {},
  ): GraphEdge[] {
    const direction = options.direction ?? 'both';
    const limit = Math.max(1, Math.min(options.limit ?? 500, 2_000));
    const clauses = [{ in: 'to_id = ?', out: 'from_id = ?', both: '(from_id = ? OR to_id = ?)' }[direction]];
    const params: unknown[] = direction === 'both' ? [nodeId, nodeId] : [nodeId];
    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`kind IN (${inList(options.kinds)})`);
      params.push(...options.kinds);
    }
    params.push(limit);
    return (
      this.db
        .prepare(`SELECT * FROM graph_edges WHERE ${clauses.join(' AND ')} ORDER BY kind LIMIT ?`)
        .all(...params) as EdgeRow[]
    ).map(mapEdge);
  }

  neighborhood(
    nodeId: string,
    options: {
      direction?: 'in' | 'out' | 'both';
      kinds?: string[];
      depth?: number;
      limit?: number;
    } = {},
  ): { root: GraphNode; nodes: GraphNode[]; edges: GraphEdge[] } | null {
    const root = this.getNode(nodeId);
    if (!root) return null;
    const { direction, kinds } = options;
    const depth = Math.max(0, Math.min(options.depth ?? 1, 5));
    const limit = Math.max(1, Math.min(options.limit ?? 200, 1_000));
    const seen = new Set<string>([nodeId]);
    const edges = new Map<string, GraphEdge>();
    let frontier = [nodeId];
    for (let level = 0; level < depth && frontier.length > 0 && seen.size < limit; level += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const edge of this.edgesFor(current, { direction, kinds, limit })) {
          if (edges.size >= limit * 3) break;
          edges.set(edge.id ?? graphEdgeId(edge), edge);
          for (const candidate of [edge.from, edge.to]) {
            if (seen.size >= limit) break;
            if (!seen.has(candidate)) {
              seen.add(candidate);
              next.push(candidate);
            }
          }
        }
      }
      frontier = next;
    }
    const nodes = [...seen]
      .map((id) => this.getNode(id))
      .filter((node): node is GraphNode => node !== null);
    return { root, nodes, edges: [...edges.values()] };
  }

  trace(
    fromId: string,
    toId: string,
    options: { direction?: 'out' | 'both'; kinds?: string[]; maxDepth?: number } = {},
  ): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
    const from = this.getNode(fromId);
    if (!from || !this.getNode(toId)) return null;
    if (fromId === toId) return { nodes: [from], edges: [] };
    const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 6, 12));
    const queue: Array<{ id: string; depth: number }> = [{ id: fromId, depth: 0 }];
    const previous = new Map<string, { node: string; edge: GraphEdge }>();
    const seen = new Set<string>([fromId]);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth >= maxDepth) continue;
      for (const edge of this.edgesFor(current.id, {
        direction: options.direction ?? 'both',
        kinds: options.kinds,
        limit: 2_000,
      })) {
        const next = edge.from === current.id ? edge.to : edge.from;
        if (seen.has(next)) continue;
        seen.add(next);
        previous.set(next, { node: current.id, edge });
        if (next === toId) {
          const ids = [toId];
          const pathEdges: GraphEdge[] = [];
          let cursor = toId;
          while (cursor !== fromId) {
            const step = previous.get(cursor);
            if (!step) break;
            pathEdges.unshift(step.edge);
            cursor = step.node;
            ids.unshift(cursor);
          }
          return {
            nodes: ids
              .map((id) => this.getNode(id))
              .filter((node): node is GraphNode => node !== null),
            edges: pathEdges,
          };
        }
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
    return null;
  }

  searchChunks(
    query: string,
    options: { limit?: number; kinds?: string[] } = {},
  ): Array<{
    node: GraphNode;
    rank: number;
    path?: string;
    startLine?: number;
    endLine?: number;
    snippet: string;
  }> {
    const match = ftsQuery(query);
    if (!match) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 30, 200));
    const kindClause = options.kinds?.length
      ? `AND n.kind IN (${inList(options.kinds)})`
      : '';
    const params: unknown[] = [match];
    if (options.kinds) params.push(...options.kinds);
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT n.*, c.path AS chunk_path, c.start_line AS chunk_start_line,
                c.end_line AS chunk_end_line,
                bm25(graph_chunks_fts, 0.0, 0.0, 0.0, 8.0, 1.0) AS rank,
                snippet(graph_chunks_fts, 4, '<match>', '</match>', ' … ', 28) AS snippet
         FROM graph_chunks_fts
         JOIN graph_chunks c ON c.id = graph_chunks_fts.chunk_id
         JOIN graph_nodes n ON n.id = c.node_id
         WHERE graph_chunks_fts MATCH ? ${kindClause}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(...params) as Array<
      NodeRow & {
        chunk_path: string | null;
        chunk_start_line: number | null;
        chunk_end_line: number | null;
        rank: number;
        snippet: string;
      }
    >;
    return rows.map((row) => ({
      node: mapNode(row),
      rank: Math.max(0.0001, Math.abs(row.rank)),
      path: row.chunk_path ?? undefined,
      startLine: row.chunk_start_line ?? undefined,
      endLine: row.chunk_end_line ?? undefined,
      snippet: row.snippet,
    }));
  }

  searchNames(
    query: string,
    options: { limit?: number; kinds?: string[] } = {},
  ): GraphNode[] {
    // Escape the escape character too, or a backslash in the query would
    // escape the next character instead of matching itself.
    const needle = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const clauses = [`(name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')`];
    const params: unknown[] = [needle, needle];
    if (options.kinds?.length) {
      clauses.push(`kind IN (${inList(options.kinds)})`);
      params.push(...options.kinds);
    }
    params.push(query, Math.max(1, Math.min(options.limit ?? 20, 100)));
    return (
      this.db
        .prepare(
          `SELECT * FROM graph_nodes WHERE ${clauses.join(' AND ')}
           ORDER BY CASE WHEN name = ? COLLATE NOCASE THEN 0 ELSE 1 END, length(name), name
           LIMIT ?`,
        )
        .all(...params) as NodeRow[]
    ).map(mapNode);
  }

  upsertNote(input: NoteInput): GraphNode {
    const baseId = input.id ? input.id.replace(/^note:/, '') : slug(input.title);
    const id = `note:${baseId}`;
    // Screen before any lookup so no error echoes a credential-shaped id; the id
    // is screened as stored because a slugged title can form a token.
    const secretShape = findSecretShape([
      id,
      input.title,
      input.body,
      ...(input.tags ?? []),
      ...(input.evidencePaths ?? []),
      ...(input.relatedNodeIds ?? []),
    ]);
    if (secretShape) {
      throw new Error(`note appears to contain a credential (pattern: ${secretShape}); remove it`);
    }
    const existing = this.getNode(id);
    if (existing && existing.source !== 'manual') {
      throw new Error(`${id} exists but is generated; choose another note id`);
    }
    if (existing) assertNoteVersion('update', existing, input.expectedUpdatedAt);
    const now = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
    const name = input.title.trim();
    const description = input.body.trim();
    if (!name || !description) throw new Error('note title and body must be non-empty');
    const metadata = JSON.stringify({ tags: input.tags ?? [], evidencePaths: input.evidencePaths ?? [] });

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO graph_nodes
           (id, kind, name, description, path, start_line, end_line, language, metadata,
            content_hash, source, updated_at)
           VALUES (?, 'note', ?, ?, NULL, NULL, NULL, 'markdown', ?, NULL, 'manual', ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = 'note', name = excluded.name, description = excluded.description,
             metadata = excluded.metadata, source = 'manual', updated_at = excluded.updated_at`,
        )
        .run(id, name, description, metadata, now);
      this.deleteNodeChunks(id, true);
      const chunkId = `${id}:body`;
      this.db
        .prepare(
          `INSERT INTO graph_chunks
           (id, node_id, path, title, start_line, end_line, source)
           VALUES (?, ?, NULL, ?, NULL, NULL, 'manual')`,
        )
        .run(chunkId, id, name);
      this.db
        .prepare(
          `INSERT INTO graph_chunks_fts (chunk_id, node_id, path, title, text)
           VALUES (?, ?, NULL, ?, ?)`,
        )
        .run(chunkId, id, name, `${name}\n${description}`);
      this.db
        .prepare("DELETE FROM graph_edges WHERE from_id = ? AND source = 'manual' AND kind = 'annotates'")
        .run(id);

      const targets = new Set(input.relatedNodeIds ?? []);
      for (const path of input.evidencePaths ?? []) {
        const file = this.resolveNode(path);
        if (file) targets.add(file.id);
      }
      const insertEdge = this.db.prepare(
        `INSERT INTO graph_edges
         (id, from_id, to_id, kind, description, metadata, confidence, source, updated_at)
         VALUES (?, ?, ?, 'annotates', ?, '{}', 1.0, 'manual', ?)`,
      );
      for (const target of targets) {
        const edge: GraphEdge = { from: id, to: target, kind: 'annotates', source: 'manual' };
        insertEdge.run(graphEdgeId(edge), id, target, `Manual note about ${target}`, now);
      }
    })();
    const saved = this.getNode(id);
    if (!saved) throw new Error('note was not persisted');
    return saved;
  }

  deleteNote(id: string, expectedUpdatedAt?: number): boolean {
    const noteId = id.startsWith('note:') ? id : `note:${id}`;
    const existing = this.getNode(noteId);
    if (!existing) return false;
    if (existing.source !== 'manual' || existing.kind !== 'note') {
      throw new Error(`${noteId} is not a manual note`);
    }
    assertNoteVersion('delete', existing, expectedUpdatedAt);
    this.db.transaction(() => {
      this.deleteNodeChunks(noteId, false);
      this.db.prepare('DELETE FROM graph_edges WHERE from_id = ? OR to_id = ?').run(noteId, noteId);
      this.db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(noteId);
    })();
    return true;
  }

  /**
   * Callers run this inside their transaction. FTS rows go first because they
   * are found through graph_chunks.
   */
  private deleteNodeChunks(nodeId: string, manualOnly: boolean): void {
    const filter = `node_id = ?${manualOnly ? " AND source = 'manual'" : ''}`;
    this.db
      .prepare(`DELETE FROM graph_chunks_fts WHERE chunk_id IN (SELECT id FROM graph_chunks WHERE ${filter})`)
      .run(nodeId);
    this.db.prepare(`DELETE FROM graph_chunks WHERE ${filter}`).run(nodeId);
  }

  status(input: RepositoryState): GraphStatus {
    const count = (from: string): number =>
      (this.db.prepare(`SELECT count(*) AS count FROM ${from}`).get() as { count: number }).count;
    const grouped = (table: 'graph_nodes' | 'graph_edges'): Record<string, number> =>
      Object.fromEntries(
        (
          this.db
            .prepare(`SELECT kind AS name, count(*) AS count FROM ${table} GROUP BY kind`)
            .all() as Array<{ name: string; count: number }>
        ).map((row) => [row.name, row.count]),
      );
    const indexedFingerprint = this.getMeta('indexed_fingerprint');
    const indexedAtRaw = this.getMeta('indexed_at');
    const indexedHead = this.getMeta('indexed_head') || null;
    return {
      schemaVersion: Number(this.getMeta('schema_version') ?? PROJECT_GRAPH_SCHEMA_VERSION),
      databasePath: this.path === ':memory:' ? this.path : realpathIfExists(this.path),
      repositoryRoot: realpathIfExists(input.repositoryRoot),
      indexedAt: indexedAtRaw ? Number(indexedAtRaw) : null,
      indexedHead,
      currentHead: input.currentHead ?? null,
      worktreeDirty: input.worktreeDirty ?? null,
      indexedFingerprint,
      currentFingerprint: input.currentFingerprint,
      stale:
        !indexedFingerprint ||
        !input.currentFingerprint ||
        indexedFingerprint !== input.currentFingerprint ||
        (input.currentHead !== undefined &&
          input.currentHead !== null &&
          indexedHead !== input.currentHead),
      counts: {
        nodes: count('graph_nodes'),
        edges: count('graph_edges'),
        chunks: count('graph_chunks'),
        files: count('graph_files'),
        manualNotes: count("graph_nodes WHERE source = 'manual' AND kind = 'note'"),
      },
      nodeKinds: grouped('graph_nodes'),
      edgeKinds: grouped('graph_edges'),
      diagnostics: {
        unresolvedImports: Number(this.getMeta('unresolved_imports') ?? 0),
        skippedContent: Number(this.getMeta('skipped_content') ?? 0),
      },
    };
  }

  validate(input: RepositoryState): GraphValidation {
    const status = this.status(input);
    const orphanEdges = this.db
      .prepare(
        `SELECT e.id, e.from_id, e.to_id
         FROM graph_edges e
         LEFT JOIN graph_nodes f ON f.id = e.from_id
         LEFT JOIN graph_nodes t ON t.id = e.to_id
         WHERE f.id IS NULL OR t.id IS NULL
         ORDER BY e.id`,
      )
      .all() as Array<{ id: string; from_id: string; to_id: string }>;
    const missingFiles = (
      this.db.prepare("SELECT path FROM graph_nodes WHERE kind = 'file' AND path IS NOT NULL").all() as Array<{
        path: string;
      }>
    )
      .map((row) => row.path)
      .filter((path) => !existsSync(resolve(input.repositoryRoot, path)));
    // Notes persist across refresh, so re-screen them with upsertNote's shapes.
    const invalidManualNotes = (
      this.db
        .prepare("SELECT id, kind, name, description, metadata FROM graph_nodes WHERE source = 'manual'")
        .all() as Array<Pick<NodeRow, 'id' | 'kind' | 'name' | 'description' | 'metadata'>>
    )
      .filter(
        (row) =>
          row.kind !== 'note' ||
          !row.name.trim() ||
          !row.description.trim() ||
          findSecretShape([row.id, row.name, row.description, row.metadata]) !== null,
      )
      .map((row) => row.id);
    return {
      ok:
        !status.stale &&
        orphanEdges.length === 0 &&
        missingFiles.length === 0 &&
        invalidManualNotes.length === 0,
      stale: status.stale,
      orphanEdges: orphanEdges.map((row) => ({ id: row.id, from: row.from_id, to: row.to_id })),
      missingFiles,
      invalidManualNotes,
      counts: status.counts,
    };
  }
}

/** Compare-and-swap guard for note writes; an omitted expectation always passes. */
function assertNoteVersion(action: string, existing: GraphNode, expected: number | undefined): void {
  if (expected !== undefined && existing.updatedAt !== expected) {
    throw new Error(
      `note ${action} conflict: expected updatedAt=${expected}, current=${existing.updatedAt ?? 'unknown'}`,
    );
  }
}

function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
