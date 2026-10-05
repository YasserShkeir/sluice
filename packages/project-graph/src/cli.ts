#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import process from 'node:process';

import {
  defaultProjectGraphPath,
  findRepositoryRoot,
  refreshProjectGraph,
  repositoryState,
} from './indexer.js';
import { impactAnalysis, searchProjectGraph } from './retrieval.js';
import { startProjectGraphStdioServer } from './server.js';
import { ProjectGraphStore } from './store.js';
import type { GraphStatus } from './types.js';

const HELP = `sluice-project-graph <command> [options]

Local source knowledge graph and GraphRAG-style retrieval for this repository.

Commands:
  mcp                         Start the stdio MCP server (default)
  refresh                     Rebuild generated graph facts from the working tree
  status                      Show freshness and graph counts
  query <question...>         Search source + architecture and expand relationships
  get <id-or-path>            Show one node and its immediate relationships
  neighbors <id-or-path>      Traverse a node's relationships
  impact <id-or-path>         Find likely reverse dependents and validation work
  trace <from> <to>           Find a bounded relationship path
  validate                    Check freshness, files, notes, and dangling edges

Options:
  --root PATH                 Repository or a directory inside it (default: cwd)
  --db PATH                   Graph SQLite path (default: <root>/.sluice/project-graph.sqlite)
  --limit N                   Result limit for query/neighbors/impact
  --depth N                   Traversal depth for neighbors/impact
  --hops N                    Graph expansion hops for query (0-2)
  --no-auto-refresh           Do not refresh a stale graph before MCP/query commands
  -h, --help                  Show this help

Examples:
  pnpm graph refresh
  pnpm graph query "how does replay reach the store"
  pnpm graph impact packages/core/src/types.ts
  pnpm graph mcp
`;

interface ParsedArgs {
  command: string;
  rest: string[];
  root: string;
  databasePath?: string;
  limit?: number;
  depth?: number;
  hops?: number;
  autoRefresh: boolean;
  help: boolean;
}

function numberOption(name: string, raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw) || Number(raw) < 0) {
    throw new Error(`${name} requires a non-negative integer`);
  }
  return Number(raw);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'mcp',
    rest: [],
    root: process.env.SLUICE_GRAPH_ROOT ?? process.cwd(),
    databasePath: process.env.SLUICE_PROJECT_GRAPH_DB,
    autoRefresh: process.env.SLUICE_GRAPH_AUTO_REFRESH !== 'false',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--root') {
      args.root = argv[++i] ?? '';
    } else if (value === '--db') {
      args.databasePath = argv[++i];
    } else if (value === '--limit' || value === '--depth' || value === '--hops') {
      args[value.slice(2) as 'limit' | 'depth' | 'hops'] = numberOption(value, argv[++i]);
    } else if (value === '--no-auto-refresh') {
      args.autoRefresh = false;
    } else if (value === '-h' || value === '--help') {
      args.help = true;
    } else if (value !== undefined) {
      args.rest.push(value);
    }
  }
  args.command = args.rest.shift() ?? 'mcp';
  return args;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const root = findRepositoryRoot(args.root);
  const databasePath = args.databasePath ?? defaultProjectGraphPath(root);
  if (args.command === 'mcp' || args.command === 'serve') {
    await startProjectGraphStdioServer({
      root,
      databasePath,
      autoRefresh: args.autoRefresh,
    });
    return;
  }

  const store = new ProjectGraphStore(databasePath);
  try {
    const ensureFresh = (): GraphStatus => {
      const status = store.status(repositoryState(root));
      return status.stale && args.autoRefresh ? refreshProjectGraph(store, root) : status;
    };
    const restArg = (what: string): string => {
      const value = args.rest.join(' ').trim();
      if (!value) throw new Error(`${args.command} requires ${what}`);
      return value;
    };
    switch (args.command) {
      case 'refresh':
      case 'build':
        print(refreshProjectGraph(store, root));
        break;
      case 'status':
        print(store.status(repositoryState(root)));
        break;
      case 'query': {
        const question = restArg('a question');
        const { stale } = ensureFresh();
        print(
          searchProjectGraph(store, root, question, {
            limit: args.limit,
            hops: args.hops,
            stale,
          }),
        );
        break;
      }
      case 'get': {
        const idOrPath = restArg('an id or path');
        ensureFresh();
        const node = store.resolveNode(idOrPath);
        print(node ? { node, relationships: store.edgesFor(node.id) } : null);
        break;
      }
      case 'neighbors': {
        const idOrPath = restArg('an id or path');
        ensureFresh();
        const node = store.resolveNode(idOrPath);
        if (!node) throw new Error(`No graph node matched ${idOrPath}`);
        // The store and impactAnalysis clamp depth and limit themselves.
        print(store.neighborhood(node.id, { depth: args.depth, limit: args.limit }));
        break;
      }
      case 'impact': {
        const idOrPath = restArg('an id or path');
        ensureFresh();
        print(impactAnalysis(store, idOrPath, { depth: args.depth, limit: args.limit }));
        break;
      }
      case 'trace': {
        const [from, to] = args.rest;
        if (!from || !to) throw new Error('trace requires <from> <to>');
        ensureFresh();
        const fromNode = store.resolveNode(from);
        const toNode = store.resolveNode(to);
        if (!fromNode || !toNode) throw new Error('trace could not resolve both nodes');
        print(store.trace(fromNode.id, toNode.id, { maxDepth: args.depth ?? 6 }));
        break;
      }
      case 'validate':
        print(store.validate(repositoryState(root)));
        break;
      default:
        throw new Error(`Unknown command: ${args.command}\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[sluice-project-graph] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
