// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/runner — the local CLI daemon that wires engine + store + adapters +
 * web UI together. The CLI entrypoint is `src/cli.ts` (bin: `sluice`); this
 * module re-exports the pieces other tooling may embed.
 */
export { startServer } from './server.js';
export type { StartServerOpts, StartServerResult } from './server.js';
export * from './config.js';
