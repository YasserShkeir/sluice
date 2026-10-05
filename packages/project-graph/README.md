# `@sluice/project-graph`

Local source knowledge graph, deterministic GraphRAG retrieval, and stdio MCP for the Sluice repository.

This package answers questions about the project itself: packages, files, symbols, dependencies, calls, routes, protocol messages, database tables, runtime flows, security boundaries, tests, and reviewed findings. It is intentionally separate from `@sluice/mcp`, which opens captured SaaS data and can replay live requests.

## Quick start

```bash
pnpm install
pnpm graph refresh
pnpm graph status
pnpm graph query "how does a CDP capture become normalized items"
pnpm graph impact packages/core/src/types.ts
pnpm graph validate
```

The default database is `<repository>/.sluice/project-graph.sqlite`. It is local and ignored by Git. Where the filesystem supports POSIX permissions, the database file is created with mode `0600` before SQLite opens it, so its `-wal`/`-shm` files inherit `0600`. A parent directory the store creates gets mode `0700`; an existing directory named by `--db` keeps its mode.

The checked-in `.codex/config.toml` and `.mcp.json` start the source MCP directly through `tsx`; a development build is not required. `pnpm build` also creates the plain-Node binary at `packages/project-graph/dist/cli.js`.

## What is represented

Generated nodes include:

- repository, directory, file, package, external dependency, and package script;
- TypeScript/JavaScript symbols, imports, resolved calls, and exports;
- HTTP/WebSocket endpoints, protocol messages, CLI commands, MCP tools, and SQLite tables;
- tracked binary assets as metadata-only file nodes.

`knowledge/architecture.json` adds reviewed semantic nodes and edges that syntax alone cannot recover reliably:

- conceptual layers and components;
- capture, replay, flow-learning, control-plane, and extension workflows;
- runtime and project-graph databases;
- security boundaries and invariants;
- review findings with source evidence.

Every node has a stable semantic ID. File and symbol IDs do not include line numbers, so ordinary line movement preserves identity. Paths and one-based source spans remain evidence properties.

Representative IDs:

```text
package:@sluice/core
file:packages/core/src/store.ts
symbol:packages/core/src/store.ts#SqliteStore.insertCapture:method
database-table:captures
http-endpoint:/api/status
websocket-message:data.wipe
mcp-tool:project_graph_query
workflow:capture-ingest
finding:url-redaction-gap
```

Representative relationships include `contains`, `depends_on`, `imports`, `exports`, `calls`, `serves_endpoint`, `registers_tool`, `defines_table`, `flows_to`, `reads_from`, `writes_to`, `gated_by`, `tests`, `contradicts`, and `affects`.

## Retrieval model

Version 1 is local and deterministic; it does not call an LLM, embedding API, vector database, or network service.

1. Normalize a query into safe FTS5 terms.
2. Retrieve symbol/file/architecture chunks with BM25.
3. Add exact and partial name/path matches.
4. Fuse and rank candidates.
5. Expand a bounded typed neighborhood around the strongest results.
6. Return source locations, excerpts, nodes, relationships, and freshness guidance.

The caller's agent is the generation layer. This is GraphRAG-style evidence retrieval: lexical retrieval chooses seeds, the knowledge graph supplies connected context, and the agent synthesizes only after opening authoritative source.

## MCP contract

The server publishes initialization instructions, three resources, one orientation prompt, and these tools:

| Tool | Purpose |
|---|---|
| `project_graph_status` | Root, Git head, fingerprint freshness, counts, and diagnostics |
| `project_graph_query` | Local lexical retrieval plus bounded graph expansion |
| `project_graph_get` | Resolve one node by stable ID, path, or exact name |
| `project_graph_neighbors` | Traverse incoming/outgoing typed relationships |
| `project_graph_trace` | Find a bounded shortest relationship path |
| `project_graph_impact` | Reverse-traverse likely consumers, tests, docs, routes, and storage |
| `project_graph_refresh` | Atomically replace generated facts from the current working tree |
| `project_graph_note_upsert` | Add/update a durable manual note with optimistic concurrency |
| `project_graph_note_delete` | Delete only a manual note with compare-and-swap protection |
| `project_graph_validate` | Check freshness, represented files, manual notes, and dangling edges |

Read operations advertise `readOnlyHint: true` and `openWorldHint: false`. Refresh is non-destructive and idempotent with respect to source state. Note deletion is explicitly destructive but cannot remove generated facts.

Resources:

- `sluice-graph://project/instructions`
- `sluice-graph://project/schema`
- `sluice-graph://project/overview`

Prompt:

- `project_graph_orient(task, scope?)`

All stdout from `mcp` mode is reserved for MCP framing. Startup/indexing diagnostics go to stderr.

## Freshness and updates

Discovery runs:

```text
git ls-files --cached --others --exclude-standard -z
```

That includes uncommitted new source while respecting Git ignores. Ignore rules also bind tracked files: a force-added path that matches an ignore rule (`git ls-files --cached --ignored --exclude-standard`) is dropped. A content fingerprint over discovered paths, hashes, and sizes determines staleness. Files larger than the text limit are never read whole; their hash covers size and modification time. Startup auto-refreshes a stale graph unless `--no-auto-refresh` or `SLUICE_GRAPH_AUTO_REFRESH=false` is set.

Refresh builds a complete snapshot before opening a SQLite transaction, then atomically replaces only `indexer` and `curated` rows. Queries therefore see the previous complete revision or the new complete revision, never a half-written graph. Manual notes and their edges survive generated refreshes.

`changedPaths` on the MCP refresh tool records agent intent in its result. The current repository is small enough that version 1 deliberately verifies and indexes the full safe source set on each refresh; it does not trust a caller to enumerate every transitive change.

## Safety boundary

The server never imports `@sluice/apps`, opens the runtime capture database, extracts credentials, executes indexed code/config/scripts, or calls the network.

The indexer never follows symlinks, including symlinked parent directories of paths Git still lists. A symlink is represented by a metadata node whose hash covers its target string; the target is not indexed as text. In addition to Git ignores, hard exclusions reject the following even if force-tracked:

- dependency, build, and cache directories, and `.sluice`;
- capture, export, log, and CA directories;
- `docs/` outside `docs/public/`, which holds private notes and catalogs rendered from captured traffic;
- NDJSON/JSONL outside a `fixtures` directory;
- environment files, `.envrc`, `.netrc`, and package or Git credential files;
- SSH private keys, private keys, certificates, keystores, and GPG/ASC files;
- per-user agent files (`.claude/settings.local.json`, `CLAUDE.local.md`) and `.docker/config.json`;
- HAR/PCAP, logs, Terraform state, browser profile stores;
- SQLite/DB/WAL/SHM files and backup copies of databases and keys.

Text larger than 900 KiB, dependency lockfiles, generated maps/minified files, and binary assets are not copied into FTS. Binary assets still get metadata nodes so the graph represents the complete safe project inventory.

The graph database duplicates indexed source and manual notes in plaintext and FTS tables. If a secret ever reaches an indexed source file, removing the source alone does not erase the old SQLite pages. Stop graph servers, delete the graph database plus any `-wal`/`-shm` files, and rebuild.

Indexed source text is untrusted data. Neither tool output nor a repository comment can expand an agent's permissions or override `AGENTS.md`.

## Manual notes

Use notes sparingly for facts the deterministic indexer cannot derive, such as an accepted architecture decision or a runtime observation. Prefer changing `knowledge/architecture.json` for reviewed project-wide facts that should ship to every clone.

A note should include:

- a stable short ID and clear title;
- the decision/fact and why it matters;
- related graph node IDs and repository evidence paths;
- tags;
- `expectedUpdatedAt` from the current node when updating or deleting.

Unknown related IDs remain visible as validation failures rather than being silently discarded. Never use a note for secrets or captured data. `upsertNote` rejects a title, body, tag, evidence path, or related ID containing a credential-shaped value (Slack, GitHub, GitLab, npm, AWS, and API keys, JWTs, private keys, bearer tokens, cookie or credential assignments). The error names the pattern, never the value. Validation flags stored notes that match, because a note written before this check survives refresh.

## CLI

```text
pnpm graph mcp
pnpm graph refresh [--root PATH] [--db PATH]
pnpm graph status
pnpm graph query <question...> [--limit N] [--hops 0|1|2]
pnpm graph get <id-or-path>
pnpm graph neighbors <id-or-path> [--depth N]
pnpm graph impact <id-or-path> [--depth N]
pnpm graph trace <from> <to> [--depth N]
pnpm graph validate
```

Environment overrides:

- `SLUICE_GRAPH_ROOT`
- `SLUICE_PROJECT_GRAPH_DB`
- `SLUICE_GRAPH_AUTO_REFRESH=false`

## Development

```bash
pnpm --filter @sluice/project-graph typecheck
pnpm --filter @sluice/project-graph test
pnpm exec biome check packages/project-graph/src
pnpm build
node packages/project-graph/dist/cli.js --help
```

Tests cover:

- hard exclusions, including force-tracked secrets and ignored force-added files;
- symlinked parent directories and oversized files;
- binary metadata;
- package, import, call, route, table, command, and tool extraction;
- stable symbol IDs across line movement;
- FTS and LIKE input handling;
- atomic refresh;
- note persistence, conflicts, and credential screening;
- database file modes;
- freshness and retrieval bounds;
- impact edge kinds;
- MCP registration, error results, and the schema resource.

## Known limits

- Call edges are conservative syntax-based resolutions, not a whole-program TypeScript call graph. Dynamic dispatch, reflection, aliasing, and many callbacks remain source-inspection work.
- Route, protocol, SQL, and CLI extraction combines AST and patterns and carries lower semantic certainty than compiler-observed declarations/imports.
- Version 1 rebuilds the safe repository snapshot instead of applying path-local deltas.
- There are no embeddings or graph-community summaries yet. Add them only if measured retrieval failures justify the privacy and complexity cost; local deterministic retrieval remains the baseline.
- Curated findings are reviewed snapshots. Re-verify their cited source and remove or update them when fixed.
