#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The entry point for `npx sluicejs …`, or `sluice` after `npm i -g sluicejs`.
 * The bare `sluice` npm name is taken, so the package is sluicejs but still
 * installs a `sluice` bin. `sluicejs` is declared too: @sluice/runner's own
 * `sluice` bin can win npm's hoisting, and npx prefers the bin matching the
 * package name. It imports rather than spawns, so argv, stdio, exit codes and
 * signals stay in-process.
 */
import '@sluice/runner/cli';
