---
name: sluice-mcp-tool
description: Add or change an MCP tool in Sluice — either an app-contributed tool via an app's mcpTools(), or a core store-backed tool in packages/mcp/src/server.ts. Use this whenever the user wants to expose Sluice data or an action to Claude or any MCP client, says "add an MCP tool", "expose X to Claude", "make X callable from Claude", "wire up sluice-mcp", or asks why a tool's arguments aren't arriving or why a tool's network calls aren't showing up in the capture store. Also use when registering the Sluice MCP server with a client.
---

# Adding an MCP tool to Sluice

Sluice exposes one MCP stdio server (`packages/mcp`, binary `sluice-mcp`) built by
`buildServer(store)` in `packages/mcp/src/server.ts`. It advertises 11 core tools
plus every tool contributed by the machine's *enabled* apps — 18 today (fast 1,
trello 1, gmail 5, loom 4, linkedin 7; Slack contributes none), for 29 total on a
machine with no `adapters` allow-list.

There are two places a tool can live, and picking the wrong one is the main thing
to get right.

## Which seam?

Two questions decide it. The second one is the harder constraint.

**Does `packages/mcp` have to name a specific app?** If yes, it belongs in the
app. The spine never imports an app package.

**What store access does it need?**

| | Core tool | App tool |
| --- | --- | --- |
| Store | the full read-write `SqliteStore`, closed over | `ctx.store = readOnlyStore(store)` |
| Raw SQL | yes — `rawDb(store)` backs `list_endpoints`, `search_captures`, `describe_endpoint` | no `db` handle at all |
| Writes | `insertCapture`, `applyParseResult`, `upsertFlow` | none |
| Network | `runReplay` directly | `ctx.replay` / `ctx.replayFlow` |

`readOnlyStore` is a narrowing **by value**, not merely by type: it returns a
fresh object of nine bound reads — `listWorkspaces`, `listContainers`, `listItems`,
`queryItems`, `countItems`, `searchItems`, `listEdges`, `countCaptures`,
`newestCaptureTs`. A test asserts `db`, `insertCapture`, `applyParseResult`,
`upsertItem`, `upsertSession`, `listSessions`, `pruneCaptures` and `close` are all
absent. It also returns no `Capture` at all — coverage questions are answered by
`countCaptures` and `newestCaptureTs` so capture bodies (up to 5 MB) never reach
an app tool.

**So a tool that needs to write, or needs raw SQL, cannot be an app tool.** If
that is what your service-specific tool needs, either reshape it to a read, or
argue for a new read on `ReadOnlyStore` in `packages/core/src/store.ts` — do not
widen the projection ad hoc.

The core tools today: `list_workspaces`, `list_channels`, `get_messages`,
`list_endpoints`, `search_captures`, `describe_endpoint`, `replay`,
`sluice_list_flows`, `sluice_describe_flow`, `sluice_replay_flow`, `auth_flow`.
Note the single-request replay tool is registered as plain **`replay`** — there is
no tool named `sluice_replay`, and only the three flow tools carry the `sluice_`
prefix.

App tools are discovered generically, over the **enabled** apps:

```ts
for (const app of enabledApps()) {
  const ctx: AppToolContext = { store: readOnlyStore(store), replay, replayFlow };
  for (const t of app.mcpTools?.() ?? []) {
    const inputSchema = (t.inputSchema ?? {}) as ZodRawShape;
    server.registerTool(t.name, { title: t.name, description: t.description, inputSchema }, handler);
  }
}
```

`enabledApps()`, not `apps`: the `adapters` allow-list in `~/.sluice/config.json`
narrows the advertised tool surface per machine (an unknown id in that array
throws at startup). A client that installed Sluice only for Gmail should not be
spending its tool budget on Slack's and Trello's.

## Core tool shape

Core tools use zod for `inputSchema`, and the value is a **plain object of zod
validators**, not a `z.object(...)`:

```ts
server.registerTool(
  'get_messages',
  {
    title: 'Get messages / items',
    description: 'List items (messages, pages, issues…) in a container, newest first. Default limit 200.',
    inputSchema: {
      containerId: z.string(),
      limit: z.number().int().positive().max(1000).optional(),
    },
  },
  async ({ containerId, limit }) => jsonResult(store.listItems(containerId, { limit })),
);
```

Descriptions are the tool's whole interface to the model — say what it returns
and what the parameters scope, since the client sees nothing else. Bound anything
unbounded (`.max(1000)`) so a model can't ask for the entire store.

Use the existing `jsonResult` / `errorResult` helpers rather than hand-building
content blocks.

## App-contributed tool shape

Prefix the name with the app id — a test enforces that every app tool name starts
with `${app.id}_`, because all apps land in one flat namespace on one server.

```ts
const loomMcpTools: AppMcpTool[] = [
  {
    name: 'loom_get_video',
    description:
      'Fetch one Loom video by its id (name, owner, privacy, view/comment/reaction counts, thumbnail, shareUrl). The id is the 32-char token in a share URL (loom.com/share/<id>).',
    inputSchema: { videoId: z.string() },       // a zod RAW SHAPE, not z.object(...)
    run: (args, ctx) => getVideo(args, ctx),
  },
];

export const loomApp: App = { /* …adapter… */, mcpTools() { return loomMcpTools; } };
```

### App tools take arguments

`AppMcpTool.inputSchema?: Record<string, unknown>` is a zod raw shape, kept
structurally typed so `@sluice/core` stays zod-free, and the registration loop
passes it straight through to `registerTool`. Twelve app tools ship declared
schemas today (gmail 4, loom 4, linkedin 4).

Declare it as `{ videoId: z.string() }`, **not** `z.object({ videoId: z.string() })`.
Omit it only for a genuinely argument-less tool (`fast_speed_test`,
`trello_my_cards`, `gmail_sync_status`) — a tool that declares nothing is
advertised as taking no parameters, so `run` never receives any.

Add zod to the app package's `dependencies` when you declare a schema; app-gmail,
app-loom and app-linkedin already do.

### Network-touching app tools must use `ctx.replay`

`AppToolContext` is `{ store?: ReadOnlyStore, replay(req), replayFlow?(templateId, params, opts) }`,
built fresh per app and passed as `run(args, ctx)`. `ctx.replay` is the same
pipeline the `replay` core tool uses:

```
faithfulReplayRequest(store, base)   // overlay the real client's learned fingerprint
  → runReplay(req)                   // method allowlist → write-op denylist → 60/60s budget → single-flight
  → record(capture)                  // adapterId stamped, insertCapture, applyParseResult
```

with a 401 → re-extract → retry-once refresh wrapped around it, both attempts
recorded. A bare `fetch` gets none of that: it is *more* anomalous to the service
(it does not match the browser's real fingerprint), it skips the rails and the
process-global budget shared with the CLI and the dashboard, and it never enters
the store, so it is invisible to the cartographer, the dashboard and the audit
trail.

Every shipped network tool routes through the context: `runSpeedTest(ctx)` issues
its config call via `ctx.replay`, `trello_my_cards` passes `ctx` into
`trelloGet(…, ctx)`, Loom's four tools go through `replayOrFetch(ctx)`, and
`linkedin_fetch_me` throws if `ctx.replay` is absent.

The **one** deliberate bare fetch left is fast.com's multi-megabyte range
download, which stays outside the pipeline so a ~25 MiB body never enters SQLite.
If you keep a bare fetch, say why in a comment so the divergence is a decision.

For multiple hops, prefer `ctx.replayFlow(templateId, params)` over chaining
`ctx.replay` — and never nest: `ctx.replay` funnels into a single-slot mutex that
self-deadlocks on re-entry. Loom's cookie refresh issues its second attempt
sequentially for exactly this reason.

`ctx.store` is optional in the type and must be treated as such. Gmail's and
LinkedIn's store-backed tools throw a named error when it is absent — "This tool
reads the Sluice capture store, and the host did not provide one. Run it through
`sluice-mcp`." — rather than assuming a host provides it.

## Error handling

The registration loop wraps `run` so a throw becomes a tool error rather than a
crashed handler, and the message goes through `redactText` on the way out. So
**throw a descriptive error** rather than returning an error-shaped object —
returning `{ error: 'HTTP 401' }` (as `trello_my_cards` does) makes a failure look
like a successful result to the client.

Never put a secret in a message, a description, or a returned field. Tool output
crosses the process boundary to the MCP client.

## Registering the server with a client

`packages/mcp/package.json` declares `"bin": { "sluice-mcp": "./dist/cli.js" }` —
the bundle, not the source. `scripts/build.mjs` emits it, strips esbuild's
inherited shebang, prepends one `#!/usr/bin/env node` and chmods 0o755, so the
built file runs directly under plain `node`.

```bash
pnpm build                                                    # emits packages/mcp/dist/cli.js
claude mcp add sluice -- node /path/to/sluice/packages/mcp/dist/cli.js
```

That is the same command both `packages/mcp/README.md` and the root README use;
keep all three identical. In dev, before a build:
`claude mcp add sluice -- pnpm --dir /path/to/sluice exec tsx packages/mcp/src/cli.ts`.

The server opens the real read-write store at `$SLUICE_DB` or `~/.sluice/sluice.db`,
runs `installExternalAdapters()` and then `app.reconcile(store)` for every enabled
app before the first tool call — both are startup side effects, and reconcile is a
write. stdout carries only MCP protocol frames; every diagnostic goes to stderr.

Verify a new tool end to end rather than trusting registration: start the server,
confirm it is listed with the parameters you expect (not an empty schema), and
call it once with real arguments.

## Multi-step flows

Core tools (not app tools) for observation-learned bursts:

- `sluice_list_flows` — observed/pinned flows + learned templates (ids, step
  counts, params, **qualityNotes**, **apiStepCount**). No secrets. Includes a
  short `guidance` object for agents.
- `sluice_describe_flow` — step roles, binding **kinds only**,
  `offsetFromPrimaryMsP50` / `offsetSpreadMs`, unreproducible flags, qualityNotes.
  No secrets, no token values.
- `sluice_replay_flow` — sequential read-only run via `buildFlowStepRequest`
  (**must pass `allowedHosts: app.hosts`**) + `runFlowReplay` + `runReplay`.

Note the asymmetry worth preserving: flow replay enforces a host allowlist per
step; single-request `replay` does not.

### Operational contract (do not omit from tool descriptions)

1. MCP does **not** cluster or learn; operators run
   `sluice learn-flows --adapter <id>` after capture.
2. Prefer templates with `sampleCount ≥ 2` and API primaries (`cards/:id`,
   `boards/:id`, …) — **not** `assets/*`.
3. MITM/WS captures carry no page-load correlation; CDP fills
   `loaderId`/`pageLoadId`. WS is excluded from HTTP bursts.
4. Sibling pacing is **primary-anchored** (`offsetFromPrimaryMsP50`, 2 s cap);
   negative offsets mean pre-primary, fire immediately if late.
5. Soft unreproducible companions skip; required failures stop the flow; no write
   ops; hosts must match the adapter allowlist. Whole-flow timeout 120 s.
6. List/describe expose `qualityNotes` so agents can reject asset-primary or
   single-sample junk without re-deriving heuristics.

### Checklist (flow-related)

- Descriptions state read-only, budgeted, this-machine-only, skip-don't-guess.
- `allowedHosts: app.hosts` on every `buildFlowStepRequest` call site.
- No secrets in list/describe/replay results.
- `pnpm --filter @sluice/mcp test` after description or schema changes.

## Checklist

- Right seam: does `packages/mcp` need to know a specific app (→ app tool), and
  does the tool need to write or reach raw SQL (→ core tool, since the app
  context is read-only)?
- Name prefixed with the app id, for app tools — a test enforces it.
- Description states what it returns and what the parameters scope.
- `inputSchema` declared as a zod raw shape, or deliberately omitted.
- Bounds on any limit/count parameter.
- Network-touching tools go through `ctx.replay` / `ctx.replayFlow` and land in
  the store, or carry a comment explaining why not.
- `ctx.store` treated as optional — throw a named error when it is absent.
- Errors thrown, not returned as data. No secrets in output.
- `pnpm typecheck`, `pnpm --filter @sluice/mcp test`, then call the tool for real.
