// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/cartographer — turn captured traffic into (a) an endpoint catalog and
 * (b) a per-app SQLite schema materialized from real responses.
 *
 * Everything below reads the store's captures and, for materialize, writes
 * per-app tables into the SAME db via the store's readonly `db` handle. Only
 * shape/names are ever surfaced, never a param or header value, so no path here
 * can leak a secret.
 */
export * from './infer.js';
export * from './map.js';
export * from './materialize.js';
export * from './render.js';
export * from './faithful.js';
export * from './flows.js';
export * from './flow-learn.js';
export * from './flow-build.js';
export { quoteIdent } from './util.js';
