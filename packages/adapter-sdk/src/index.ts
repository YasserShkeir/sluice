// SPDX-License-Identifier: Apache-2.0
/**
 * @sluice/adapter-sdk — everything you need to write a Sluice adapter, and the
 * harness that decides whether you wrote it correctly.
 *
 * Apache-2.0, deliberately: `@sluice/core` and this package are the two pieces a
 * third party has to depend on to ship an adapter, and putting the copyleft of
 * the runner on either of them would defeat the point of a pluggable seam.
 *
 *   coerce.*        — total coercion helpers. parse() must never throw.
 *   requestParams   — recover what a request was made WITH, not just its answer.
 *   makeCapture     — the fixture factory every test was privately re-declaring.
 *   scrubCaptures   — turn a recording of a real account into a committable fixture.
 *   runConformance  — the invariants every adapter must satisfy.
 *   runMockCaptures — replay NDJSON through the real ingest path, no credentials.
 */
export { arr, bool, compact, num, obj, safeJson, safeJsonObject, str } from './coerce.js';
export { requestParam, requestParams } from './request-params.js';
export { makeCapture, makeJsonCapture, resetCaptureIds } from './fixtures.js';
export { scrubCaptures } from './scrub.js';
export type { ScrubOptions } from './scrub.js';
export { runConformance } from './conformance.js';
export type { ConformanceOptions } from './conformance.js';
export { parseNdjson, runMockCaptures, toNdjson } from './mock-runner.js';
export type { CaptureSink, MockRunOptions } from './mock-runner.js';
export { checkConformance } from './check.js';
