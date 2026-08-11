# @sluice/mcp

Local MCP server that exposes this machine’s Sluice store to agents: workspaces,
containers, items, captures, **single-request replay**, and **multi-step
interaction flows** — plus whatever tools each installed app contributes.

Binary: `sluice-mcp` (stdio). Prefer the built entry after a root `pnpm build`:

```bash
# preferred once built
claude mcp add sluice -- node /path/to/sluice/packages/mcp/dist/cli.js

# dev fallback (tsx on TypeScript source)
claude mcp add sluice -- pnpm --dir /path/to/sluice exec tsx packages/mcp/src/cli.ts
```

`packages/mcp` has no `build` script of its own — `scripts/build.mjs` (driven by
the root `pnpm build`) emits `packages/mcp/dist/cli.js` as one of its three
targets, with a shebang and mode 0755, so it runs directly under plain `node`.
Nothing here is published to npm yet; the path above is the only install.

## Trust model

- **The server holds a read-write store.** `openStore()` opens the real
  `SqliteStore` at `$SLUICE_DB`, or `~/.sluice/sluice.db`. It writes:
  `insertCapture` + `applyParseResult` for *every* `replay` attempt (including a
  failed one and its refreshed retry), per-step captures plus `upsertFlow` on
  flow replay, and `app.reconcile(store)` for every enabled app at startup.
- **App-contributed tools do not.** Each app gets an `AppToolContext` whose
  `store` is `readOnlyStore(store)` — a by-value projection of nine bound reads
  with no writers and no `db` handle, enforced by a test. An app tool that needs
  to write cannot be an app tool.
- **The store never holds live credentials.** Replay acquires a `Session`
  in-memory (Keychain / local browser profile) and never writes
  `credentials.values` to SQLite, tool results, or logs. Apps with no credential
  provider (fast.com, Gmail) replay with a synthetic session whose values are
  empty by construction, so no Keychain prompt is possible.
- **Tool errors pass through redaction** before leaving the process. stdout
  carries MCP protocol frames only; every diagnostic goes to stderr.
- **The replay budget is process-global** — 60 requests per 60 seconds, shared
  with the CLI, the dashboard and `sluice sync`. Exhausting it here exhausts it
  everywhere in this process.
- **Flow describe/list return binding kinds and names only** — never token
  values, cookies, or full bodies.

## Tool surface

Eleven core tools, plus every tool contributed by the machine's *enabled* apps.
The app loop iterates `enabledApps()`, so the `adapters` allow-list in
`~/.sluice/config.json` narrows the advertised surface per machine (and an
unknown id in that array throws at startup). With no allow-list, all six
installed apps contribute and the server advertises 29 tools.

### Core

| Tool | Role |
|------|------|
| `list_workspaces` | Every workspace. No arguments, no limit |
| `list_channels` | Containers, optionally scoped to one `workspaceId` |
| `get_messages` | Items in a container, newest first (`limit` default 200, max 1000) |
| `list_endpoints` | `method, host, path, count` over all captures, by frequency. No limit |
| `search_captures` | LIKE over url/path/host (`limit` default 50, max 500). Metadata only — never bodies |
| `describe_endpoint` | Union of top-level JSON response keys + status codes over the 100 most recent captures of a `method` + `path` |
| `replay` | **Makes a live network request.** One `actionId` → faithful fingerprint → `runReplay` → store |
| `sluice_list_flows` | Observed/pinned bursts + learned templates (ids, primaryKey, sampleCount, qualityNotes) |
| `sluice_describe_flow` | Step plan: roles, offsets, param kinds, unreproducible flags |
| `sluice_replay_flow` | **Makes live network requests.** Sequential read-only run via `buildFlowStepRequest` + `runFlowReplay` + `runReplay` |
| `auth_flow` | Maps how a service authenticates you, over the 5,000 most recent captures. Names and redacted previews only |

Only `replay` and `sluice_replay_flow` touch the network. Note the naming: the
single-request tool is **`replay`**, not `sluice_replay`; only the three flow
tools carry the `sluice_` prefix.

### App-contributed

Registered verbatim under their own names; a test enforces that every one starts
with `<app.id>_` so the flat MCP namespace stays collision-free.

| App | Tools | Network? |
|---|---|---|
| slack | *(none)* | — |
| fast | `fast_speed_test` | yes, via `ctx.replay` (the range downloads stay a bare fetch so 25 MiB bodies never enter SQLite) |
| trello | `trello_my_cards` | yes, via `ctx.replay` |
| gmail | `gmail_sync_status`, `gmail_list_labels`, `gmail_list_threads`, `gmail_get_thread`, `gmail_search` | no — all five answer from the capture store |
| loom | `loom_list_videos`, `loom_get_video`, `loom_list_notifications`, `loom_get_transcript` | yes, all four |
| linkedin | `linkedin_sync_status`, `linkedin_me`, `linkedin_list_jobs`, `linkedin_list_conversations`, `linkedin_list_messages`, `linkedin_search`, `linkedin_fetch_me` | only `linkedin_fetch_me` |

Store-backed tools throw a named error when the host provides no store — they
are meant to run through `sluice-mcp`, not as a library.

### Agent contract (from live Trello/Slack capture)

1. **Learn offline** — MCP does not cluster. After browsing under capture, run
   `sluice learn-flows --adapter <id>`. Then list/describe/replay.
2. **Prefer quality templates** — `sampleCount ≥ 2`, `primaryKey` is a real API
   op (`cards/:id`, `boards/:id`, `conversations.history`), not `assets/*` or a
   hashed SPA filename. Use `qualityNotes` on list/describe.
3. **Describe before replay** — supply every required `flowParam`; pick
   `workspaceId` when multiple sessions exist. `pickSession` refuses to guess:
   with no hint it succeeds only if exactly one session exists.
4. **Correlation** — MITM/WS captures have no `pageLoadId`/`loaderId`; bursts are
   **time-window** clustered. CDP populates loader ids when that engine is on.
   WebSocket frames are **excluded** from HTTP flow clustering.
5. **Pacing** — companions use `offsetFromPrimaryMsP50` (ms from primary start,
   hard-capped at 2 s). Negative offsets mean the companion was observed *before*
   the learned primary (auth/bootstrap); replay fires those immediately if still
   pending. Fallback: chained `delayMsP50`. The whole flow times out at 120 s.
6. **Rails** — each step: GET|HEAD|POST only, write-op denylist, host must
   match `app.hosts`. Soft unreproducible companions skip; required failures stop.
7. **No writes** — flow replay is not for create/update/delete.
8. **Assets** — SPA bundles are deprioritized as primaries and dropped from
   learned templates as soft companions; do not treat asset primaries as actions.

App tools that need multiple hops must use `ctx.replayFlow(templateId, params)`
(or `ctx.replay` per hop), not bare `fetch` — that is what buys them the faithful
fingerprint, the rails, the budget and the store write-back. See
`.claude/skills/sluice-mcp-tool/SKILL.md`.

## Related

- CLI: `sluice flows`, `sluice learn-flows`, `sluice replay --flow`
- Learning: `packages/cartographer` (`flows.ts`, `flow-learn.ts`, `flow-build.ts`)
- Executor: `packages/interceptor/src/flow-replay.ts`
