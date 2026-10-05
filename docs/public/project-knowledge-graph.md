# Project knowledge graph

Sluice ships a second, source-only MCP server for agents working on the repository. It maps packages, files, symbols, dependencies, calls, routes, WebSocket messages, SQLite tables, runtime workflows, security boundaries, tests, and reviewed findings into a local SQLite knowledge graph.

This is separate from the existing `sluice` MCP:

| Server | Data | Can make live service requests? |
|---|---|---|
| `sluice-project` | Repository source and reviewed architecture | No |
| `sluice` | Captured SaaS account data | Yes, through replay/tool paths |

The project graph uses deterministic FTS5 retrieval followed by bounded relationship expansion. It performs no cloud indexing, embedding calls, or model inference; the local coding agent synthesizes an answer after verifying the cited source.

## Agent loop

```text
status → refresh if stale → query → inspect/trace/impact → verify source
       → edit and test → refresh changed working tree → validate
```

The complete contract is in [`AGENTS.md`](../../AGENTS.md). Package internals, tools, safety exclusions, and limitations are in [`packages/project-graph/README.md`](../../packages/project-graph/README.md).

## Start it

```bash
pnpm install
pnpm graph refresh
pnpm graph query "how does replay reach the capture store"
```

The checked-in `.codex/config.toml` and `.mcp.json` register the stdio server for project-local agents. `pnpm build` also produces `packages/project-graph/dist/cli.js` for plain Node.

The database lives at `.sluice/project-graph.sqlite`, which is ignored by Git. It contains a searchable copy of safe source text, so treat it as local development data and delete/rebuild it if sensitive text ever entered the index.
