<!-- SPDX-License-Identifier: Apache-2.0 -->

# @sluice/core

The shared core of [Sluice](https://claude.com/) — a local-only interceptor and
explorer for your own SaaS API traffic. This package is the part a third-party
adapter (or an embedding app) depends on, so it is Apache-2.0 rather than the
runner's AGPL.

It contains:

- **Normalized types** — `Capture`, the entity model (`Workspace`, `Container`,
  `Actor`, `Item`), `Session`, `EngineStatus`, and the rest of the domain.
- **The WebSocket protocol** — the `ServerMsg` / `ClientMsg` frames the dashboard
  and runner speak, plus the PTY frame types.
- **The capture schema** and **redaction** helpers (secrets never reach disk or
  the wire un-redacted).
- **`SqliteStore`** — the durable capture + entity store (better-sqlite3, WAL),
  with a `readOnlyStore` view for read-only consumers like the MCP server.

```ts
import { SqliteStore, redactHeaders, type Capture } from '@sluice/core';

const store = new SqliteStore('~/.sluice/sluice.db');
```

> `SqliteStore` uses the native `better-sqlite3` addon; it runs under Node, not
> in a browser.

## License

Apache-2.0.

## Interaction flows

`InteractionFlow` / `FlowTemplate` types and store APIs (`listFlows`, `pinFlow`,
`createPinnedFlow`, `listFlowTemplates`, …) back multi-step observation. Secrets
never live on flow tables; MCP/HTTP summaries stay secret-free. See
the local flow tracker under `docs/` (gitignored when present) or `docs/AUDIT-2026-08-07.md` for the public audit trail.
