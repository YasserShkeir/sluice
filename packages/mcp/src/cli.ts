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

import { redactedErrorMessage, sweepStaleTempDirs } from '@sluice/core';
import { startStdioServer } from './server.js';

// A killed earlier run can leave a plaintext copy of an app's credential store
// in $TMPDIR; remove it even if this session never reads that app again.
sweepStaleTempDirs();

startStdioServer().catch((err: unknown) => {
  process.stderr.write(`[sluice-mcp] fatal: ${redactedErrorMessage(err)}\n`);
  process.exit(1);
});
