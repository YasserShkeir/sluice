<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Scope and limits

What Sluice will and will not be built to do. These are standing decisions, not a
backlog — they are recorded here so they read as choices rather than as things
nobody got around to.


## Replay is read-only, enforced below every caller

Three independent gates, all in `packages/interceptor/src/replay-policy.ts` and
`packages/core/src/replay-deny.ts`:

1. **Method** — `GET`, `HEAD`, `POST` only. Everything else is refused outright.
2. **Operation** — 12 denylist patterns matched against the path, the query string
   *and* the request body, because a service can legitimately `POST` for a read.
3. **Budget** — a process-global 60-requests-per-60-seconds token bucket with
   single-flight serialization, shared by the CLI, the dashboard, sync and every
   MCP tool.

They sit below the CLI, the WebSocket server and the MCP server, so a modified
frontend or a creative tool argument cannot route around them. Every step of a
multi-step flow pays all three again.

There is no configuration flag to disable any of this, deliberately.

## Sluice does not modify traffic

The MITM engine is read-only passthrough. No breakpoints, no request rewriting, no
response stubbing, no injection. This is the main capability Sluice gives up
relative to a debugging proxy, and it is given up on purpose: a tool that can
alter traffic in flight has a materially different threat model, and this one is
already asking for enough trust.

## Sluice only reads accounts already signed in on this machine

There is no login flow and no way to supply someone else's credentials. It reads
what your OS already holds for you. Whether using it is permitted is between you
and whoever operates the service — check your workplace policy, and prefer a
workspace-issued API token whenever one is actually available.

## What is not decided

These are open, not refused: Windows and Linux credential extraction, adapters for
services the maintainer has no account with, and semantic search over stored
items. See the repository issues.
