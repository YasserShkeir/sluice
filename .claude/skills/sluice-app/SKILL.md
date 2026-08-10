---
name: sluice-app
description: Build or modify a Sluice app package (@sluice/app-*) — the Adapter, its parser, replay actions, optional CredentialProvider, and workspace registration. Use this whenever the user wants Sluice to support a new service (Notion, Linear, Jira, Discord, Asana, GitHub, or any SaaS), says "add an app/adapter for X", "make Sluice capture X", "support X in Sluice", or is working through the PLANNED_APPS placeholders. Also use when editing an existing packages/app-* package — its matchRequest, parse, listReplayActions, buildReplayRequest, or credential provider — since the same contracts and traps apply.
---

# Authoring a Sluice app

An "app" is one self-contained package that teaches Sluice about one service. The
spine (interceptor → runner → mcp → webapp) never imports an app directly; it
only ever sees the generic `App` interface. That is the whole point of the seam:
adding a service should touch exactly two files outside its own package.

`packages/app-fast` is the smallest complete example (142 + 188 lines,
credential-free). `packages/app-trello` is the smallest example *with*
credentials. Read whichever matches the service before writing code.

## File layout

Four files. Nothing else is required.

```
packages/app-<id>/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts            # exports `<id>App: App` — the single public entry
    └── <id>-adapter.ts     # matchRequest / parse / replay (split out once index.ts grows)
```

`package.json` — copy from app-fast and change name/description. Keep
`"private": true` and `"exports": { ".": "./src/index.ts" }`; the repo has no
build step yet, so exports point at TypeScript source.

```json
{
  "name": "@sluice/app-<id>",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Sluice <Service> app: adapter, parser, replay actions<, credential provider><, MCP tools>.",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "node --import tsx --test src/*.test.ts" },
  "dependencies": { "@sluice/core": "workspace:*" },
  "devDependencies": { "@types/node": "^20.10.0" }
}
```

`tsconfig.json` is three lines — `extends: "../../tsconfig.base.json"`,
`types: ["node"]`, `include: ["src"]`.

pnpm-workspace.yaml already globs `packages/*`, so no workspace edit is needed —
but run `pnpm install` after creating the package so the workspace link resolves.

## The contract

`App extends Adapter` with two optional seams. From `@sluice/core`:

```ts
interface Adapter {
  id: string;                    // stable, lowercase, matches the package suffix
  displayName: string;
  hosts: string[];               // for the catalog + the default host matching
  matchRequest(input: RequestMatchInput): boolean;   // { host, path, method, url }
  parse(capture: Capture): ParseResult;
  listReplayActions(): ReplayAction[];
  buildReplayRequest(action, params, session): ReplayRequest;
  extractCredentialHints?(capture: Capture): CredentialHint[];
}

interface App extends Adapter {
  credentials?: CredentialProvider;
  mcpTools?(): AppMcpTool[];
}
```

Use the same string for the package suffix, `id`, and the `adapterId` on every
entity you emit. The cartographer prefixes materialized tables with it
(`trello_card`), `hasPerAppDb` greps sqlite_master for it, and stats queries key
off it — a mismatch silently produces an app that captures but never shows data.

### matchRequest

Called for every capture from every engine, so keep it cheap and total. Match on
host, and narrow by path only when two apps would otherwise collide.

```ts
function matchesTrello(host: string): boolean {
  return host === 'trello.com' || host === 'api.trello.com' || host.endsWith('.trello.com');
}
```

Unmatched captures are still stored with `adapterId: null` — capture-all is
deliberate. Being conservative here loses nothing but parsing.

### parse

Turn one capture into normalized entities. The four entity types are fixed:
`Workspace`, `Actor`, `Container` (kind: channel | dm | group | board | project |
other), `Item` (kind: message | page | issue | other). Map the service's
vocabulary onto these rather than inventing new shapes — the UI, the MCP tools
and the exporters all read only these.

Return `{}` for anything you don't handle. **Never throw**: `parse` runs inside
the ingest path for every capture, and a throw takes down the funnel. Guard the
JSON:

```ts
export function parseFastCapture(capture: Capture): ParseResult {
  if (capture.host !== 'api.fast.com') return {};
  if (!capture.path.startsWith('/netflix/speedtest')) return {};
  if (!capture.resBody) return {};
  let cfg: FastConfig;
  try { cfg = JSON.parse(capture.resBody) as FastConfig; } catch { return {}; }
  // …build entities…
}
```

Set `raw` on each entity to the original service payload. It costs nothing and it
is what makes the cartographer able to derive typed columns later — the whole
`slack_channel` / `trello_card` table story is built by inferring schema from
`raw`. Set `sourceCaptureIds` on Items so provenance survives.

Export the parse function by name as well as through the app object. Tests import
it directly; see the `sluice-test` skill.

### listReplayActions + buildReplayRequest

A `ReplayAction` is a parameterizable call the UI and `sluice_replay` can
re-issue. `id` should be namespaced (`fast.speedtest.config`, `slack.conversations.history`).

`buildReplayRequest` receives a `Session` and turns the action into a concrete
request. **Read the secrets directly off `session.credentials.values.<key>`.**

```ts
const cookieHeader = session.credentials.values.cookieHeader;
if (cookieHeader) headers.Cookie = cookieHeader;
```

#### The `injection` trap

`CredentialBundle.injection` looks like a declarative "how to apply this
credential" descriptor, but its semantics are **not consistent across adapters
today**, so don't rely on a generic consumer honoring it:

- Slack's builder treats `injection.cookies` values as *keys into `values`*
  (`creds.values[ref] ?? ref`) — an indirection.
- Slack's builder copies `injection.headers` values **literally**
  (`headers[k] = v`) — no indirection.
- Trello's builder ignores `injection` entirely and reads `values` directly,
  even though it declares `injection: { headers: { Cookie: 'cookieHeader' } }`.

That mismatch is a live bug: a Trello session reaching Slack's builder emits a
literal `Cookie: cookieHeader` header. Until the two agree, treat `injection` as
documentation of intent and do the real work explicitly in your own builder,
which only ever receives sessions for its own adapter.

## Credentials (optional)

Only if the service needs auth. Everything `extractSessions` returns is SECRET:
`credentials.values` must never be persisted, logged, or streamed — the store
deliberately has nowhere to put it, and only `redactSession()` output crosses
those boundaries.

```ts
const trelloCredentials: CredentialProvider = {
  extractSessions: async (): Promise<Session[]> => { /* mint in-memory Sessions */ },
  listWorkspaces:   async () => [ /* passive, secret-free — used by `sluice doctor` */ ],
  sessionFromInput: (input) => { /* paste-in fallback for non-macOS */ },
};
```

Implement `listWorkspaces` even when it feels redundant. `sluice doctor` skips any
app that lacks it, so without it your app is silently unchecked and a broken
credential only surfaces when a tool fails.

Two things the existing providers get wrong — don't copy them:

- **Don't swallow every failure.** app-trello wraps its whole body in
  `catch { return []; }`, so a locked cookie DB, a Keychain denial and "not
  signed in" are indistinguishable. Return `[]` only for genuinely absent
  sessions; surface extraction failures with a reason.
- **Don't hard-throw on non-darwin without a fallback.** Guard the local-store
  path by platform, but implement `sessionFromInput` so paste-in still works.

If you need Chrome cookie decryption, reuse `app-trello/src/chrome-cookies.ts`
rather than copy-pasting it a third time — it and `slack-credentials.ts` already
duplicate the same OSCrypt code, and the duplication is tracked as a bug.

## MCP tools (optional)

Add `mcpTools()` if the app should expose an action to Claude. The full contract,
including the argument-passing and traffic-capture traps, is in the
**`sluice-mcp-tool`** skill — read it rather than copying app-trello's
`fetchMyCards`, which uses a bare `fetch` and is invisible to the store.

## Registration — the two files outside your package

1. `packages/apps/src/index.ts` — import and add to the array. This is the one
   place that names concrete app packages.

   ```ts
   import { notionApp } from '@sluice/app-notion';
   export const apps: App[] = [slackApp, fastApp, trelloApp, notionApp];
   ```

2. `packages/runner/src/server.ts` (~line 136) — remove your id from
   `PLANNED_APPS`. It is a hardcoded list of unbuilt placeholders the catalog
   advertises; leaving your id there makes the UI show the app twice, once real
   and once as a stub.

## Before you call it done

- `pnpm install` (workspace link), then `pnpm typecheck` — it runs every package.
- The repo's tsconfig is strict with `verbatimModuleSyntax` and
  `noUncheckedIndexedAccess`: use `import type` for type-only imports, end every
  relative import with `.js`, and treat indexed access as possibly-undefined.
- `pnpm sluice doctor` should list your app's sign-in line (that is `listWorkspaces`).
- Capture something real, then `pnpm sluice build-db` and confirm `<id>_*` tables
  appear — that proves matchRequest → parse → materialize end to end.
- Add tests for `parse` at minimum; see the `sluice-test` skill.
- Consider documenting the service's endpoints first — see the `sluice-api-doc`
  skill. Writing the adapter is much easier when you already know what the client
  actually calls.

## Optional flow hints

Adapters may implement `listFlowHints()` returning `{ primaryKey, label?, companions[] }` sketches when capture clustering is weak. Data-learned templates from `learnFlowTemplates` always win at replay — hints are documentation for agents/UI, not a second fingerprint path. Never hardcode frozen Chrome UAs in flow builders; use cartographer `buildFlowStepRequest`.

