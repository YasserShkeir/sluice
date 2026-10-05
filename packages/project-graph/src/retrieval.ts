// SPDX-License-Identifier: AGPL-3.0-or-later
import { repositoryState } from './indexer.js';
import type { ProjectGraphStore } from './store.js';
import type { GraphEdge, GraphNode, SearchHit, SearchOptions, SearchResult } from './types.js';

/**
 * Edge kinds that point from a dependent to what it depends on, so walking
 * them backwards from a target reaches its consumers. Finding and constraint
 * kinds (affects, risks, gates, governs, constrains, annotates) are not
 * dependencies and stay out.
 */
const IMPACT_EDGE_KINDS = [
  // Indexer: containment, imports (incl. external dependencies), packages,
  // calls, tests and endpoints.
  'contains_file',
  'contains_package',
  'imports',
  'imports_package',
  'imports_external',
  'depends_on',
  'dev_depends_on',
  'calls',
  'tests',
  'references_endpoint',
  'calls_endpoint',
  // Indexer: the file that exports, declares or defines a symbol, table,
  // message, route, tool or command.
  'exports',
  'declares',
  'defines_table',
  'defines_message',
  'serves_endpoint',
  'registers_tool',
  'implements_command',
  // Curated architecture (knowledge/architecture.json).
  'implements',
  'documents',
  'reads_from',
  'writes_to',
  'uses',
  'persists_to',
  'reads_and_writes',
  'writes_derived_tables_to',
  'gated_by',
  'implemented_by',
  'declared_by',
  'enforced_at',
  'serves',
  'invokes',
  'flows_to',
];

export function searchProjectGraph(
  store: ProjectGraphStore,
  repositoryRoot: string,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('query must be non-empty');
  const limit = Math.max(1, Math.min(options.limit ?? 10, 20));
  const hops = Math.max(0, Math.min(options.hops ?? 1, 2));
  const kinds = options.kinds;
  const hits = new Map<string, SearchHit>();

  for (const row of store.searchChunks(trimmed, { limit: limit * 6, kinds })) {
    const existing = hits.get(row.node.id);
    const lexicalScore = 2 + Math.min(5, row.rank * 100);
    const snippet = {
      path: row.path,
      startLine: row.startLine,
      endLine: row.endLine,
      text: row.snippet.replace(/\s+/g, ' ').trim().slice(0, 900),
    };
    if (existing) {
      existing.score += lexicalScore * 0.25;
      if (
        existing.snippets.length < 3 &&
        !existing.snippets.some(
          (candidate) =>
            candidate.path === snippet.path && candidate.startLine === snippet.startLine,
        )
      ) {
        existing.snippets.push(snippet);
      }
    } else {
      hits.set(row.node.id, {
        node: row.node,
        score: lexicalScore,
        match: 'content',
        snippets: [snippet],
      });
    }
  }

  for (const node of store.searchNames(trimmed, { limit: limit * 3, kinds })) {
    const exact = node.name.toLowerCase() === trimmed.toLowerCase();
    const pathExact = node.path?.toLowerCase() === trimmed.toLowerCase();
    const score = exact || pathExact ? 12 : node.path?.includes(trimmed) ? 8 : 7;
    const existing = hits.get(node.id);
    if (existing) {
      existing.score += score;
      existing.match = pathExact ? 'path' : 'name';
    } else {
      hits.set(node.id, {
        node,
        score,
        match: pathExact ? 'path' : 'name',
        snippets: node.description
          ? [{ path: node.path, startLine: node.startLine, endLine: node.endLine, text: node.description }]
          : [],
      });
    }
  }

  const ordered = [...hits.values()]
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, limit);
  const context = new Map<string, GraphNode>();
  const relationships = new Map<string, GraphEdge>();
  for (const hit of ordered.slice(0, Math.min(8, ordered.length))) {
    context.set(hit.node.id, hit.node);
    if (hops === 0) continue;
    const neighborhood = store.neighborhood(hit.node.id, { depth: hops, limit: 80 });
    if (!neighborhood) continue;
    for (const node of neighborhood.nodes) context.set(node.id, node);
    for (const edge of neighborhood.edges) {
      if (edge.id) relationships.set(edge.id, edge);
    }
  }
  const stale = options.stale ?? store.status(repositoryState(repositoryRoot)).stale;
  return {
    query: trimmed,
    hits: ordered,
    context: [...context.values()].slice(0, 60),
    relationships: [...relationships.values()].slice(0, 100),
    stale,
    guidance: stale
      ? 'The working tree has changed since this graph revision. Refresh, then verify returned source locations before editing.'
      : 'Use these nodes as navigation evidence. Open the cited source before editing; the graph is not the source of truth.',
  };
}

export function impactAnalysis(
  store: ProjectGraphStore,
  idOrPath: string,
  options: { depth?: number; limit?: number; edgeKinds?: string[] } = {},
): {
  target: GraphNode;
  impactedNodes: GraphNode[];
  relationships: GraphEdge[];
  validationHints: string[];
} {
  const target = store.resolveNode(idOrPath);
  if (!target) throw new Error(`No graph node matched ${idOrPath}`);
  const neighborhood = store.neighborhood(target.id, {
    direction: 'in',
    kinds: options.edgeKinds ?? IMPACT_EDGE_KINDS,
    depth: Math.max(1, Math.min(options.depth ?? 3, 5)),
    limit: Math.max(1, Math.min(options.limit ?? 300, 800)),
  });
  if (!neighborhood) throw new Error(`Could not analyze ${target.id}`);
  const impactedNodes = neighborhood.nodes.filter((node) => node.id !== target.id);
  const packages = new Set(
    impactedNodes.filter((node) => node.kind === 'package').map((node) => node.name),
  );
  const tests = impactedNodes.filter(
    (node) => node.kind === 'file' && Boolean(node.path?.endsWith('.test.ts')),
  );
  const validationHints: string[] = [];
  for (const pkg of packages) validationHints.push(`Run tests/typecheck for ${pkg}`);
  for (const test of tests.slice(0, 12)) {
    if (test.path) validationHints.push(`Inspect or run ${test.path}`);
  }
  if (validationHints.length === 0) {
    validationHints.push('Use package ownership and nearby test files to choose targeted checks.');
  }
  return {
    target,
    impactedNodes,
    relationships: neighborhood.edges,
    validationHints: [...new Set(validationHints)],
  };
}
