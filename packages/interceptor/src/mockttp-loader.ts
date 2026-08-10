// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The single place mockttp is loaded. Every other module goes through
 * `loadMockttp()` — never `import('mockttp')` directly.
 *
 * Why it is dynamic. mockttp is a ~12 MB tree that only `sluice start` needs, so
 * a static import would make every other command — `doctor`, `serve`, `export`,
 * the whole MCP server — pay for it at startup. `scripts/build.mjs` relies on
 * this being the ONLY dynamic import of mockttp: esbuild's code splitting turns
 * it into a separate chunk that no other command ever loads.
 *
 * Why it needs an interop shim. mockttp ships a CommonJS build. When esbuild
 * inlines it, `await import('mockttp')` resolves to a namespace whose real
 * exports sit on `.default`, because a CJS module's export names cannot be known
 * statically. Run the same source under tsx or plain Node and the named exports
 * are on the namespace itself. Reading `getLocal` off the wrong one yields
 * `getLocal is not a function` — at proxy-start time, from inside a catch that
 * degrades to "the web UI still works", so the capture engine silently never
 * starts. Normalising here means neither caller has to know which shape it got.
 *
 * (mockttp's own CJS build `require()`s get-port@7, which is ESM-only, so on Node
 * older than 20.19 / 22.12 an unbundled `import('mockttp')` throws ERR_REQUIRE_ESM.
 * Bundling resolves that at build time. mockttp 4.6.0 is the latest release —
 * there is no version bump that avoids it.)
 */

type Mockttp = typeof import('mockttp');

let cached: Promise<Mockttp> | undefined;

export function loadMockttp(): Promise<Mockttp> {
  cached ??= import('mockttp').then((mod) => {
    const ns = mod as Mockttp & { default?: Partial<Mockttp> };
    // Trust `default` only when it actually carries the API; a genuine ESM
    // namespace can also expose an unrelated `default`.
    return typeof ns.getLocal === 'function' ? ns : ((ns.default ?? ns) as Mockttp);
  });
  return cached;
}
