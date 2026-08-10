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

## Suppressions in the source

Two `biome-ignore` comments exist, both with a stated reason:

- `app-trello/src/chrome-cookies.ts` — a regex that matches control characters,
  because rejecting cookie values containing them *is the point*.
- `webapp/src/components/DataBrowser.tsx` — an array index as a React key, because
  materialized rows have no guaranteed stable id and the page is replaced wholesale.

If you add one, say why in the comment. A suppression without a reason is just a
disabled check.

### `a11y/useKeyWithClickEvents` (webapp)

`TrafficDashboard` row/tab click targets also handle keyboard activation. Where Biome still flags a pattern that already has `tabIndex` + `onKeyDown`, a file-local `biome-ignore` is acceptable; prefer wiring real keyboard handlers over blanket disables.

