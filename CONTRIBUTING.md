# Contributing to Sluice

Thanks for looking. Sluice is a local-only tool that reads a credential
equivalent to a live logged-in session, so the bar for changes that touch
capture, redaction, or replay is deliberately higher than for a typical app.
Read [`SECURITY.md`](./SECURITY.md) before changing anything in those areas.

## Setup

```bash
pnpm install          # builds better-sqlite3 / classic-level / node-pty / esbuild from source
pnpm sluice doctor    # checks the environment; reads no secrets
```

Those four are the whole of `pnpm.onlyBuiltDependencies` — no other package is
allowed to run an install script. `node-pty` is the native dependency behind
`sluice serve --terminal`; if it fails to build, everything except the embedded
terminal still works.

Node 20+, pnpm 10 (the version is pinned in `package.json`'s `packageManager`).
macOS is the primary target; see "Platform support" below.

## The loop

```bash
pnpm lint             # Biome, lint-only (formatter + import sort deliberately off)
pnpm typecheck        # tsc --noEmit, per package that declares the script
pnpm test             # node:test via tsx, per package that declares the script
pnpm webapp:build     # the dashboard the runner serves
pnpm build            # webapp:build + scripts/build.mjs — the shipping bundles
```

`typecheck` and `test` are `pnpm -r --if-present`, so a package with no `scripts`
block is silently skipped: today that is `packages/cli` and `packages/extension`,
which are neither typechecked nor tested by either command.

CI runs lint → typecheck → test → build, on pull requests from any branch and on
pushes to `main` only — a push to a feature branch runs nothing until you open a
PR. Note that `pnpm doctor` is **pnpm's own** builtin; the project's check is
`pnpm sluice doctor`.

### `pnpm build`

`pnpm build` is `pnpm webapp:build && node scripts/build.mjs`. It produces the
three shipping bundles and the dashboard the runner serves:

```
packages/runner/dist/cli.js           # the `sluice` binary
packages/runner/dist/engine-child.js  # the `serve --isolated` capture process
packages/runner/dist/chunks/*.js      # code-split chunks shared by the two above
packages/runner/dist/webapp/          # copy of apps/webapp/dist
packages/mcp/dist/cli.js              # the `sluice-mcp` binary
```

Three constraints in `scripts/build.mjs` are not obvious and are easy to undo:

- **mockttp is deliberately bundled, not external.** Its CJS build `require()`s
  ESM-only `get-port`, so an unbundled `import('mockttp')` throws
  `ERR_REQUIRE_ESM`. Bundling resolves the require-of-ESM at build time.
  `splitting: true` then keeps that ~12 MB inlined copy in its own lazily-loaded
  chunk, so every command other than `start` parses a ~395 KB entry plus a
  ~120 KB shared chunk instead of the 12 MB. The MCP
  target adds `mockttp` to *its* externals because the MCP server never starts a
  capture engine and must not carry the 12 MB.
- **Native addons stay external:** `better-sqlite3`, `classic-level` and
  `node-pty` break their `.node`/spawn-helper lookup if the JS wrapper is
  bundled. `chrome-remote-interface`, `ws`, `zod` and the MCP SDK are external
  too, as ordinary runtime deps of the published packages.
- **The shebang is rewritten by hand.** esbuild carries the source `#!` in
  *after* the banner, which is a syntax error, so every `#!` line is stripped and
  exactly one `#!/usr/bin/env node` is written back at line 1 before `chmod 755`.

CI's build step does not execute what it built, so run the output yourself
(`node packages/runner/dist/cli.js --help`) when you touch the build script.

## Repo shape

The spine is `core → interceptor → cartographer → runner/mcp → protocol → webapp`.
Per-service knowledge lives in `packages/app-*` and is wired in through the one
registry at `packages/apps/src/index.ts`. Nothing upstream of that file may import
a specific app package — that seam is the whole architecture.

The licence column below is the **effective** licence: the root `LICENSE` is
AGPL-3.0-or-later and most `package.json` files declare nothing, so they inherit
it. Only `core`, `adapter-sdk` and `protocol` declare Apache-2.0.

```
packages/core          types · store · WS protocol · redactor       (Apache-2.0)
packages/adapter-sdk   coerce · fixtures · scrubber · conformance   (Apache-2.0)
packages/protocol      zod validation of client WS frames           (Apache-2.0)
packages/interceptor   MITM + CDP engines · replay + flow-replay · rails  (AGPL)
packages/cartographer  API map · per-app tables · faithful + flow templates (AGPL)
packages/apps          the installed-apps registry                       (AGPL)
packages/app-*         one service each: slack fast trello gmail loom linkedin (AGPL)
packages/runner        the `sluice` CLI, HTTP/WS server, HTTP API        (AGPL)
packages/mcp           the `sluice-mcp` stdio MCP server                 (AGPL)
packages/extension     the MV3 browser capture engine (POSTs /api/ingest) (AGPL)
packages/cli           the `sluicejs` bare-name launcher                 (AGPL)
apps/webapp            the React dashboard                               (AGPL)
```

`packages/protocol` is separate from `core` for one reason: zod is a runtime
*value* and `core` pulls in better-sqlite3 and `node:fs`, so a zod schema living
in `core` would drag a native module into the browser bundle. The webapp imports
`core` with `import type` only.

`packages/cli` and `packages/extension` have no `scripts` block, so `pnpm
typecheck` and `pnpm test` skip both; `packages/extension` has no `src/*.ts`, so
Biome does not see it either.

## Rules that matter

**Secrets.** `credentials.values` is secret. It must never reach SQLite, a log,
the WebSocket, or an MCP response. Only `redactSession()` output crosses those
boundaries, and the store deliberately has nowhere to put a credential. If you
add a sink for capture data, run it through `redactHeaders`/`redactText`/`redactUrl`
first.

**Redaction is a shared policy.** Generic rules live in `packages/core/src/redact.ts`;
service-specific token shapes belong in that app's `redaction` field, which
`@sluice/apps` registers at import time. Add a test in `redact.test.ts` for any
new shape — it is the one file where a regression is a credential leak.

**Replay is read-only.** `runReplay` enforces the GET/HEAD/POST method allowlist
and the 60-request/60s token budget in `packages/interceptor/src/replay-policy.ts`.
The write/admin **operation denylist** is not there: it lives in
`packages/core/src/replay-deny.ts` (`REPLAY_DENIED_OPERATION_PATTERNS`,
`looksLikeDeniedOperation`) because flow *learning* (`flow-learn.ts`) and flow
*building* (`flow-build.ts`) apply the same list — change it in one place and all
three rails move together. Those checks sit below every caller on purpose. Do not
add a network path that bypasses them.

**Single vs flow replay.** One request goes through `faithfulReplayRequest` →
`runReplay` (CLI `sluice replay <actionId>`, MCP `replay` — the single-request
tool is deliberately *not* `sluice_`-prefixed; only the three flow tools are). A multi-step
**interaction flow** is learned from observed/pinned bursts (`sluice learn-flows`),
built per step with `buildFlowStepRequest` (pass `allowedHosts: app.hosts`), and
executed by `runFlowReplay` (CLI `sluice replay --flow`, MCP `sluice_replay_flow`).
Each step still pays the same rails and budget. Templates never train on prior
replay traffic.

Flow details agents must know (also in MCP tool descriptions and
`packages/mcp/README.md`):

- **Cluster then learn** offline (`learn-flows`); MCP only reads/replays.
- **Pacing** uses `offsetFromPrimaryMsP50` (primary-anchored sibling timing), not
  only chained delays — so skipping a soft companion does not desync the rest.
- **Assets / SPA bundles** must not seed primaries and are omitted as soft
  template steps; prefer API `primaryKey`s with `sampleCount ≥ 2`.
- **Correlation** (`loaderId` / `pageLoadId`) exists when CDP captured; MITM is
  time-window only. WS frames are not HTTP flow members.
- **F4.4**: build refuses denied methods/ops and hosts outside the adapter list;
  `FlowBuildError` surfaces as replay `denied`.

**Schema changes are additive.** `CREATE TABLE IF NOT EXISTS` does nothing to an
existing database, so a new column goes in **both** `SCHEMA_SQL` (for new stores)
and `ADDITIVE_COLUMNS` (for existing ones). Indexes on new columns go in
`ADDITIVE_INDEXES`, which runs after the `ALTER`s — putting one in `SCHEMA_SQL`
breaks startup for everyone who already has data. There is a test for this.

**Don't swallow errors.** A bare `catch {}` in the capture path has already cost
this project two invisible failure modes. Log it, surface a `notice` frame, or
let it throw.

## Adding support for a new service

One package implementing the `App` interface from `packages/core/src/types.ts`,
plus **three** registration edits:

1. the workspace dependency in `packages/apps/package.json`;
2. the `import { yourApp } from '@sluice/app-yours'` in `packages/apps/src/index.ts`;
3. the entry in that file's `apps` array — which is also the registration order,
   and `apps[0]` (Slack today) is what `sluice capture` and `sluice start` treat
   as the default.

There are six installed apps: slack, fast, trello, gmail, loom, linkedin.
Do **not** touch `PLANNED_APPS` in the runner — that list (notion, linear, jira,
discord) is dashboard placeholders only, and it self-filters out any id that a
registered adapter already claims.

`packages/app-fast` is the smallest complete example (credential-free);
`packages/app-trello` is the smallest one *with* credentials.

Four things that are easy to get wrong:

- **`parse` must never throw** — it runs in the ingest path for every capture.
  Same for `classify` and `nextCursors`. Return `{}` for anything you don't
  handle, and guard the `JSON.parse`.
- **`injection` is a NAME → KEY map, and it is load-bearing.** Every entry maps a
  wire name — a cookie name, a header name, a form field — to the *key in
  `credentials.values`* that holds the secret, never to the secret itself. Slack
  maps cookie names to value keys; Trello and Loom use
  `injection: { headers: { Cookie: 'cookieHeader' } }`. Resolve through it:
  `buildFlowStepRequest` (`packages/cartographer/src/flow-build.ts`) injects
  credentials for every learned flow step by reading exactly these semantics, and
  conformance fails an adapter that lets an injection *key name* reach the URL,
  headers or body of a built request.
- **Implement `listWorkspaces`** (passive, no Keychain prompt) or `sluice doctor`
  cannot verify your app, and a broken credential stays invisible until a tool
  fails.
- **`sessionFromInput` is what makes your app usable off macOS.** It is optional,
  the runner calls it as `provider.sessionFromInput?.(...)`, and today only Slack
  implements it — see "Platform support" below.

**Your app is conformance-tested the moment you register it.**
`packages/apps/src/registry.test.ts` runs `runConformance(app)` from
`@sluice/adapter-sdk` over every entry in the `apps` array: 11 invariants driven
with 10 hostile paths (`/api/__proto__`, `/api/%2e%2e%2f`, a 300-char segment, …)
and 14 hostile bodies (truncated JSON, HTML, scalars, prototype keys, …), plus
your own endpoint paths derived from your `listReplayActions()` URL templates. It
asserts, among other things, that `matchRequest` claims your hosts and rejects
lookalikes (`yourhost.evil.test`), that every entity you emit is owned by your
adapter, that replay action ids are unique and namespaced `<app.id>.`, and that
`buildReplayRequest` resolves secrets **by value, never by key name**.
`packages/apps/src/discover.test.ts` additionally asserts every app clears
`checkConformance` — the throw-free subset that runs at load time and is the gate
external, third-party adapters must pass before `installExternalAdapters()` will
register them. `checkConformance` is documented as *not* a security boundary: it
proves an adapter is not broken, not that it is trustworthy.

Build against `@sluice/adapter-sdk` rather than hand-rolling: it ships the total
`coerce` helpers (`str`, `num`, `bool`, `arr`, `obj`, `safeJson`, `compact`),
`requestParam`/`requestParams`, the `makeCapture`/`makeJsonCapture` fixture
factory (fixed ts `1_700_000_000_000`, sequential `cap_<n>` ids — this is the
"fixed-timestamp `capture()` helper" the Tests section is describing), and
`scrubCaptures`, the deterministic scrubber that turns a real `sluice record`
NDJSON into a shareable fixture by preserving shape and replacing content.

Run `pnpm sluice adapters` to see what's registered (it loads external adapters
too, so a rejection is diagnosable without starting a capture), and `pnpm sluice
capture` followed by `pnpm sluice build-db` to prove
`matchRequest → parse → materialize` works end to end.

## Config, and the split that will trip you up

`packages/runner/src/config.ts` defines `SluiceConfig` — 10 optional keys: `db`,
`port`, `proxyPort`, `cdpPort`, `adapters`, `retentionDays`, `maxCaptures`,
`maxBodyBytes` (reserved, not threaded through), `interceptHosts`,
`interceptAllHosts`. Precedence is CLI flag → config file → built-in default. The
file is found by: an explicit `--config` path (throws if missing), else the
nearest `sluice.config.json` then `.sluicerc.json` walking up from the CWD, else
`~/.sluice/config.json`. A malformed or non-object config file is a **hard
error**, not a silent fall back to defaults. Only JSON is supported; a `.ts`
config is rejected by design, since it would need a runtime transpiler.

The trap: **the `adapters` allow-list is read only from `~/.sluice/config.json`.**
`selectApps` accepts a `configPath` argument for call-site compatibility and
deliberately ignores it, so a repo-local `sluice.config.json` cannot change which
apps are enabled no matter what it declares, and `sluice app enable/disable`
writes to the home config every time.

The other trap: `interceptAllHosts` **defaults to true**. With no config and no
flags, the MITM engine decrypts every host routed through the proxy — not only
adapter hosts. Scope it with `--host` (repeatable), `interceptHosts`, or
`interceptAllHosts: false`.

## Tests

`node --import tsx --test src/*.test.ts` per package — no vitest, no config file.
Use a real in-memory `SqliteStore` rather than a mock; the SQL is where the bugs
are. Build capture fixtures with `makeCapture`/`makeJsonCapture` from
`@sluice/adapter-sdk` — their **fixed** timestamp and sequential ids keep ordering
deterministic. Guard macOS-only tests with `{ skip: process.platform !== 'darwin' }`
so CI stays green on Linux.

Most packages under `packages/*` and `apps/webapp` declare a `test` script; root
`pnpm test` runs them via `pnpm -r --if-present test` (node:test + tsx). That is
~770 tests across 46 `src/*.test.ts` files in 15 packages, covering the runner's
loopback auth boundary, the MCP tool registration, the redactor, the replay rails
and the adapter conformance suite. Note the glob is `src/*.test.ts` — top level of
`src/` only, not recursive.

Still uncovered and worth contributing:
- the **cookie/Keychain decryptors** — crypto lives in `@sluice/core`
  (`oscrypt.ts`, `chrome-cookies.ts`); app packages are thin domain wrappers.
  Testable with a fixture Cookies SQLite and an injected passphrase, no Keychain
  needed (`decryptOscryptV10` is pure);
- the **capture engines** — use `sluice record` + `sluice mock` for scrubbed
  NDJSON fixture replay through the real ingest path (`scrubCaptures` from
  `@sluice/adapter-sdk` is the sanctioned way to make a real recording
  shareable);
- the **React components**. The webapp's pure modules are covered — `analytics`,
  `filter`, `router`, `flow-ui`, `operations`, `replay`, `explore`, seven test
  files — but the `.tsx` components themselves would need a browser test runner,
  which the repo deliberately does not have yet.
- `packages/runner/src/api.ts`, `proxy.ts` and `engine-child.ts` have no test
  file, and `packages/cli` / `packages/extension` are skipped by `pnpm test`
  entirely.

## Platform support

Credential extraction is macOS-only today (Keychain + the macOS OSCrypt v10
scheme). The AES-128-CBC / PBKDF2-SHA1 (`saltysalt`, 1003 iterations, 16 bytes)
decrypt and Chrome profile reader live once in `@sluice/core`:

```
packages/core/src/oscrypt.ts          # decryptOscryptV10, keychainPassphrase, withCopiedSqliteDb
packages/core/src/chrome-cookies.ts   # readChromeCookieHeader / locateChromeProfile
```

App packages keep only domain wrappers (`app-trello` / `app-loom` /
`app-linkedin` `chrome-cookies.ts`) and Slack's LevelDB + host-ranking path
(`app-slack/src/slack-credentials.ts`). Callers still zero the passphrase
`Buffer` after use. Windows (DPAPI + AES-256-GCM) and Linux (libsecret/kwallet)
belong next to those core modules — not as a fifth paste in an app package.

Non-macOS users can paste credentials in only where the app implements
`sessionFromInput`, and today that is **Slack alone** (`--token` / `--cookie`).
Trello, Loom and LinkedIn have no non-macOS path at all — on Linux and Windows
they cannot authenticate by any means. Gmail and Fast need no credentials.

## Publishing the SDK packages

**Nothing is published to npm yet.** `npx sluicejs` does not work today; the five
packages that *could* publish (`sluicejs`, `@sluice/runner`, `@sluice/mcp`,
`@sluice/core`, `@sluice/adapter-sdk`) have never been released. What follows is
the process for when they are.

`@sluice/core` and `@sluice/adapter-sdk` are the two packages a third-party
adapter depends on, so they are the ones to ship first (Apache-2.0). They resolve
to `src/` in the workspace for dev, and to a built `dist/` when published — the
swap is a `publishConfig` override, so nothing about local development changes.
Their `dist/` is built by `prepack` (`tsc -p tsconfig.build.json`), *not* by root
`pnpm build`.

`dist/` is gitignored and built on demand (`prepack`), so publishing is:

```sh
# 1. bump the version in BOTH package.json files (keep them in lockstep)
# 2. publish core first — adapter-sdk depends on it
pnpm --filter @sluice/core publish        # prepack builds dist/ + types
pnpm --filter @sluice/adapter-sdk publish  # workspace:^ is rewritten to ^<version>
```

`pnpm pack` (no publish) writes a `.tgz` you can inspect first — verify it
contains `dist/` and that the packed `package.json` points `exports`/`types` at
`dist`. Publishing to npm is public and a version is permanent, so it needs your
npm auth and is a deliberate, manual step.

## Licensing

Split on purpose: `packages/core`, `packages/adapter-sdk` and `packages/protocol`
are **Apache-2.0** so anyone can build adapters against the data model and the
wire format; everything else is **AGPL-3.0-or-later**. Most `package.json` files
declare no `license` field at all and inherit the root `LICENSE` — only `core`,
`adapter-sdk` and `protocol` (Apache-2.0) and `runner`, `mcp`, `cli`, `extension`
and `app-gmail` (AGPL) say so explicitly.

Every source file *should* carry an SPDX header matching the package it lives in;
keep it when you add a file. All 161 `.ts`/`.tsx` files under `packages/` and
`apps/` currently do — but nothing enforces it, since Biome declares no such rule
and the build script does not check. See [`LICENSING.md`](./LICENSING.md).
