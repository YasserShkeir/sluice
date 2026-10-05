// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The single place mockttp is loaded. Every other module goes through
 * `loadMockttp()` — never `import('mockttp')` directly.
 *
 * Dynamic because mockttp is a ~12 MB tree that only `sluice start` needs.
 * `scripts/build.mjs` relies on this being the ONLY dynamic import of mockttp,
 * so esbuild's code splitting turns it into a separate chunk.
 *
 * Interop shim: when esbuild inlines mockttp's CJS build, the exports sit on
 * `.default`; under tsx or plain Node they are on the namespace. Reading the
 * wrong one fails silently at proxy start (`getLocal is not a function` inside
 * a catch that degrades to web-UI-only). Bundling also sidesteps mockttp's
 * `require()` of ESM-only get-port@7 on Node < 20.19 / 22.12.
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
