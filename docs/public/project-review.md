# Whole-project architecture review

Review snapshot: 2026-08-18. The generated source graph was validated against Git head `a5d1c8738d5064a5a49251632d04f9fd3be4eb7f` plus the graph implementation in the working tree.

This document summarizes the human review behind `packages/project-graph/knowledge/architecture.json`. A finding marked **open at review** is not permanent truth: verify its evidence before changing code, and update or remove the curated node when the implementation changes. The Status column below was updated after the 2026-09 cleanup and security pass; each fixed or partially fixed row names the regression evidence, and the matching `finding` node carries the same status and evidence.

## System map

Sluice is a pnpm/TypeScript monorepo with a small dependency spine and service integrations attached through one registry.

```text
Foundation       core · protocol · adapter-sdk
Capture/replay   interceptor · extension
Derivation       cartographer
Integrations     app-* → apps registry
Control          runner · captured-data MCP · CLI launcher
Presentation     React/Vite webapp
Knowledge        project-graph · build/CI · architecture sources · agent rules
```

- `@sluice/core` owns domain contracts, redaction, replay-deny/auth helpers, body encoding, SQLite DDL, storage, pagination work, flows/templates, and the read-only store projection.
- `@sluice/protocol` validates client-to-server WebSocket messages with Zod without pulling native core storage into the browser.
- `@sluice/adapter-sdk` supplies adapter coercion, request parsing, fixtures, scrubbers, conformance, and mock capture replay.
- `@sluice/interceptor` owns MITM/CDP capture, Chrome/CA integration, credentials, replay/refresh/flow execution, and supervision.
- `@sluice/cartographer` builds API maps, schemas/materialized tables, faithful request fingerprints, observed flows, and learned flow templates.
- Six `@sluice/app-*` packages implement Slack, fast.com, Trello, Gmail, Loom, and LinkedIn; `@sluice/apps` is the sole built-in registration seam.
- `@sluice/runner` is the composition root: CLI, loopback HTTP/WS/PTY, process/controller lifecycle, ingest, replay orchestration, system proxy, and configuration.
- `@sluice/mcp` exposes captured/normalized account data and live replay-capable tools.
- `@sluice/project-graph` separately exposes source architecture and never opens runtime captures or credentials.
- `apps/webapp` is the React dashboard; `packages/extension` is the MV3 page/content/worker ingest path; `packages/cli` is a zero-logic launcher.

## Runtime flows

Capture:

```text
MITM / CDP / extension / replay
  → Capture
  → core persistCapture: redaction (URL-like fields included) and app attribution/classification
  → captures + FTS
  → adapter parse
  → Workspace / Actor / Container / Item / Edge
  → cursor queue
  → WebSocket broadcast and cartographer materialization
```

Single replay:

```text
caller → app action + in-memory session → app request builder
       → faithful observed fingerprint → method/operation/host/budget/single-flight rails
       → fetch (no redirects) → redacted replay Capture → ingest
```

Flow learning and replay:

```text
observed captures → correlated/time-window bursts → InteractionFlow
                  → support/timing/parameter/binding learner → FlowTemplate

FlowTemplate + params + session → per-step host/deny/binding checks
                                → paced runReplay steps → captures + replay flow
```

Control plane:

```text
CLI / dashboard HTTP+WS / PTY / captured-data MCP
  → runner parent + capability tokens
  → EngineController
  → optional isolated MITM child + supervisor
  → deliberate CA/system-proxy operations
```

The runtime SQLite schema has eleven ordinary application tables (`captures`, `workspaces`, `actors`, `containers`, `items`, `sessions`, `edges`, `cursors`, `interaction_flows`, `interaction_flow_steps`, `flow_templates`) plus contentless capture/item FTS tables and SQLite shadow tables. Cartographer-owned per-app materializations share that database.

The build now has four Node entrypoints—runner CLI, engine child, captured-data MCP, and project-graph MCP—plus the Vite dashboard copied into runner output.

## Findings

| Severity | Finding | Evidence | Status |
|---|---|---|---|
| High | A caller-controlled materialization prefix can select core flow tables because the deny set omits `interaction_flows`, `interaction_flow_steps`, and `flow_templates`, while WS operations accept arbitrary adapter IDs. | `packages/cartographer/src/materialize.ts`, `packages/protocol/src/index.ts`, `packages/runner/src/server.ts` | **Fixed**: core `CORE_TABLE_NAMES` feeds cartographer's `isReservedTable` (create, write and drop paths), and the runner refuses a WS `adapterId` that is not installed (`drop-materialized.test.ts`, `server.test.ts`) |
| High | The extension bridge accepts a public window-message tag. Page JavaScript can forge shaped captures which the worker forwards with its hidden ingest token; caller IDs also reach capture upsert. | `packages/extension/content.js`, `packages/extension/background.js`, `packages/runner/src/server.ts` | **Partially fixed**: field whitelist, sender-frame and URL scope in the extension; server-minted ids, host/path from the URL only, clamped timestamps (`capture-scope.test.js`, `server.test.ts`). MAIN-world page script on an in-scope page can still forge captures |
| High | The central runner sanitizer re-redacts headers/bodies but not `url` or `tabUrl`; extension query strings and CDP tab URLs can retain URL credentials or OAuth codes. | `packages/runner/src/server.ts`, `packages/interceptor/src/cdp-engine.ts` | **Fixed**: core `redactCaptureUrls` via `persistCapture` and the engines' `redactedCapture`; query-shaped params (`?code=`, `&sig=`, …) masked in URLs, header values, bodies and classification (`redact.test.ts`, `persist.test.ts`, `server.test.ts`) |
| High | The token commonly described as read-only also upgrades the dashboard WebSocket and authorizes replay/sync, capture and proxy control, and destructive data operations. | `packages/core/src/protocol.ts`, `packages/protocol/src/index.ts`, `packages/runner/src/server.ts` | **Partially fixed**: documented as the session token (full control), Origin limited to the runner's own port or `:5273`, Bearer header from the webapp. No capability split |
| High | Replay permits POST and relies on a finite operation denylist; this cannot prove unknown RPC/GraphQL operations are non-mutating. Single replay also lacks flow replay's positive host rail. | `packages/interceptor/src/replay-policy.ts`, `packages/core/src/replay-deny.ts`, `packages/interceptor/src/replay.ts` | **Partially fixed**: every `runReplay` caller passes the app's hosts (core `replayHostAllowed`), redirects are not followed, the denylist checks percent-decoded input and method overrides, flow build requires a non-GET step to match a replay action, and the docs call the rails heuristics. A finite denylist still cannot prove non-mutation |
| High | Dashboard replay/flow messages omit a session ID and ignore discovered sessions; the runner falls back to the first same-app session, which can select the wrong workspace/account. | `apps/webapp/src/pages/ReplayPage.tsx`, `apps/webapp/src/ws.ts`, `packages/runner/src/server.ts` | **Fixed**: account picker and `sessionId` in the webapp; the runner refuses unknown ids and ambiguity, never `sessions[0]` (`server.test.ts`, `replay-actions.test.ts`, `replay.test.ts`) |
| High | `linkedin_fetch_me` constructs a completed request without Cookie/CSRF; the generic app-tool replay context does not add LinkedIn's credential injection afterward. | `packages/app-linkedin/src/mcp-tools.ts`, `packages/app-linkedin/src/linkedin-adapter.ts`, `packages/mcp/src/server.ts` | **Fixed**: `AppToolContext.replayAction`, implemented by the MCP server with a real session; `linkedin_fetch_me` uses it (`linkedin.test.ts`, mcp `server.test.ts`) |
| Medium | Ingest stamps `parsedAt` before adapter parsing and does not consistently contain `matchRequest`/parse failures, so failed normalization can look complete. | `packages/runner/src/server.ts` | **Fixed**: `persistCapture` stamps `parsedAt` only after a successful parse and contains adapter hook throws (`persist.test.ts`, `server.test.ts`) |
| Medium | Server and direct CLI replay/sync/drain paths duplicate persistence behavior, causing differences in parsed state, cursor seeding, broadcast, materialization, and deletion integrity. | `packages/runner/src/cli.ts`, `packages/runner/src/server.ts` | **Fixed**: one core `persistCapture` funnel for the server, every CLI path and the MCP record paths; `rebuildDerived` after every delete |
| Medium | Whole Capture objects—including bodies—still travel through list, broadcast, backfill, and the replay ring despite on-demand-body comments. | `packages/core/src/types.ts`, `packages/runner/src/server.ts`, `packages/runner/src/api.ts` | **Fixed**: 64 KiB body previews (`bodyTruncated`, `bodyLengths`) in lists, broadcast, backfill and the ring; full body by id (`server.test.ts`) |
| Medium | The webapp receives `hello` but never sends the protocol's `hello.ok` version acknowledgement. | `apps/webapp/src/ws.ts`, `packages/runner/src/server.ts`, `packages/protocol/src/index.ts` | **Fixed**: `hello.ok` on every `hello`, mismatch notice (`ws.test.ts`) |
| Medium | Traffic UI initializes local recording state independently of the server's paused state, so the first apparent resume can send pause again. | `apps/webapp/src/components/TrafficDashboard.tsx`, `apps/webapp/src/App.tsx` | **Fixed**: `captureToggleAction` (`ws.test.ts`) |
| Medium | Gmail advertises a replay action but has no credential provider in normal runner wiring; its thread-tool guidance also points at a list action that does not fetch message bodies. | `packages/app-gmail/src/gmail-adapter.ts`, `packages/app-gmail/src/mcp-tools.ts` | **Fixed**: no replay action is advertised without a session source; thread note updated (`gmail.test.ts`, `mcp-tools.test.ts`) |
| Medium | Fast and Trello always emit children under workspace IDs without emitting those workspaces; some Slack paths do likewise unless boot/count responses were seen. | `packages/app-fast/src/index.ts`, `packages/app-trello/src/trello-adapter.ts`, `packages/app-slack/src/parse.ts` | **Partially fixed**: Fast and Trello emit their parent workspace; the webapp groups an orphan container under its own row. Slack relies on its credential seeding path by design |
| Medium | Trello board-list and action-feed requests are classified/replayed/cursor targets but their responses produce no normalized rows. | `packages/app-trello/src/trello-adapter.ts` | **Fixed**: board lists parse into containers and comment actions into items (`trello.test.ts`) |
| Low | Loom cursor extraction passes numeric GraphQL limits through a string-only coercer and resets custom sizes; notifications tooling also omits an available cursor. | `packages/app-loom/src/loom-adapter.ts`, `packages/app-loom/src/loom.test.ts` | **Fixed**: numeric page sizes survive; notifications take and return a cursor (`loom.test.ts`) |
| Low | The adapter SDK barrel statically re-exports conformance, pulling a module that imports `node:test` into runtime adapter imports. | `packages/adapter-sdk/src/index.ts`, `packages/adapter-sdk/src/conformance.ts` | **Fixed**: `node:test` is loaded lazily inside `runConformance` (`conformance.test.ts`) |

All 17 remain first-class `finding` nodes (now with a `status` of `fixed`, `partially-fixed` or `open-at-review`) connected to affected components, workflows, packages, tables, or security boundaries. Query the graph with terms such as `review finding redaction`, `session replay ambiguity`, or an exact ID like `finding:materialized-drop-core-tables`.

## Coverage gaps

Existing suites exercise core storage/redaction/rails, adapter conformance and parsing, cartographer inference/flows, protocol schemas, MCP handlers, runner controls/server behavior, and webapp utility functions. The review found these higher-value gaps:

- no real mockttp request/response/WebSocket/CA lifecycle integration suite;
- no dedicated CA suite (the CDP engine and Chrome launcher now have `cdp-engine.test.ts` and `launch-chrome.test.ts`);
- no dedicated runner `proxy.ts` or `engine-child.ts` suite (`api.ts` is exercised through `server.test.ts`);
- no extension lint/typecheck/build pipeline (it now has `capture-scope.test.js`) and no bare CLI-wrapper test;
- no normalized-parent referential-integrity conformance rule;
- no concurrent destructive-data-operation suite.

Closed since the review: URL/tab-URL redaction and forged extension entries/caller ids, materialization prefixes targeting core tables, multi-session dashboard replay selection, Trello normalization, LinkedIn live-tool credential injection and Loom page sizes all have regressions, and the CLI/server/MCP ingest paths share one tested funnel (`packages/core/src/persist.test.ts`).

The graph's generated `tests` edges connect test-file imports back to source so `project_graph_impact` can suggest the currently reachable suites without implying these gaps are covered.

## Documentation contradictions observed

- Several security statements described replay as guaranteed read-only although the implementation provides best-effort rails. README, SECURITY.md, CONTRIBUTING.md, `docs/public/scope-and-limits.md`, the MCP tool descriptions and the dashboard copy now say so.
- Some diagrams describe every consumer as read-only and every listener as loopback; dashboard/CLI/MCP can mutate/control. The MITM proxy now binds loopback by default and opens to the LAN only with `--lan-proxy` plus a `--lan-allow` client list.
- Some comments claim protocol message counts are smaller than current unions, or destructive socket messages do not exist. (Capture bodies are now on-demand beyond a 64 KiB preview.)
- The root config example historically used a `~` database path even though config path resolution does not expand it.
- “Nothing leaves the machine” needs an explicit caveat for the optional hosted Claude terminal/tool context; Sluice has no telemetry, but model use is still egress.
- Claims that every normalized row has capture provenance are stronger than the schema: explicit source capture IDs are item-level.
- Hard-coded app/tool/test counts in documentation and agent skills drift as the project changes. Prefer graph-derived inventory and source verification.

These contradictions are review evidence, not license to change the product's stated security posture casually. Resolve the underlying behavior and its tests before strengthening claims.

## Graph and agent boundary

The project graph indexes the safe current Git working tree, not runtime captures. It hard-excludes secrets, databases, HAR/PCAP, certificates, capture/log/CA directories, dependencies, builds, and ignored private docs even when those paths are force-tracked.

Future agents follow `AGENTS.md`: status, refresh if stale, query, inspect relationships/impact, verify source, edit/test, refresh, and validate. Generated facts are replaceable; evidence-backed manual notes survive refresh. The graph is an impact/navigation cache, never the authority for destructive or security decisions.
