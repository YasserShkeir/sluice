#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `sluice-mcp` — start the Sluice MCP stdio server.
 *
 * Wire it into an MCP client (e.g. Claude Code) as a stdio server command. The
 * store path defaults to `~/.sluice/sluice.db`; override with `SLUICE_DB`.
 * Only stderr is used for diagnostics — stdout is the MCP transport.
 */
import process from 'node:process';

import { startStdioServer } from './server.js';

startStdioServer().catch((err: unknown) => {
  process.stderr.write(
    `[sluice-mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
