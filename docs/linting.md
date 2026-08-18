# Linting

`pnpm lint` runs [Biome](https://biomejs.dev) over `packages/*/src` and
`apps/webapp/src`. `pnpm lint:fix` applies its safe fixes. CI runs `pnpm lint`.

## Why lint-only, no formatter

Biome's formatter and its import-sorting assist are both **disabled**. Turning
either on rewrites essentially every file in the repo, which would bury real
changes in whitespace and reordered imports and make `git blame` useless for a
codebase whose comments carry a lot of the reasoning.

Formatting is not currently enforced. If you want it, that is a deliberate,
separate commit that touches everything at once — not a side effect of a bug fix.

## Rules that are deliberately off

Each of these was reviewed against the actual findings rather than switched off
to make the run green.

### `correctness/useExhaustiveDependencies`

**This one is off because its autofix is actively dangerous here.**

The webapp's store is a mutable ring buffer behind a `useRef`, paired with a
`version` counter that is the *only* signal to React that the buffer changed:

```ts
const rows = useMemo(() => { /* reads listRef.current */ }, [version, filters]);
```

Biome sees that `version` is not read inside the callback and reports it as an
unnecessary dependency. Removing it — which `lint:fix` would do — freezes the
traffic table at its first render, silently, with no type error and no test
failure. The same pattern drives `noticeId` in `App.tsx`, where keying on the id
is what makes a toast fire once per notice rather than once per animation frame.

The dependency arrays in this codebase are deliberate and commented. Read the
comment before changing one.

### `complexity/useLiteralKeys`, `complexity/useOptionalChain`

Pure style, no correctness content. Not worth the churn.

### `style/noNonNullAssertion`

`noUncheckedIndexedAccess` is on in `tsconfig.base.json`, so indexed access is
already `T | undefined` and `!` is the normal way to express "I have checked the
bound above". Banning it would push people toward looser typing, not tighter.

### `complexity/noForEach`

`forEach` is fine.

## Rules escalated to error

Everything else runs at Biome's recommended severity. These two are raised to
`error`, and they are the config's only enforcement teeth.

### `style/useImportType`

`tsconfig.base.json` sets `verbatimModuleSyntax` (and `isolatedModules`), so an
import statement is emitted exactly as written and no compiler elides type-only
names for you. A type imported as a value becomes a real runtime import of
something that does not exist at runtime. TypeScript rejects it outright under
that flag, so this is a build failure rather than a style preference — the Biome
rule just tells you before `pnpm typecheck` does. `import type { Capture } from
'@sluice/core'`, always, for anything that is only a type.

### `suspicious/noExplicitAny`

Sluice's whole job is handling response bodies from services that owe it nothing.
An `any` at an ingest or parse boundary is precisely how untrusted JSON gets
treated as trusted: `body.items.map(…)` type-checks fine and throws on the first
response that shaped `items` as an object. Use `unknown` and narrow it, or use the
total coercion helpers in `@sluice/adapter-sdk` (`str`, `num`, `bool`, `arr`,
`obj`, `safeJson`) which return `undefined` rather than lying about the shape.

## Suppressions in the source

`biome-ignore` comments that still exist, each with a stated reason:

- `packages/core/src/chrome-cookies.ts` — a regex that matches control characters,
  because rejecting cookie values containing them *is the point* (shared Chrome
  cookie header builder; apps no longer each carry this suppression).
- `webapp/src/components/DataBrowser.tsx` — an array index as a React key, because
  materialized rows have no guaranteed stable id and the page is replaced wholesale.

If you add one, say why in the comment. A suppression without a reason is just a
disabled check.

## Overrides in biome.json

### `a11y/useSemanticElements` (TrafficDashboard only)

`biome.json` turns this rule off for exactly one path,
`apps/webapp/src/components/TrafficDashboard.tsx`. It is a config override rather
than a source suppression because it applies to the whole file — the traffic table
is `role="grid"` over absolutely-positioned `div`s, not a `<table>`, and the rule
fires on every one of them.

The reason is the virtualizer: `@tanstack/react-virtual` positions rows by
absolute offset, which table layout will not tolerate. The ARIA structure is real
— `grid > rowgroup > row > gridcell` throughout, with the header inside the grid
so a `role="row"` always has a grid ancestor — it just is not built out of table
elements. The comment at the top of the grid in that file says the same thing.

This is the only override in the config. Do not widen it; a second file wanting
the same exemption is a sign the pattern should be extracted, not that the rule is
wrong.

## What Biome does not see

`biome.json` matches three globs only: `packages/*/src/**/*.ts`,
`apps/webapp/src/**/*.ts` and `apps/webapp/src/**/*.tsx`. Unlinted, therefore:

- `scripts/build.mjs` — the esbuild build script.
- `vite.config.ts` and anything else at a package root.
- `apps/webapp/src/**/*.js`.
- Everything in `packages/extension` — the MV3 extension is plain JavaScript with
  no `src/*.ts`, so none of it is linted or typechecked.

`pnpm lint` currently checks 160 files, exits 0, and reports 3 warnings and 1
info: `style/useTemplate` and `complexity/noCommaOperator` in
`packages/core/src/store.ts`, `style/useConst` in
`packages/interceptor/src/flow-replay.ts`, and an unused `Supervisor` type import
in `packages/runner/src/cli.ts`. Biome exits 0 on warnings, so CI is green with
these outstanding — a clean run is not the same as a green one.

