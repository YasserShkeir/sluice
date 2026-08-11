// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bundle the two shipping entrypoints into runnable JavaScript.
 *
 * Until now the `bin` fields pointed at `.ts` files carrying a `#!/usr/bin/env
 * node` shebang, which crash with ERR_UNKNOWN_FILE_EXTENSION the moment anything
 * other than `tsx` invokes them. That made `sluice-mcp` — whose entire purpose is
 * to be spawned by an MCP client — dead on arrival, and made `npx sluice`
 * impossible.
 *
 * Everything first-party is inlined so the published artifact does not depend on
 * the workspace layout. What stays external:
 *   - better-sqlite3 and classic-level are native addons; bundling their JS
 *     wrapper breaks the `.node` binding lookup.
 *   - the MCP SDK, ws and zod are ordinary runtime deps of the published package.
 *
 * mockttp is the exception, and the reason this build is code-split.
 *
 * Its CJS build `require()`s get-port@7, which is ESM-only — so `import('mockttp')`
 * throws ERR_REQUIRE_ESM on any Node older than 20.19 / 22.12 (the releases that
 * added `require(esm)`). tsx papers over it; plain `node` does not, which left
 * `sluice start` unusable from a published tarball. mockttp 4.6.0 is the latest
 * release, so there is no version bump that fixes this.
 *
 * Bundling it resolves the require-of-ESM at build time, and it works on any
 * supported Node. But mockttp is ~12 MB once inlined, and only `sluice start`
 * ever touches it — so `splitting: true` keeps it in its own chunk that the
 * existing `await import('mockttp')` in mitm-engine.ts loads on demand. Every
 * other command still parses only the entry plus its shared chunk (~0.5 MB).
 */
import { build } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Left for Node to resolve at runtime — see the note above. */
const external = [
  'better-sqlite3',
  'classic-level',
  // node-pty is a native addon (loaded lazily, only under `serve --terminal`).
  // Bundling its JS wrapper breaks the `.node`/spawn-helper lookup, same as the
  // other native deps — leave it for Node to resolve at runtime.
  'node-pty',
  'chrome-remote-interface',
  'ws',
  'zod',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
];

const targets = [
  { entry: 'packages/runner/src/cli.ts', outdir: 'packages/runner/dist', bin: 'cli.js' },
  // The isolated capture engine (§S1, `serve --isolated`). A separate entry so it
  // can be spawned as its own process; it carries mockttp, which is why isolation
  // also keeps that 12 MB out of the parent's resident set until capture starts.
  { entry: 'packages/runner/src/engine-child.ts', outdir: 'packages/runner/dist', bin: 'engine-child.js' },
  // The MCP server never starts a capture engine, so it must not carry mockttp's
  // 12 MB. It is not a dependency of @sluice/mcp either — marking it external
  // means a code path that somehow reached it fails loudly instead of shipping
  // a chunk nothing can ever load.
  {
    entry: 'packages/mcp/src/cli.ts',
    outdir: 'packages/mcp/dist',
    bin: 'cli.js',
    external: [...external, 'mockttp'],
  },
];

// Drop stale code-split chunks so a renamed entry does not leave orphans that
// confuse size diffs and can be accidentally required by an old import map.
// Once per OUTDIR, before any target builds: the runner CLI and the engine child
// share `packages/runner/dist`, so clearing inside the loop deleted the chunks the
// previous target had just emitted and left `cli.js` importing files that no longer
// existed (ERR_MODULE_NOT_FOUND on every invocation).
for (const outdir of new Set(targets.map((t) => resolve(root, t.outdir)))) {
  mkdirSync(outdir, { recursive: true });
  const chunksDir = resolve(outdir, 'chunks');
  if (existsSync(chunksDir)) rmSync(chunksDir, { recursive: true, force: true });
}

for (const target of targets) {
  const outdir = resolve(root, target.outdir);
  await build({
    entryPoints: [resolve(root, target.entry)],
    outdir,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // Splitting requires outdir rather than outfile; the entry keeps its own
    // basename (cli.js), so the `bin` fields do not move.
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    external: target.external ?? external,
    sourcemap: true,
    banner: {
      js: `// Bundled by scripts/build.mjs — edit the sources under src/, not this file.
// createRequire keeps native addons (better-sqlite3, classic-level) loadable
// from an ESM bundle.
import { createRequire as __sluiceCreateRequire } from 'node:module';
const require = __sluiceCreateRequire(import.meta.url);
`,
    },
  });

  // esbuild carries the entry's own shebang into the output, which lands AFTER
  // the banner — and a `#!` on any line but the first is a syntax error. Strip
  // every shebang and put exactly one back at the top.
  const binPath = resolve(outdir, target.bin);
  const bundled = readFileSync(binPath, 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#!'))
    .join('\n');
  writeFileSync(binPath, `#!/usr/bin/env node\n${bundled}`);
  chmodSync(binPath, 0o755);
  console.log(`built ${target.outdir}/${target.bin}`);
}

// The runner serves the dashboard. In the workspace it resolves it via a relative
// path up to apps/webapp/dist, which does not exist inside a published tarball —
// so copy it in alongside the bundle and let config.ts prefer that copy.
const webappSrc = resolve(root, 'apps/webapp/dist');
const webappOut = resolve(root, 'packages/runner/dist/webapp');
if (existsSync(webappSrc)) {
  cpSync(webappSrc, webappOut, { recursive: true });
  console.log('bundled the dashboard into packages/runner/dist/webapp');
} else {
  console.warn('WARNING: apps/webapp/dist is missing — run `pnpm webapp:build` first.');
}
