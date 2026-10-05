// SPDX-License-Identifier: AGPL-3.0-or-later

export type GraphSource = 'indexer' | 'curated' | 'manual';

export const GRAPH_NODE_KINDS = [
  'repository',
  'layer',
  'package',
  'directory',
  'file',
  'entrypoint',
  'build_target',
  'runtime_process',
  'symbol',
  'external_dependency',
  'script',
  'cli_command',
  'http_endpoint',
  'websocket_message',
  'mcp_tool',
  'database',
  'database_table',
  'capability',
  'config_key',
  'documentation',
  'test_suite',
  'component',
  'interface',
  'workflow',
  'security_boundary',
  'invariant',
  'finding',
  'agent_workflow',
  'note',
] as const;

export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  name: string;
  description: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  language?: string;
  metadata?: Record<string, unknown>;
  contentHash?: string;
  source: GraphSource;
  updatedAt?: number;
}

export interface GraphEdge {
  id?: string;
  from: string;
  to: string;
  kind: string;
  description?: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  source: GraphSource;
  updatedAt?: number;
}

export interface GraphChunk {
  id: string;
  nodeId: string;
  path?: string;
  title: string;
  text: string;
  startLine?: number;
  endLine?: number;
  source: GraphSource;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chunks: GraphChunk[];
  fingerprint: string;
  files: Array<{
    path: string;
    hash: string;
    size: number;
    binary: boolean;
    language?: string;
  }>;
  diagnostics: {
    unresolvedImports: Array<{ path: string; specifier: string }>;
    skippedContent: Array<{ path: string; reason: string }>;
  };
}

/** The working-tree facts a status or validation call compares the graph against. */
export interface RepositoryState {
  repositoryRoot: string;
  currentFingerprint: string | null;
  currentHead?: string | null;
  worktreeDirty?: boolean | null;
}

export interface GraphStatus {
  schemaVersion: number;
  databasePath: string;
  repositoryRoot: string;
  indexedAt: number | null;
  indexedHead: string | null;
  currentHead: string | null;
  worktreeDirty: boolean | null;
  indexedFingerprint: string | null;
  currentFingerprint: string | null;
  stale: boolean;
  counts: {
    nodes: number;
    edges: number;
    chunks: number;
    files: number;
    manualNotes: number;
  };
  nodeKinds: Record<string, number>;
  edgeKinds: Record<string, number>;
  diagnostics: {
    unresolvedImports: number;
    skippedContent: number;
  };
}

export interface SearchOptions {
  limit?: number;
  kinds?: GraphNodeKind[];
  hops?: number;
  /** Freshness the caller already computed; when omitted, the search rescans the worktree. */
  stale?: boolean;
}

export interface SearchHit {
  node: GraphNode;
  score: number;
  match: 'content' | 'name' | 'path' | 'graph';
  snippets: Array<{
    path?: string;
    startLine?: number;
    endLine?: number;
    text: string;
  }>;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  context: GraphNode[];
  relationships: GraphEdge[];
  stale: boolean;
  guidance: string;
}

export interface CuratedGraph {
  version: number;
  description?: string;
  nodes: Array<Omit<GraphNode, 'source'>>;
  edges: Array<Omit<GraphEdge, 'source'>>;
}

export interface NoteInput {
  id?: string;
  title: string;
  body: string;
  relatedNodeIds?: string[];
  evidencePaths?: string[];
  tags?: string[];
  expectedUpdatedAt?: number;
}

export interface GraphValidation {
  ok: boolean;
  stale: boolean;
  orphanEdges: Array<{ id: string; from: string; to: string }>;
  missingFiles: string[];
  invalidManualNotes: string[];
  counts: GraphStatus['counts'];
}
