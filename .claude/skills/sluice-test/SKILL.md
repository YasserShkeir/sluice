---
name: sluice-test
description: Add or extend a test suite for a Sluice package using the repo's node:test + tsx pattern with in-memory SqliteStore fixtures. Use this whenever the user wants tests for anything under packages/* or apps/webapp — "add tests for the store", "test the redactor", "cover the MCP handlers", "write a test for this adapter", "why is there no test for X" — or when working through the untested-packages backlog. Also use when a package needs its test script wired up, since most packages under `packages/*` and `apps/webapp` declare a `test` script; root `pnpm test` runs `pnpm -r --if-present test`.
---

# Testing in Sluice

The repo uses Node's built-in test runner through tsx — no vitest, no jest, no
config file. Two packages have suites today (`app-slack`, `cartographer`); the
rest, including the store, the redactor, the WS server and the MCP handlers, have
none. That means most of what you write here is the first coverage a module has
ever had, so bias toward the boundaries that would leak credentials or corrupt
data if they broke.

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
with `pnpm -r --if-present test`. (There is currently no root `test` script —
plain `pnpm test` at the root exits 1 with no output. Adding it is a tracked
task; do it if you're touching this area.)

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteStore } from '@sluice/core';
import type { Capture } from '@sluice/core';
import { parseFastCapture } from './index.js';

test('parses a config response into one container per CDN target', () => {
  const result = parseFastCapture(capture({ resBody: JSON.stringify({ targets: [/* … */] }) }));
  assert.equal(result.containers?.length, 3);
});
```

Use `node:assert/strict` and end relative imports with `.js` — the repo compiles
with `verbatimModuleSyntax` and `moduleResolution: Bundler`, so a missing
extension or a value-import of a type will fail typecheck even when the test passes.

## Fixtures: build captures from a helper

Almost every test needs a `Capture`, which has fifteen required fields. Define one
local helper with sane defaults and override per test — `cartographer.test.ts`
already does exactly this and it's worth copying verbatim:

```ts
function capture(over: Partial<Capture>): Capture {
  return {
    id: 'cap',
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: 'slack',
    method: 'POST',
    url: 'https://slack.com/api/api.test',
    host: 'slack.com',
    path: '/api/api.test',
    status: 200,
    durationMs: 10,
    reqHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    reqBody: null,
    resHeaders: { 'content-type': 'application/json' },
    resBody: null,
    ...over,
  };
}
```

Use a **fixed** `ts` rather than `Date.now()`. Several code paths derive ordering,
table names and api-map output from timestamps, and a moving clock turns a real
regression into an intermittent one.

## Use a real store, in memory

Don't mock `SqliteStore` — it's better-sqlite3 and constructing one in memory is
fast and exercises the actual SQL, which is where the bugs are. Seed it with
`insertCapture` and assert on what comes back out. This is how the cartographer
suite works, and it's why those tests catch schema problems that a mock would hide.

Prefer asserting on observable results (rows returned, entities produced, headers
emitted) over internal call sequences. The point is to survive refactors of the
implementation, not to pin it in place.

## What's worth testing, by layer

Ordered by what breaks worst if it regresses:

**`packages/core/src/redact.ts`** — the single sink guarding every write, and
completely untested. Assert both directions: that credential shapes (`xoxc-`,
`xoxd-`, `Bearer …`, `authorization`/`cookie` headers) are masked, and that
non-secrets survive. Known live gaps worth encoding as tests:
`{"api_token":"xoxc-…"}`, `{"d":"xoxd-…"}` and `"idToken":"eyJ…"` currently pass
through unredacted — write those as failing tests if you're fixing the bug, and
as passing ones once the app-contributed-patterns work lands.

**`packages/core/src/store.ts`** — round-trip each entity type, and cover the
malformed-row case: the row mappers call `JSON.parse` unguarded, so a corrupt
`raw` column throws out of every read path.

**`packages/runner/src/server.ts`** — the loopback auth boundary. The static
handler's path-traversal guard and the WS handshake's Origin + bearer-token
rejection are security properties; assert that a bad Origin and a wrong token are
both refused. These need a real server on an ephemeral port — start it, hit it,
close it in a `finally`.

**Adapters (`packages/app-*`)** — `parse` against captured fixtures (the
`app-slack` suite is the model), `matchRequest` on both hit and miss, and
`buildReplayRequest` asserting the credential actually lands in the right place.
That last one would have caught the bug where a session reaching the wrong
adapter's builder emits a literal `Cookie: cookieHeader` header.

**`packages/mcp/src/server.ts`** — drive the tool handlers against a seeded store
and assert on returned payloads, including the error path.

**Credential decryption (`slack-credentials.ts`, `chrome-cookies.ts`)** — testable
without a Keychain: build a fixture Cookies SQLite file and inject the passphrase
rather than shelling out to `/usr/bin/security`. If the function doesn't allow
injection, refactoring it to accept one is part of the work.

## Things that need care

- **No network in tests.** `runSpeedTest`, `fetchMyCards` and `runReplay` all
  make real calls. Test the pure parts (URL building, response shaping, header
  construction) and leave the fetch itself to manual verification, or inject a
  fetch.
- **macOS-only paths.** Credential extraction hard-throws off darwin. Guard those
  tests with `{ skip: process.platform !== 'darwin' }` so the suite stays green
  in CI on ubuntu.
- **Temp files.** Use the OS temp dir and clean up in a `finally`; never write
  into `~/.sluice`, which is the user's real capture store.
- **`noUncheckedIndexedAccess` is on.** `arr[0]` is possibly-undefined, so assert
  existence before dereferencing or the test won't typecheck.

## Checklist

- `test` script added to the package's `package.json`.
- Local `capture()` helper with a fixed timestamp.
- Real in-memory `SqliteStore`, not a mock.
- At least one negative case per unit — the miss, the malformed body, the wrong token.
- Platform-specific tests skipped rather than failing off-darwin.
- `pnpm test` in the package, then `pnpm -r --if-present test` from the root.
