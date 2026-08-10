// SPDX-License-Identifier: Apache-2.0
/**
 * The capture factory every test needs.
 *
 * Four packages each grew a byte-similar private copy of this — app-slack,
 * app-trello, app-fast and core — which meant a new required field on `Capture`
 * had to be added in four places, and the four drifted in what they defaulted.
 */
import type { Capture } from '@sluice/core';

let seq = 0;

/**
 * A fully-populated Capture with sane defaults. Overrides are applied last, so
 * a test states only the field it is actually about.
 *
 * Ids are sequential rather than random so a failing assertion names the same
 * capture on a re-run.
 */
export function makeCapture(over: Partial<Capture> = {}): Capture {
  seq += 1;
  return {
    id: `cap_${seq}`,
    ts: 1_700_000_000_000,
    source: 'mitm',
    adapterId: null,
    method: 'POST',
    url: 'https://example.com/api/test',
    host: 'example.com',
    path: '/api/test',
    status: 200,
    durationMs: 10,
    reqHeaders: { 'content-type': 'application/json' },
    reqBody: null,
    resHeaders: { 'content-type': 'application/json' },
    resBody: null,
    ...over,
  };
}

/**
 * A capture of a JSON response from a given host+path, with the url derived
 * rather than restated — the commonest fixture shape by far, and the commonest
 * place for a test to accidentally disagree with itself about which endpoint it
 * is describing.
 */
export function makeJsonCapture(
  host: string,
  path: string,
  body: unknown,
  over: Partial<Capture> = {},
): Capture {
  return makeCapture({
    host,
    path,
    url: `https://${host}${path}`,
    resBody: typeof body === 'string' ? body : JSON.stringify(body),
    ...over,
  });
}

/** Reset the id counter so a suite's ids are stable in isolation. */
export function resetCaptureIds(): void {
  seq = 0;
}
