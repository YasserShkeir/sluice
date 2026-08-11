<!-- SPDX-License-Identifier: Apache-2.0 -->

# @sluice/adapter-sdk

Everything you need to write a [Sluice](https://github.com/YasserShkeir/sluice)
adapter — and the harness that decides whether you wrote it correctly.
Apache-2.0, deliberately: this and `@sluice/core` are the two pieces a third
party depends on to ship an adapter, so neither carries the runner's copyleft.
`@sluice/core` is this package's only runtime dependency.

An adapter teaches Sluice one service: which hosts it owns, how to turn its API
responses into the normalized entity model, and which calls are safe to replay.
The `Adapter` / `App` interfaces themselves live in `@sluice/core`; this package
is the tooling around them.

```ts
import {
  str, num, arr, obj, bool, compact, safeJson, safeJsonObject,
  requestParam, requestParams,         // recover what a request was made WITH
  makeCapture, makeJsonCapture, resetCaptureIds,
  scrubCaptures,                       // turn a real recording into a committable fixture
  checkConformance,                    // the throw-free load-time gate
  parseNdjson, toNdjson, runMockCaptures,
  runConformance,                      // test files only — it imports node:test
} from '@sluice/adapter-sdk';
```

## What's inside

- **`coerce.*`** — `str`, `num`, `bool`, `arr`, `obj`, `compact`, `safeJson`,
  `safeJsonObject`. Total coercion helpers, not validators: an adapter's
  `parse()` runs on arbitrary response bodies and must never throw, so these
  give you `undefined` instead of an exception. `str()` rejects numbers, `num()`
  coerces numeric strings, `bool()` is not truthiness, `obj()` excludes arrays
  and null, `compact()` drops undefined values.
- **`requestParam` / `requestParams`** — recover the parameters a request was
  made with, not just its response. Merges a JSON body, then a urlencoded body,
  then the query string, with the **query string winning** (Slack's
  `conversations.history` puts the channel id only in the request).
- **`makeCapture` / `makeJsonCapture` / `resetCaptureIds`** — the capture fixture
  factory every test was privately re-declaring. Sequential `cap_<n>` ids and
  sane defaults, overrides applied last; call `resetCaptureIds()` in a
  `beforeEach` when ids matter.
- **`scrubCaptures`** (+ `ScrubOptions`) — turn a recording of your real account
  into a fixture safe to commit. The contract is *preserve shape, replace
  content*: array lengths, nesting depth, object keys, types, every string's
  length, relative timestamp order and the form of ids survive; characters and
  absolute timestamps do not. Deterministic — every synthetic value is derived
  from a salted FNV-1a hash, so re-scrubbing the same recording is byte-identical.
- **`checkConformance`** — see below.
- **`runConformance`** (+ `ConformanceOptions`) — see below.
- **`parseNdjson` / `toNdjson` / `runMockCaptures`** (+ `CaptureSink`,
  `MockRunOptions`) — replay NDJSON captures through the real ingest path with
  no credentials, to see what your adapter produces. Pacing follows recorded
  `ts` deltas (`speed`, `maxGapMs`) so multi-request **bursts** look like live
  traffic — the same fixture path flow clustering / dashboard rate UI should use
  in tests (F0.4). Prefer `speed: Infinity` in pure unit tests. `parseNdjson`
  skips malformed lines by line number rather than losing the whole fixture.

## The two conformance gates

They are not interchangeable.

**`runConformance(app, opts?)` — build time.** Registers 11 `node:test` cases and
drives them over 10 hostile paths (`/api/__proto__`, `/api/%2e%2e%2f`, a 300-char
segment, …) and 14 hostile bodies (truncated JSON, HTML, JSON scalars,
prototype keys, …), including over the adapter's *own* endpoint paths derived
from each `listReplayActions()` `urlTemplate`. The invariants: non-empty
`id`/`displayName`/`hosts` with bare lowercase hostnames; `matchRequest` claims
its own hosts; `matchRequest` rejects lookalike hosts; `parse` never throws;
`parse` returns a well-formed `ParseResult`; `classify` never throws and names an
operation; `nextCursors` never throws, returns an array, addresses only its own
adapter, names a real action, and never emits an empty-string cursor (which would
re-fetch page 1 forever); every emitted entity is owned by this adapter; replay
actions are well-formed and uniquely namespaced as `<app.id>.`;
`buildReplayRequest` resolves secrets **by value, never by key name**; credential
hints never carry a usable secret.

For an adapter registered in `@sluice/apps` this is not optional —
`packages/apps/src/registry.test.ts` runs `for (const app of apps) runConformance(app)`
under the comment *"Adding an adapter to the registry above without satisfying
these fails the build."* Run it with `pnpm --filter @sluice/apps test`.

Two traps:

- `ConformanceOptions.session` is what enables the `buildReplayRequest` secret
  checks. Omitting it **silently skips** them (fast.com legitimately has no
  credential seam). Pass a session if your adapter has one. `fixtures` drives the
  entity-ownership and cursor-seed checks.
- `conformance.ts` statically imports `node:test` and is re-exported from the
  barrel, so *any* `import … from '@sluice/adapter-sdk'` pulls a bare `node:test`
  import into the graph — it survives into both of this repo's shipped bundles.
  Import `runConformance` from test files only; in-repo code that must avoid it
  can import the other helpers from their own modules instead.

**`checkConformance(app)` — load time.** The throw-free subset that runs outside
a test runner: it returns one string per problem (empty array means pass) and
never throws, stopping after 12 problems. It covers the declaration shape plus
`matchRequest` / `parse` / `classify` / `nextCursors` not throwing and `parse`
returning a non-array object, and finally that `listReplayActions()` does not
throw. `@sluice/apps` passes it to `discoverAdapters` as the `check` callback, so
it is **the gate an externally distributed adapter must pass to be loadable** —
a failing adapter is rejected at install time with its reasons printed.

It deliberately does **not** cover host-claim coverage, replay-action wiring or
seed addressing, and it is **not a security boundary**. It proves an adapter is
not broken, not that it is trustworthy.

## License

Apache-2.0.
