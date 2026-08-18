---
name: sluice-app
description: Build or modify a Sluice app package (@sluice/app-*) — the Adapter, its parser, replay actions, optional CredentialProvider, redaction, and workspace registration. Use this whenever the user wants Sluice to support a new service (Notion, Linear, Jira, Discord, Asana, GitHub, or any SaaS), says "add an app/adapter for X", "make Sluice capture X", "support X in Sluice", or is working through the PLANNED_APPS placeholders. Also use when editing an existing packages/app-* package — its matchRequest, parse, classify, nextCursors, listReplayActions, buildReplayRequest, redaction, or credential provider — since the same contracts and traps apply.
---

# Authoring a Sluice app

An "app" is one self-contained package that teaches Sluice about one service. The
spine (interceptor → runner → mcp → webapp) never imports an app directly; it
only ever sees the generic `App` interface. `packages/apps` is the single module
that names concrete app packages, and adding a service touches exactly two files
outside its own package — both of them in `packages/apps`.

Six apps ship today, in registration order: **slack, fast, trello, gmail, loom,
linkedin**. `packages/app-fast` is the smallest complete example (credential-free,
one replay action, one MCP tool). `packages/app-trello` is the smallest example
*with* credentials, and is the model for credential error handling. Read whichever
matches the service before writing code.

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
`"private": true` and `"exports": { ".": "./src/index.ts" }`. The repo does have a
build step (`pnpm build` = `pnpm webapp:build && node scripts/build.mjs`), but app
exports point at TypeScript source because `scripts/build.mjs` inlines every
first-party package into the three esbuild bundles — an app package never needs a
`dist/` of its own.

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

pnpm-workspace.yaml already globs `packages/*`, so no workspace-file edit is
needed — but run `pnpm install` after creating the package so the link resolves.

Licensing: `@sluice/core` and `@sluice/adapter-sdk` are Apache-2.0 precisely so a
third party can ship an adapter without copyleft. Everything else in the repo,
including the app packages here, is AGPL-3.0-or-later. Put the SPDX header at the
top of every source file.

## The contract

`App extends Adapter` with three optional seams. From `@sluice/core`
(`packages/core/src/types.ts`):

```ts
interface Adapter {
  id: string;                    // stable, lowercase, matches the package suffix
  displayName: string;
  hosts: string[];               // catalog + the app's flow-replay host allowlist
  matchRequest(input: RequestMatchInput): boolean;   // { host, path, method, url }
  parse(capture: Capture, ctx?: ParseContext): ParseResult;
  listReplayActions(): ReplayAction[];
  buildReplayRequest(action, params, session): ReplayRequest;

  classify?(capture, ctx?): { class: CaptureClass; operation?: string };
  nextCursors?(capture, ctx?): CursorSeed[];
  reconcile?(store: ReconcileStore): ReconcileOutcome;
  listFlowHints?(): FlowHint[];
  extractCredentialHints?(capture: Capture): CredentialHint[];
}

interface App extends Adapter {
  credentials?: CredentialProvider;
  mcpTools?(): AppMcpTool[];
  redaction?: AppRedaction;
}
```

`parse`, `classify` and `nextCursors` **must not throw**. All three run in the
ingest funnel for every capture, and a throw poisons the pipeline.

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

`hosts` is not what makes traffic reach you. Engine A (MITM) decrypts **every**
host by default (`interceptAllHosts` defaults true); `hosts` only seeds the
TLS-intercept list when the operator scopes with `--host`, `interceptHosts`, or
`interceptAllHosts: false`. `hosts` *is* load-bearing for flow replay, which
passes `allowedHosts: app.hosts` into every step build, and for the conformance
check that your `matchRequest` claims each host you declare.

Declare the parent domain and let `matchRequest` handle subdomains — the
intercept list expands each entry to `*.host` on its own, which is why trello and
linkedin declare only `trello.com` / `linkedin.com`.

### parse

Turn one capture into normalized entities. The entity types are fixed:
`Workspace`, `Actor`, `Container` (kind: channel | dm | group | board | project |
thread | other), `Item` (kind: message | page | issue | other), and `Edge`
(a (kind,id) → rel → (kind,id) relationship). Map the service's vocabulary onto
these rather than inventing new shapes — the UI, the MCP tools and the exporters
all read only these.

Return `{}` for anything you don't handle. Guard the JSON:

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

`ParseContext` (the optional second argument) carries `reqParams`, `workspaceId`
and `now`. `reqParams` exists because some responses do not contain the id that
scopes them — Slack's `conversations.history`/`replies` never name the channel —
so recover it from the request with `requestParams(capture)` from
`@sluice/adapter-sdk`. `now` exists so fixture replays are deterministic.

Set `raw` on each entity to the original service payload. It costs nothing and it
is what makes the cartographer able to derive typed columns later. Set
`sourceCaptureIds` on Items so provenance survives.

Export the parse function by name as well as through the app object. Tests import
it directly; see the `sluice-test` skill.

### classify

`classify` names the exchange without parsing it, and fills the traffic table's
Operation column and the `op:` filters. It is also how `sluice record` skips a body
you do not want in a fixture: fast.com marks its `/speedtest/range/<a>-<b>` OCA
downloads as class `binary`, and `record` drops those unless `--include-assets`.
Note that `class` does not gate ingest — every capture is stored regardless. `CaptureClass` is
`structure | messages | auth | error | asset | binary | unknown` — `error` exists
because Slack signals failure as HTTP 200 with `{ ok: false }`.

Omit `classify` and Sluice falls back to the generic `operationName(path)`.

### nextCursors

The pagination story. Every ingested capture is offered to `nextCursors`, and
whatever it returns is *enqueued* into the `cursors` worklist — never executed.
Draining is the explicit `sluice replay --all`, which claims 25 at a time.

```ts
nextCursors(capture) {
  const next = cursorFrom(capture);
  if (!next) return [];                       // [] is the right answer most of the time
  return [{ adapterId: 'loom', actionId: 'loom.videos.library', cursor: next, reason: 'cursor', depth: 1 }];
}
```

Rules the conformance harness enforces: a seed must be addressed to your own
`adapterId`, must name an `actionId` that `listReplayActions()` actually offers,
and must **never** carry an empty-string cursor — an empty cursor re-fetches page
one forever. Enqueue is deduped on (adapter, action, container, cursor), so
emitting the same seed repeatedly is free.

Returning `[]` unconditionally is a legitimate implementation and worth writing
explicitly with the reason: Gmail's returns `[]` because its `bv` pagination
token was never recovered from captures, and a guessed offset would loop on page
one. LinkedIn's is a stub for the same shape of reason.

### reconcile

For identities no single capture can establish. Gmail is the only app that
implements it: Gmail addresses mailboxes by a `/u/N/` path slot, the slot is
reassigned when the signed-in set changes, and only the message-fetch endpoint
names the mailbox — so a thread-list response genuinely cannot say whose mail it
is. The parser emits a provisional workspace id and `reconcile(store)` settles it
from neighbouring captures.

`reconcile` runs opportunistically (after `sluice sync`, at MCP startup) and gets
`ReconcileStore` — listWorkspaces, listCaptures, queryItems, applyParseResult,
deleteWorkspace. It deliberately cannot delete a capture: the evidence must
outlive any reading of it, or a wrong reconciliation cannot be redone. Make it
idempotent.

### redaction — do not skip this

`App.redaction` is how your service's token shapes enter the **global** redactor.
`@sluice/apps` calls `registerAppRedaction(apps)` at import time, before the first
byte is captured, because redaction runs *before* a capture is attributed to an
adapter. That ordering is why the policy is one global union rather than per-app,
and why redaction is deliberately not narrowed by the `adapters` allow-list.

An app that omits `redaction` when its service has a distinctively-shaped token
ships that token **unmasked in every capture body** — the generic policy only
knows `Bearer …`, four exact header names, one credential-shaped header regex,
and a `token=`/`"secret":` field rule that cannot match inside a compound name
like `api_token` or `idToken`.

```ts
const slackRedaction: AppRedaction = {
  patterns: [/xox[abcdeprs]-[A-Za-z0-9%+\/=._-]{8,}/g],   // give these the `g` flag
  headers: ['x-slack-auth', 'x-slack-session'],
};
```

Three fields, all optional:

- `patterns` — value-shaped regexes masked anywhere in any text. This is the
  durable fix: a value pattern catches the secret regardless of what field name
  it is hiding under, which is what closed the `{"api_token":"xoxc-…"}` and
  `{"d":"xoxd-…"}` gaps.
- `headers` — extra header names always masked (Gmail contributes
  `x-framework-xsrf-token`).
- `publicParams` — the inverse: query params that are **public** on your hosts and
  must survive redaction. Fast.com declares
  `{ hosts: ['fast.com','nflxvideo.net'], params: ['token'] }` because its
  speedtest token is served in the page's own JS bundle and the generic `token=`
  rule was making every captured fast.com URL unreplayable.

### listReplayActions + buildReplayRequest

A `ReplayAction` is a parameterizable call the UI, the CLI and the MCP `replay`
tool can re-issue. Conformance requires each `id` to be namespaced with your app
id (`fast.speedtest.config`, `slack.conversations.history`), unique within the
app, and each `urlTemplate` to start with `https://`.

`buildReplayRequest` receives a `Session` and turns the action into a concrete
request. **Read the secrets directly off `session.credentials.values.<key>`.**

```ts
const cookieHeader = session.credentials.values.cookieHeader;
if (cookieHeader) headers.Cookie = cookieHeader;
```

Conformance drives a probe asserting that no injection **key name** ever reaches
the wire — it inspects the built url, headers and body for the literal key
strings. `Cookie: cookieHeader` is exactly what that probe catches.

#### `injection` is a per-adapter contract, not a generic one

`CredentialBundle.injection` looks like a declarative "how to apply this
credential" descriptor, but the semantics differ per adapter:

- **Slack** — `injection.cookies` values are *keys into `values`*
  (`creds.values[ref] ?? ref`); `injection.headers` values are copied literally.
- **Gmail** — both use the name → values-key mapping, with a literal fallback.
- **Trello** — ignores `injection` entirely and reads `values` directly, even
  though it declares `injection: { headers: { Cookie: 'cookieHeader' } }`.
- **LinkedIn** — declares `{ Cookie: 'cookieHeader', 'csrf-token': 'csrfToken' }`
  but, like Trello, its builder never reads `injection` — it takes
  `values.cookieHeader` and `values.csrfToken` directly.

No cross-adapter leak is reachable from this: sessions are adapter-scoped at every
call site. `acquireSession` refuses to hand one app's session to another app's
builder, the WS `replay.run` handler resolves the action first and only then a
session belonging to that action's adapter, and MCP's `pickSession` does the same.
So treat `injection` as documentation of intent and do the real work explicitly in
your own builder rather than assuming a generic consumer honours it.

The cartographer's `buildFlowStepRequest` *is* a generic consumer — it injects
`tokenFormField`, query params, a joined `cookie` header and named headers from
`injection`/`values`. If you want multi-step flow replay to work for your app,
declare `injection` in the shape that helper expects.

## Credentials (optional)

Only if the service needs auth. Everything `extractSessions` returns is SECRET:
`credentials.values` must never be persisted, logged, or streamed — the store
deliberately has nowhere to put it, and only `redactSession()` output (kind names,
no values) crosses those boundaries.

```ts
const trelloCredentials: CredentialProvider = {
  extractSessions: async (): Promise<Session[]> => { /* mint in-memory Sessions */ },
  listWorkspaces:   async () => [ /* passive, secret-free — used by `sluice doctor` */ ],
  sessionFromInput: (input) => { /* paste-in fallback for non-macOS */ },
};
```

Implement `listWorkspaces` even when it feels redundant. It must be passive —
count rows, stat a file, do not decrypt — so it never raises a Keychain prompt.
`sluice doctor` skips any app that lacks it and reports it as "cannot be checked",
so without it a broken credential only surfaces when a tool fails.

**Distinguish "not signed in" from "could not read it."** `app-trello` is the
pattern to copy:

```ts
function isNoSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not signed in|no .*cookie|not found|does not exist|ENOENT/i.test(msg);
}
// …
} catch (err) {
  if (isNoSessionError(err)) return [];      // genuinely absent → surface nothing
  throw new Error(`Trello credential extraction failed: ${…}`);
}
```

A blanket `catch { return []; }` makes a locked cookie DB, a denied Keychain
prompt and a decrypt failure all indistinguishable from being signed out — so the
user is told to sign in when they already are.

**Guard non-darwin by platform, but give it a fallback.** All four credential
providers today (slack, trello, loom, linkedin) return `[]` or throw off macOS.
Implement `sessionFromInput` so paste-in still works, as Slack does.

If you need Chrome cookie decryption, **use `@sluice/core`** — do not paste a
fifth copy. Shared helpers:

- `decryptOscryptV10` / `keychainPassphrase` / `withCopiedSqliteDb` — `packages/core/src/oscrypt.ts`
- `readChromeCookieHeader` / `locateChromeProfile` — `packages/core/src/chrome-cookies.ts`

App packages keep thin domain wrappers (`domainSuffix: 'example.com'`) plus any
service-specific header post-processing. Slack desktop still owns LevelDB + host
ranking in `slack-credentials.ts` but decrypts through the same OSCrypt helpers.

## MCP tools (optional)

Add `mcpTools()` if the app should expose data or an action to Claude. The full
contract is in the **`sluice-mcp-tool`** skill. Two things worth knowing before
you get there: app tools *can* declare an `inputSchema` (a zod raw shape), and a
network-touching tool must go through `ctx.replay` rather than a bare `fetch` so
it inherits the faithful fingerprint, the safety rails, the shared budget and the
store write-back.

## Registration — the two files outside your package

Both are in `packages/apps`.

1. `packages/apps/src/index.ts` — import and append to the array. This is the one
   place that names concrete app packages.

   ```ts
   import { notionApp } from '@sluice/app-notion';
   export const apps: App[] = [slackApp, fastApp, trelloApp, gmailApp, loomApp, linkedinApp, notionApp];
   ```

   Append, never prepend. Registration order decides which adapter is offered a
   capture first, and `apps[0]` (Slack) is documented as the default: it is the
   landing app for `sluice capture`, the app named in `sluice start`'s banner, and
   the first app MCP `replay` searches for an action id.

2. `packages/apps/package.json` — add `"@sluice/app-notion": "workspace:*"` to
   `dependencies`, then `pnpm install`. Without it the import resolves in dev and
   breaks on a clean install.

You do **not** need to edit `PLANNED_APPS` in `packages/runner/src/server.ts`. It
is a list of four unbuilt placeholders (notion, linear, jira, discord) the app
catalog advertises, and the catalog already filters out any id that a registered
adapter claims — search for `PLANNED_APPS` if you want to read it, but registering
your app is enough to make the stub disappear.

## Before you call it done

- `pnpm install` (workspace link), then `pnpm typecheck` — it runs every package.
- **`pnpm --filter @sluice/apps test`** — the registry test runs
  `for (const app of apps) runConformance(app)` under the comment "Adding an
  adapter to the registry above without satisfying these fails the build." That
  is 11 invariants driven over 10 hostile paths and 14 hostile bodies (including
  `/api/__proto__`, truncated JSON, JSON scalars, prototype keys) *and* over your
  own endpoint paths: host-claim coverage, lookalike-host rejection, parse never
  throwing, entity ownership, uniquely-namespaced replay actions, seed addressing,
  and secrets-by-value-not-key-name. Pass `{ session }` to `runConformance` in
  your own suite or the two replay checks silently skip.
- The repo's tsconfig is strict with `verbatimModuleSyntax` and
  `noUncheckedIndexedAccess`: use `import type` for type-only imports, end every
  relative import with `.js`, and treat indexed access as possibly-undefined.
- **`pnpm sluice adapters`** — the fastest smoke test. It prints, per app, the
  hosts, the credential source (`local-store (probeable)` / `local-store` / `none`),
  the replay action count and the MCP tool names. If your app is missing or its
  row is empty, registration or a seam is wrong.
- `pnpm sluice doctor` should list your app's sign-in line (that is `listWorkspaces`).
- Capture something real, then `pnpm sluice build-db` and confirm `<id>_*` tables
  appear — that proves matchRequest → parse → materialize end to end.
  **This check does not apply to GraphQL services.** `materialize()` mines only
  **top-level** response arrays: it walks `Object.keys(body)` and takes any value
  that is a non-empty array of plain objects. A GraphQL response nests its
  collections under `data.*` (`data.getLooms.videos.edges`), so the only top-level
  key is `data`, which is an object — Loom and LinkedIn therefore produce **no**
  per-app tables at all, and that is expected, not a broken adapter. Verify a
  GraphQL app through `sluice adapters` stats, the dashboard entity counts, or a
  parse test instead.
- Add tests for `parse` at minimum; see the `sluice-test` skill.
- Consider documenting the service's endpoints first — see the `sluice-api-doc`
  skill. Writing the adapter is much easier when you already know what the client
  actually calls.

## Optional flow hints

Adapters may implement `listFlowHints()` returning
`{ primaryKey, label?, companions[] }` sketches when capture clustering is weak.
Slack is the only app that does, declaring hints for `conversations.history` and
`conversations.replies`. Data-learned templates from `learnFlowTemplates` always
win at replay — hints are documentation for agents and the UI, not a second
fingerprint path. Never hardcode frozen Chrome UAs in flow builders; use the
cartographer's `buildFlowStepRequest`.
