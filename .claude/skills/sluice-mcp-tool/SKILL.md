---
name: sluice-mcp-tool
description: Add or change an MCP tool in Sluice — either an app-contributed tool via an app's mcpTools(), or a core store-backed tool in packages/mcp/src/server.ts. Use this whenever the user wants to expose Sluice data or an action to Claude or any MCP client, says "add an MCP tool", "expose X to Claude", "make X callable from Claude", "wire up sluice-mcp", or asks why a tool's arguments aren't arriving or why a tool's network calls aren't showing up in the capture store. Also use when registering the Sluice MCP server with a client.
---

# Adding an MCP tool to Sluice

Sluice exposes one MCP server (`packages/mcp`, binary name `sluice-mcp`) built by
`buildServer(store)` in `packages/mcp/src/server.ts`. There are two places a tool
can live, and picking the wrong one is the main thing to get right.

## Which seam?

**Core tool** — put it directly in `buildServer` when the tool is generic over
every app and reads the normalized store: workspaces, containers, items,
captures, replay. These are thin, typed wrappers over `SqliteStore` reads and are
service-agnostic (`list_workspaces`, `list_channels`, `get_messages`).

**App-contributed tool** — put it in the app's `mcpTools()` when it is specific to
one service (`fast_speed_test`, `trello_my_cards`). The server discovers these
generically:

```ts
for (const app of apps) {
  for (const t of app.mcpTools?.() ?? []) {
    server.registerTool(t.name, { title: t.name, description: t.description, inputSchema: … }, handler);
  }
}
```

Rule of thumb: if writing it would require `packages/mcp` to import a specific
app package, it belongs in the app instead. The spine never names concrete apps.

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

```ts
const fastMcpTools: AppMcpTool[] = [
  {
    name: 'fast_speed_test',
    description: 'Run an internet speed test via fast.com (Netflix Open Connect): fetch the config, download a range from a CDN target, report Mbps.',
    run: () => runSpeedTest(),
  },
];

export const fastApp: App = { /* …adapter… */, mcpTools() { return fastMcpTools; } };
```

Prefix the name with the app id (`trello_`, `fast_`) — every app's tools land in
one flat namespace on the same server, so unprefixed names will collide.

## Two known traps

and fix them if you're touching the surrounding code.

### 1. App tools can't receive arguments

`AppMcpTool.run` is typed `run(args: Record<string, unknown>)`, but the
registration loop passes `inputSchema: {}` — so every MCP client is told the tool
takes no parameters and `args` always arrives empty. Any app tool that needs
input is currently unimplementable.

The fix is to add an optional `inputSchema` to the `AppMcpTool` interface in
`packages/core/src/types.ts` and thread it through the loop. If the tool you're
adding needs arguments, do that first — otherwise the tool will look like it
works and silently ignore everything it's given.

### 2. App tools bypass the capture store

`sluice_replay` does the full pipeline — build the request, overlay the real
client's learned fingerprint, issue it, then record it:

```ts
const base = app.buildReplayRequest(match.action, params ?? {}, session);
const req = faithfulReplayRequest(store, base);   // headers/params learned from real captures
const capture = await runReplay(req);             // returns a secret-redacted Capture
capture.adapterId = match.app.id;
store.insertCapture(capture);
store.applyParseResult(match.app.parse(capture), capture.ts || Date.now());
```

App tools do none of this. `fetchMyCards` and `runSpeedTest` call bare `fetch`
with hand-written headers, so their traffic is more anomalous to the service
(it doesn't match the browser's real fingerprint) and never enters the store — so
it's invisible to the cartographer, the dashboard and the audit trail, while
`sluice_replay` calls are fully recorded.

If your tool touches the network, prefer routing it through
`buildReplayRequest` → `faithfulReplayRequest` → `runReplay` → `insertCapture`.
That currently requires giving `run` access to the store (widen the signature to
take a context `{ store }` or a `replay(req)` callback). If you deliberately keep
a bare fetch — e.g. the call needs no credentials and no fingerprint matching —
say so in a comment so the divergence is a decision rather than an oversight.

## Error handling

The registration loop already wraps `run` so a throw becomes a tool error rather
than a crashed handler, and the message is redacted on the way out. So **throw a
descriptive error** rather than returning an error-shaped object — returning
`{ error: 'HTTP 401' }` (as `trello_my_cards` does) makes a failure look like a
successful result to the client.

Never put a secret in a message, a description, or a returned field. Tool output
crosses the process boundary to the MCP client.

## Registering the server with a client

The binary is declared as `sluice-mcp` in `packages/mcp/package.json`. Note it
points at `src/cli.ts` — a raw TypeScript file with a `#!/usr/bin/env node`
shebang, which crashes with `ERR_UNKNOWN_FILE_EXTENSION` if a client spawns it
directly. Until the packaging task lands, run it through tsx:

```bash
claude mcp add sluice -- pnpm --dir /path/to/sluice exec node packages/mcp/dist/cli.js  # or tsx packages/mcp/src/cli.ts in dev
```

Verify a new tool end to end rather than trusting registration: start the server,
confirm the tool is listed with the parameters you expect (not an empty schema),
and call it once with real arguments.


## Multi-step flows

Core tools (not app tools) for observation-learned bursts:

- `sluice_list_flows` — observed/pinned flows + learned templates (ids, step counts, params, **qualityNotes**, **apiStepCount**). No secrets. Includes a short `guidance` object for agents.
- `sluice_describe_flow` — step roles, bindings, `offsetFromPrimaryMsP50` / `offsetSpreadMs`, unreproducible flags, qualityNotes. No secrets.
- `sluice_replay_flow` — sequential read-only run via `buildFlowStepRequest` (**must pass `allowedHosts: app.hosts`**) + `runFlowReplay` + `runReplay`.

App tools that need multiple hops should call `ctx.replayFlow(templateId, params)` rather than chaining bare `fetch`. Single hops still use `ctx.replay(req)`.

### Operational contract (do not omit from tool descriptions)

From live Trello/Slack capture review — keep these in descriptions when editing flow tools:

1. MCP does **not** cluster or learn; operators run `sluice learn-flows --adapter <id>` after capture.
2. Prefer templates with `sampleCount ≥ 2` and API primaries (`cards/:id`, `boards/:id`, …) — **not** `assets/*`.
3. MITM/WS → no page-load correlation; CDP → `loaderId`/`pageLoadId`. WS excluded from HTTP bursts.
4. Sibling pacing is **primary-anchored** (`offsetFromPrimaryMsP50`, 2s cap); negative offsets = pre-primary, fire immediately if late.
5. Soft unreproducible companions skip; required failures stop; no write ops; hosts must match adapter allowlist.
6. List/describe expose `qualityNotes` so agents can reject asset-primary or single-sample junk without re-deriving heuristics.

### Checklist (flow-related)

- Descriptions state read-only, budgeted, this-machine-only, skip-don't-guess.
- `allowedHosts: app.hosts` on every `buildFlowStepRequest` call site.
- No secrets in list/describe/replay results.
- `pnpm --filter @sluice/mcp test` after description or schema changes.

## Checklist

- Right seam: does `packages/mcp` need to know a specific app? Then it belongs in the app.
- Name prefixed with the app id, for app tools.
- Description states what it returns and what the parameters scope.
- `inputSchema` declared — and for app tools, confirm it's actually threaded through.
- Bounds on any limit/count parameter.
- Network-touching tools go through faithful replay and land in the store, or carry a comment explaining why not.
- Errors thrown, not returned as data. No secrets in output.
- `pnpm typecheck`, then call the tool for real.
