<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# sluicejs

The bare-name launcher for [Sluice](https://github.com/yassershkeir/sluice) — a
local-only interceptor and explorer for **your own** SaaS API traffic.

```bash
npx sluicejs doctor      # check the local environment
npx sluicejs start       # capture through the MITM proxy
npx sluicejs serve       # dashboard only, over what you already captured
```

Install it globally and the binary is called `sluice`, so every command in the
docs reads the same:

```bash
npm i -g sluicejs
sluice doctor
```

This package contains no logic. It exists only to own a bare npm name — the
literal `sluice` name has been taken since 2013 — and it forwards straight to
[`@sluice/runner`](https://www.npmjs.com/package/@sluice/runner), which is the
real CLI and is equally usable directly:

```bash
npx @sluice/runner doctor
```

Everything Sluice does happens on loopback, against traffic you already have
access to. See the main repository for the security model.

Licensed AGPL-3.0-or-later.
