# Contributing to Sluice

Thanks for looking. Sluice is a local-only tool that reads a credential
equivalent to a live logged-in session, so the bar for changes that touch
capture, redaction, or replay is deliberately higher than for a typical app.
Read [`SECURITY.md`](./SECURITY.md) before changing anything in those areas.

## Setup

```bash
pnpm install          # builds better-sqlite3 / classic-level from source
pnpm sluice doctor    # checks the environment; reads no secrets
```

Node 20+, pnpm 10 (the version is pinned in `package.json`'s `packageManager`).
macOS is the primary target; see "Platform support" below.

## The loop

```bash
pnpm lint             # Biome, lint-only (formatter + import sort deliberately off)
pnpm typecheck        # tsc --noEmit across every package
pnpm test             # node:test via tsx, across every package
pnpm webapp:build     # the dashboard the runner serves
```

CI runs all four on every push and PR. Note that `pnpm doctor` is **pnpm's own**
builtin — the project's check is `pnpm sluice doctor`.

## Repo shape

The spine is `core → interceptor → cartographer → runner/mcp → webapp`. Per-service
knowledge lives in `packages/app-*` and is wired in through the one registry at
`packages/apps/src/index.ts`. Nothing upstream of that file may import a specific
app package — that seam is the whole architecture.

```
packages/core          types · store · WS protocol · redactor      (Apache-2.0)
packages/interceptor   MITM + CDP engines · replay + flow-replay · rails (AGPL)
packages/cartographer  API map · per-app tables · faithful + flow templates (AGPL)
packages/apps          the installed-apps registry                  (AGPL)
packages/app-*         one service each                             (AGPL)
packages/runner        the `sluice` CLI, HTTP/WS server, HTTP API    (AGPL)
packages/mcp           the `sluice-mcp` stdio MCP server            (AGPL)
apps/webapp            the React dashboard                          (AGPL)
```

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

**Replay is read-only.** `runReplay` enforces method, operation-denylist and rate
limits in `packages/interceptor/src/replay-policy.ts`. Those checks sit below every
caller on purpose. Do not add a network path that bypasses them.

**Single vs flow replay.** One request goes through `faithfulReplayRequest` →
`runReplay` (CLI `sluice replay <actionId>`, MCP `sluice_replay`). A multi-step
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
plus two lines in `packages/apps/src/index.ts`. `packages/app-fast` is the
smallest complete example (credential-free); `packages/app-trello` is the
smallest one *with* credentials.

Three things that are easy to get wrong:

- **`parse` must never throw** — it runs in the ingest path for every capture.
  Return `{}` for anything you don't handle, and guard the `JSON.parse`.
- **Read credentials from `session.credentials.values.<key>`**, not from
  `injection`. That field's meaning is not consistent across the existing
  adapters, so treat it as documentation of intent and do the work explicitly.
- **Implement `listWorkspaces`** (passive, no Keychain prompt) or `sluice doctor`
  cannot verify your app, and a broken credential stays invisible until a tool
  fails.

Run `pnpm sluice adapters` to see what's registered, and `pnpm sluice capture`
followed by `pnpm sluice build-db` to prove `matchRequest → parse → materialize`
works end to end.

## Tests

`node --import tsx --test src/*.test.ts` per package — no vitest, no config file.
Use a real in-memory `SqliteStore` rather than a mock; the SQL is where the bugs
are. A local `capture()` fixture helper with a **fixed** timestamp keeps ordering
deterministic. Guard macOS-only tests with `{ skip: process.platform !== 'darwin' }`
so CI stays green on Linux.

9 of 11 packages have suites (95 tests), including the runner's loopback auth
boundary, the MCP tool registration, the redactor and the replay rails.

Still uncovered and worth contributing:
- the **cookie/Keychain decryptors** (`app-slack/src/slack-credentials.ts`,
  `app-trello/src/chrome-cookies.ts`) — testable with a fixture Cookies SQLite and
  an injected passphrase, no Keychain needed;
- the **capture engines** — realistically these need a mock runner (scrubbed
  NDJSON replay) that does not exist yet;
- the **React components** (`analytics.ts` is pure and covered; the rest would need
  a browser test runner, which the repo deliberately does not have yet).

## Platform support

Credential extraction is macOS-only today (Keychain + the macOS OSCrypt v10
scheme). Windows (DPAPI + AES-256-GCM) and Linux (libsecret/kwallet) are wanted;
the credential-provider seam already exists, but `slack-credentials.ts` and
`chrome-cookies.ts` currently duplicate the same crypto — de-duplicate that into a
shared per-platform module first, or the two copies will diverge.

Everywhere else, non-macOS users fall back to `--token`/`--cookie` paste-in.

## Publishing the SDK packages

`@sluice/core` and `@sluice/adapter-sdk` are the two packages a third-party
adapter depends on, so they ship to npm (Apache-2.0). They resolve to `src/` in
the workspace for dev, and to a built `dist/` when published — the swap is a
`publishConfig` override, so nothing about local development changes.

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

Split on purpose: `packages/core` is **Apache-2.0** so anyone can build adapters
against the data model, everything else is **AGPL-3.0-or-later**. Every source
file carries an SPDX header — keep it when you add a file, and match the package
it lives in. See [`LICENSING.md`](./LICENSING.md).
