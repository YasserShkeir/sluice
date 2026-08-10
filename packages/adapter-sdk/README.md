<!-- SPDX-License-Identifier: Apache-2.0 -->

# @sluice/adapter-sdk

Everything you need to write a [Sluice](https://claude.com/) adapter — and the
harness that decides whether you wrote it correctly. Apache-2.0, deliberately:
this and `@sluice/core` are the two pieces a third party depends on to ship an
adapter, so neither carries the runner's copyleft.

An adapter teaches Sluice one service: which hosts it owns, how to turn its API
responses into the normalized entity model, and which calls are safe to replay.

```ts
import {
  str, num, arr, obj, safeJsonObject, // total coercion helpers — parse() must never throw
  requestParams,                       // recover what a request was made WITH
  makeCapture,                         // the fixture factory for tests
  scrubCaptures,                       // turn a real recording into a committable fixture
  runConformance,                      // the invariants every adapter must satisfy
  runMockCaptures,                     // replay NDJSON through the real ingest path, no creds
} from '@sluice/adapter-sdk';
```

## What's inside

- **`coerce.*`** — total coercion helpers. An adapter's `parse()` runs on
  arbitrary response bodies and must never throw; these give you `undefined`
  instead of an exception.
- **`requestParams`** — recover the parameters a request was made with, not just
  its response.
- **`makeCapture` / `makeJsonCapture`** — the capture fixture factory every test
  was privately re-declaring.
- **`scrubCaptures`** — turn a recording of your real account into a fixture safe
  to commit.
- **`runConformance`** — the invariants every adapter must satisfy, as a test you
  run against yours.
- **`runMockCaptures`** — replay NDJSON captures through the real ingest path with
  no credentials, to see what your adapter produces.

## License

Apache-2.0.
