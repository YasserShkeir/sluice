#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The bare-name entry point — `npx sluicejs …`, or a plain `sluice` command
 * after `npm i -g sluicejs`.
 *
 * Why a wrapper package exists at all: the roadmap wanted literal `npx sluice`,
 * which needs the bare `sluice` name on npm. That name is taken — `sluice@0.0.2`,
 * published in 2013 and untouched since 2022 — so it is not available to rename
 * into or to publish a wrapper under. `sluicejs` is, and it still installs the
 * binary as `sluice`, so every command in the docs reads the same once installed.
 *
 * Two bin names, on purpose. `@sluice/runner` also declares a `sluice` bin — it
 * has to, so `npx @sluice/runner` keeps working — and npm hoists the transitive
 * runner and links ITS `sluice` first, so the wrapper's `sluice` loses the race.
 * That is harmless (both start the same CLI) but it is not something to depend
 * on, so `sluicejs` is declared as well: it collides with nothing, and npx
 * prefers the bin whose name matches the package.
 *
 * This file deliberately contains no logic. `@sluice/runner/cli` runs its own
 * `main()` on import and reads `process.argv` directly, which is already correct
 * here: importing rather than spawning means argv, stdio, exit codes and signal
 * handling all belong to this process, with no child to keep in step.
 */
import '@sluice/runner/cli';
