# Licensing

Sluice is intentionally **split-licensed** so that the shared data model is maximally reusable while the runnable app stays copyleft.

| Part | License | Why |
|------|---------|-----|
| `packages/core` (types, normalized model, store, protocol) — and any future `adapter-sdk` | **Apache-2.0** | Permissive + explicit patent grant. Maximizes third-party adapters and lets other tools import the model without friction. |
| Everything else — `packages/interceptor`, the `sluice` runner, `apps/webapp`, and the bundled adapters | **AGPL-3.0-or-later** | Closes the network/SaaS loophole: anyone who runs a *hosted* "read your Slack" derivative must publish their source. An individual running Sluice locally has **zero** obligations. |

The repository-root [`LICENSE`](./LICENSE) is the AGPL-3.0 text (the default for the project as a whole). [`packages/core/LICENSE`](./packages/core/LICENSE) is the Apache-2.0 text and governs that package.

Each source file should carry an SPDX header, e.g.:

```ts
// SPDX-License-Identifier: AGPL-3.0-or-later   // (or Apache-2.0 in packages/core)
```

## Contributions

Contributions are accepted under the **Developer Certificate of Origin (DCO)** — sign your commits with `git commit -s` (adds a `Signed-off-by` trailer). There is **no CLA**.

## Prior art & credit

Sluice stands on existing work and credits it explicitly: `mitmproxy`, `mockttp` / HTTP Toolkit, `korotovsky/slack-mcp-server`, and the `slacktokens` approach to reading the local Slack credential. Sluice's differentiators are capturing the *live client's real traffic*, normalizing it into a cross-service model + local SQLite you can browse/search/export, and the auth-reconstruction layer.
