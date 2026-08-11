<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# sluicejs

The bare-name launcher for [Sluice](https://github.com/YasserShkeir/sluice) — a
local-only interceptor and explorer for **your own** SaaS API traffic.

> Not published to npm yet. `npx sluicejs` does not resolve today; build from a
> clone (`pnpm install && pnpm build`) and run `node packages/runner/dist/cli.js`,
> or `pnpm sluice <command>` in the repo.

This package contains no logic. It exists only to own a bare npm name — the
literal `sluice` name has been taken since 2013 — and its single statement is
`import '@sluice/runner/cli'`, which resolves to the runner's built
`dist/cli.js` and runs in the same process: same argv, same stdio, same exit
codes, no child to keep in step. It declares two bin names, `sluicejs` and
`sluice`, but `@sluice/runner` declares a `sluice` bin too and npm links the
transitive runner's first, so `sluice` on your PATH is normally the runner's.

## First run

`sluice start` runs the MITM proxy but routes **nothing** on its own, and it
generates the local CA without trusting it. The real order is four steps:

```bash
sluice doctor        # check the local environment (Node, sign-in, ports, CA trust)
sluice ca-install    # one-time: generate + TRUST the local CA (macOS Keychain)
sluice start         # loopback dashboard + the MITM proxy engine, running
sluice proxy on      # point the macOS system proxy at it
```

`sluice proxy on` is system-wide. To route a single app instead, use the
`open -a <App> --args --proxy-server=127.0.0.1:<proxyPort>` line that
`sluice start` prints.

Engine A decrypts **every host** by default so services with no adapter yet are
still captured. Scope it with `--host api.trello.com` (repeatable),
`interceptHosts` in the config file, or `interceptAllHosts: false`.

## The three server commands

```bash
sluice serve      # dashboard + engine control; capture starts IDLE
sluice start      # serve, plus the MITM engine started immediately
sluice capture    # passive Chrome DevTools capture — no proxy, no CA, no Keychain
```

`serve` is not read-only over past captures: it builds the same engine
controller and hands it to the dashboard, so the Control panel can start/stop
capture and toggle the system proxy — the engine merely starts idle. It also
owns the flags `start` does not have: `--isolated`, `--ingest`, `--terminal*`.

`sluice --help` lists all 24 commands; `sluice <command> --help` gives one
command's options. `packages/runner/README.md` documents the full surface.

## Platform

Capture and credential extraction are **macOS-only** today: the system proxy
goes through `networksetup`, CA trust through `/usr/bin/security`, and four of
the six installed apps read credentials from the macOS Keychain and local
browser profiles. Elsewhere you get a proxy you cannot route to and no
credentials: pasting them in with `--token` / `--cookie` only works where the app
implements `sessionFromInput`, and today that is Slack alone.

## Everything is local

Everything Sluice does happens on loopback, against traffic you already have
access to. See the main repository for the security model.

Licensed AGPL-3.0-or-later.
