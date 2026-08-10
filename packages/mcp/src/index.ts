// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/mcp — public surface.
 *
 * The MCP stdio server that exposes Sluice's captured data + replay to an MCP
 * client. Run it via the `sluice-mcp` bin (see ./cli.ts) or embed it:
 *
 *   import { startStdioServer } from '@sluice/mcp';
 *   await startStdioServer();
 */
export { buildServer, openStore, defaultDbPath, startStdioServer } from './server.js';
