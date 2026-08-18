---
name: sluice-test
description: Add or extend a test suite for a Sluice package using the repo's node:test + tsx pattern with in-memory SqliteStore fixtures and the @sluice/adapter-sdk harnesses. Use this whenever the user wants tests for anything under packages/* or apps/webapp — "add tests for the store", "test the redactor", "cover the MCP handlers", "write a test for this adapter", "why is there no test for X" — or when working through the untested-modules backlog. Also use when a package needs its test script wired up, since most packages under `packages/*` and `apps/webapp` declare a `test` script; root `pnpm test` runs `pnpm -r --if-present test`.
---

# Testing in Sluice

The repo uses Node's built-in test runner through tsx — no vitest, no jest, no
config file. There are 46 `src/*.test.ts` files across 15 packages (773
tests, 15 skipped — all but one are conformance probes that skip on every
platform for a missing `session` or an absent optional hook), so most of what you write here is
*additional* coverage rather than a module's first. Bias toward the boundaries
that would leak credentials or corrupt data if they broke.

The real gaps worth filling:

- `packages/runner` has suites for cli, config, server, engine-controller,
  child-engine and claude-terminal — but **none** for `api.ts` (the whole
  read-only HTTP surface), `proxy.ts`, or `engine-child.ts`.
- `packages/cli` and `packages/extension` declare **no `test` script at all**.
  The extension is plain JS with no build; the CLI package is a bin wrapper.

## The pattern

Tests live next to the code as `src/*.test.ts`. Add the script to the package's
`package.json`:

```json
"scripts": {
  "typecheck": "tsc --noEmit",
  "test": "node --import tsx --test src/*.test.ts"
}
```

Run one package from its directory with `pnpm test`, or everything from the root
with `pnpm test` (`pnpm -r --if-present test`). CI runs the root script as a
required step, so a package with a `test` script that fails blocks the build.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeJsonCapture } from '@sluice/adapter-sdk';
import { parseFastCapture } from './index.js';

test('parses a config response into one container per CDN target', () => {
  const cap = makeJsonCapture('api.fast.com', '/netflix/speedtest/v2', { targets: [/* … */] });
  assert.equal(parseFastCapture(cap).containers?.length, 3);
});
```

Use `node:assert/strict` and end relative imports with `.js` — the repo compiles
with `verbatimModuleSyntax` and `moduleResolution: Bundler`, so a missing
extension or a value-import of a type will fail typecheck even when the test passes.

## Fixtures: use the SDK factory, not a local helper

`Capture` has 14 required fields. Do **not** re-declare a local `capture()`
helper — four packages each grew a byte-similar private copy, they drifted in
what they defaulted, and a new required field had to be added in four places.
`@sluice/adapter-sdk` now ships the shared factory:

```ts
import { makeCapture, makeJsonCapture, resetCaptureIds } from '@sluice/adapter-sdk';

makeCapture({ status: 401 });                            // sane defaults, overrides last
makeJsonCapture('slack.com', '/api/conversations.list', { ok: true, channels: [] });
```

`makeCapture` defaults to `source: 'mitm'`, `adapterId: null`, POST
`https://example.com/api/test`, status 200, `ts: 1_700_000_000_000`, JSON
content-type headers and null bodies. `makeJsonCapture(host, path, body, over)`
derives the url from host+path so a test cannot accidentally disagree with itself
about which endpoint it is describing. Ids are sequential (`cap_1`, `cap_2`) so a
failing assertion names the same capture on a re-run — call `resetCaptureIds()`
in a `beforeEach` when the ids are load-bearing.

Keep the **fixed** `ts`. Several code paths derive ordering, table names and
api-map output from timestamps, and a moving clock turns a real regression into
an intermittent one.

Add `"@sluice/adapter-sdk": "workspace:*"` to the package's `devDependencies`.

## Adapter tests start from the SDK harness

Two ready-made gates ship in `@sluice/adapter-sdk`. Run them before writing a
single service-specific assertion.

**`runConformance(app, { session?, fixtures? })`** registers 11 node:test cases
and drives them over 10 hostile paths (`/api/__proto__`, `/api/constructor`,
`/1/__proto__/cards`, a 300-char segment, `/api/%2e%2e%2f`, …) and 14 hostile
bodies (null, empty, truncated JSON, HTML, a JSON scalar, object-of-nulls,
prototype keys, …) — *and* over the adapter's own endpoint paths, derived from
each `listReplayActions()` urlTemplate, because a generic path is rejected on line
one of any real parser. It checks the declaration shape, host claims, lookalike
rejection, parse/classify/nextCursors never throwing, entity ownership, replay
action namespacing, and that `buildReplayRequest` resolves secrets by value and
never leaks an injection key name into the url, headers or body.

`packages/apps/src/registry.test.ts` already runs it over every registered app —
"Adding an adapter to the registry above without satisfying these fails the
build." Your per-app suite should run it too, with a **`session`**: omit it and
the two `buildReplayRequest` secret checks silently skip.

```ts
runConformance(myApp, { session: fakeSession, fixtures: [makeJsonCapture(/* … */)] });
```

`conformance.ts` statically imports `node:test`, so only ever import
`runConformance` from a test file.

**`checkConformance(app)`** is the throw-free load-time subset: it returns one
string per problem (empty means pass), never throws, stops after 12 problems, and
is what `discoverAdapters` uses as the gate for third-party adapters. It is
documented as *not* a security boundary — it proves an adapter is not broken, not
that it is trustworthy. Test external-adapter loading against it, not against
`runConformance`.

For burst-shaped and ingest tests there is a fixture loop: **`scrubCaptures`**
turns a real recording into a committable fixture (preserving array lengths,
nesting, keys, types, string lengths and relative timestamp order while replacing
every character — deterministically, from a salted hash, so re-scrubbing is
byte-identical), and **`runMockCaptures(captures, sink, opts)`** replays NDJSON
through the *same* ingest sink the live engines use, with no credentials
anywhere. `parseNdjson` skips malformed lines by line number rather than losing
the whole fixture.

## Use a real store, in memory

Don't mock `SqliteStore` — it's better-sqlite3, `new SqliteStore(':memory:')` is
fast, and it exercises the actual SQL, which is where the bugs are. Seed it with
`insertCapture` and assert on what comes back out. That is why the cartographer
and store suites catch schema problems a mock would hide.

Prefer asserting on observable results (rows returned, entities produced, headers
emitted) over internal call sequences. The point is to survive refactors of the
implementation, not to pin it in place.

## What's worth testing, by layer

Ordered by what breaks worst if it regresses:

**`packages/core/src/redact.ts`** — the single sink guarding every write. Assert
both directions: that credential shapes are masked, and that non-secrets survive.

Redaction runs **before** attribution, and `@sluice/apps` calls
`registerAppRedaction(apps)` at import time, so an app-registered value pattern
applies to all traffic regardless of which host it came from. That closed two
gaps that used to be live: `{"api_token":"xoxc-…"}` and `{"d":"xoxd-…"}` are now
masked by Slack's `/xox[abcdeprs]-…/g` pattern even though the field names are
ones `SECRET_FIELD` cannot match. Write those as **passing regression tests** —
they are exactly the cases that would silently reopen if the import-time
registration moved.

The one gap still live: an opaque JWT under a compound field name, e.g.
`"idToken":"eyJ…"`. `SECRET_FIELD`'s `\b(?:…|token|…)\b` cannot match inside
`idToken` (no word boundary between `id` and `token`), and there is no generic
JWT *value* pattern. Encode it as a failing test if you are fixing it. The
durable fix is a value-shaped pattern, not another field name.

Also assert the inverse rule: `redactUrl` keeps a declared `publicParams` query
param verbatim on its hosts (fast.com's `token`) — over-masking there made every
captured fast.com URL unreplayable.

**`packages/core/src/store.ts`** — round-trip each entity type; cover the
malformed-row case (row mappers call `JSON.parse` on `raw`); and cover the
schema-adjacent invariants that have bitten before: an empty `ids: []` filter
must match nothing rather than everything, `deleteCaptures({})` must throw,
FTS rows must survive an upsert (`ON CONFLICT`, never `INSERT OR REPLACE`, or the
rowid changes and orphans the index), and bodies above 2048 chars round-trip
through gzip.

**`packages/runner/src/server.ts`** — the loopback auth boundary, and the three
independent secrets it mints: the read token (gates `/ws` and every GET `/api/*`),
a pty token minted only with `--terminal`, an ingest token minted only with
`--ingest`. Assert that the read token cannot open `/pty`, that a bad Origin and
a wrong token are both refused, and that the static handler's path-traversal
guard holds. These need a real server on an ephemeral port — start it, hit it,
close it in a `finally`.

**`packages/runner/src/api.ts`** — untested today. It is GET-only (405 on
anything else), caps paging at 1000, accepts at most 500 comma-separated ids, and
interpolates a table name into SQL only after an exact match against materialized
tables read live from `sqlite_master`. That last one is worth a test.

**Adapters (`packages/app-*`)** — `runConformance` first, then `parse` against
scrubbed fixtures, `matchRequest` on both hit and miss (including a lookalike
host), and `buildReplayRequest` asserting the credential lands in the right place
by value.

**`packages/mcp/src/server.ts`** — drive the tool handlers against a seeded store
and assert on returned payloads, including the error path. The existing suite
also pins two structural properties worth keeping: every app tool name starts
with `${app.id}_`, and `ctx.store` exposes none of `db` / `insertCapture` /
`applyParseResult` / `upsertItem` / `upsertSession` / `listSessions` /
`pruneCaptures` / `close`.

**Credential decryption (`@sluice/core` `oscrypt.ts` / `chrome-cookies.ts`)** —
`decryptOscryptV10` is pure and covered by fixture encrypt/decrypt tests. Full
profile readers are testable without a Keychain by building a fixture Cookies
SQLite and injecting the passphrase rather than shelling out to
`/usr/bin/security`. If a caller doesn't allow injection, refactoring it to
accept one is part of the work.

## Things that need care

- **No network in tests.** App tools take an injection seam — pass a fake
  `AppToolContext` (`{ replay: async (req) => makeCapture({ … }), store }`) rather
  than monkeypatching global `fetch`. `runSpeedTest(ctx)` and `fetchMyCards(ctx)`
  both route through it. Only `runReplay` itself, and fast.com's range download,
  genuinely reach the network — leave those to manual verification.
- **`ctx.replay` is single-flight.** A fake context that calls back into another
  `ctx.replay` deadlocks the same way the real one does; keep fakes flat.
- **macOS-only paths.** Credential extraction returns `[]` or throws off darwin.
  Guard those tests with `{ skip: process.platform !== 'darwin' }` so the suite
  stays green in CI on ubuntu.
- **Temp files.** Use the OS temp dir and clean up in a `finally`; never write
  into `~/.sluice`, which is the user's real capture store. Never point a test at
  `defaultDbPath()`.
- **`noUncheckedIndexedAccess` is on.** `arr[0]` is possibly-undefined, so assert
  existence before dereferencing or the test won't typecheck.

## Checklist

- `test` script added to the package's `package.json`, and `@sluice/adapter-sdk`
  in `devDependencies` if you use the fixtures.
- Captures built with `makeCapture` / `makeJsonCapture`, not a local helper.
- Real in-memory `SqliteStore`, not a mock.
- For an adapter: `runConformance(app, { session })` before anything else.
- At least one negative case per unit — the miss, the malformed body, the wrong
  token, the lookalike host.
- Platform-specific tests skipped rather than failing off-darwin.
- `pnpm test` in the package, then `pnpm test` from the root.
