<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Scope and limits

What Sluice will and will not be built to do. These are standing decisions, not a
backlog — they are recorded here so they read as choices rather than as things
nobody got around to.


## Replay is for reads, behind rails below every caller

Replay is meant to read. What enforces that is a set of best-effort rails, not a
proof that an allowed request cannot change anything. They live in
`packages/core/src/replay-deny.ts` and `packages/interceptor/src/replay-policy.ts`:

1. **Method** — `GET`, `HEAD`, `POST` only. Everything else is refused outright.
2. **Operation** — a heuristic denylist of write/admin operations matched against
   the path, the query string *and* the request body, both as sent and
   percent-decoded, because a service can legitimately `POST` for a read. A
   method-override header or `_method` field naming anything but `GET`/`HEAD` is
   refused too.
3. **Host** — the URL's host must be one of the owning app's declared hosts (or
   a subdomain of one). Redirects are never followed; a `3xx` comes back as the
   result.
4. **Budget** — a 60-requests-per-60-seconds token bucket with single-flight
   serialization. It is **per process**: the runner, each CLI command and the
   MCP server each have their own bucket, so it bounds one process's traffic,
   not your account's.

They sit below the CLI, the WebSocket server and the MCP server, so a modified
frontend or a creative tool argument cannot route around them. Every step of a
multi-step flow pays all four again, and a flow step that is not a `GET`/`HEAD`
is built only when it matches one of the app's own reviewed replay actions.

The denylist cannot name every write a service has. It is a guard against the
obvious mistakes, and the reason replay goes out as your real session is exactly
why it deserves care.

There is no configuration flag to disable any of this, deliberately.

## Sluice does not modify traffic

The MITM engine is read-only passthrough. No breakpoints, no request rewriting, no
response stubbing, no injection. This is the main capability Sluice gives up
relative to a debugging proxy, and it is given up on purpose: a tool that can
alter traffic in flight has a materially different threat model, and this one is
already asking for enough trust.

Engine A listens on loopback by default. `--lan-proxy` is the only opt-in LAN
bind (`0.0.0.0`) so a phone on this Wi-Fi can use the proxy, and it requires
`--lan-allow <phone IP>`: every other device on the network is refused. The
dashboard, WS, and MCP stay on `127.0.0.1`. That flag does not change passthrough.

In its default all-hosts mode the MITM engine never decrypts AI-assistant hosts
(Anthropic, OpenAI, GitHub Copilot and their subdomains; full list in
[SECURITY.md](../../SECURITY.md)): those connections are tunnelled as raw TLS and
never stored. Naming one with `--host` is a deliberate opt-in.

## Sluice only reads accounts already signed in on this machine

There is no login flow and no way to supply someone else's credentials. It reads
what your OS already holds for you. Whether using it is permitted is between you
and whoever operates the service — check your workplace policy, and prefer a
workspace-issued API token whenever one is actually available.

## What is not decided

These are open, not refused: Windows and Linux credential extraction, adapters for
services the maintainer has no account with, and semantic search over stored
items. See the repository issues.
