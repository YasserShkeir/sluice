<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @sluice/interceptor

Capture engines (MITM, CDP), read-only replay, flow replay, and the process-global
safety rails. The runner and MCP never open sockets for multi-step work except
through `runReplay` / `runFlowReplay`.

## F0 · Capture completeness matrix

Without complete bursts, flow learning invents structure. What each engine keeps
today (code-verified; live probe notes belong next to a real session if you add
them):

| Class | Engine A — MITM (`mitm-engine.ts`) | Engine C — CDP (`cdp-engine.ts`) | Engine C — extension (`packages/extension`) |
|---|---|---|---|
| **Scope gate** | **Default: all hosts** (TLS terminated for everything routed through the proxy). Optional scope via `--host` / `interceptHosts` / `interceptAllHosts: false` → adapter `hosts[]` + extras; non-matching CONNECT is opaque tunnel (no row) | Attaches to Chrome page targets; no host filter at CDP layer — adapter match sets `adapterId` or null | Default-deny host allowlist in `background.js`; unconfigured = inert |
| **XHR / `fetch`** | Yes (full HTTP on intercepted hosts) | Yes only (`ResourceType` `XHR` \| `Fetch`) | Yes (MAIN-world patch of `fetch` + `XMLHttpRequest`) |
| **Document / HTML navigations** | Yes if on intercepted host | **Dropped** (not XHR/Fetch) | No (not patched) |
| **Scripts, CSS, images, fonts, media** | Yes if on intercepted host (can be noisy) | **Dropped** | No |
| **`navigator.sendBeacon` / Ping** | Yes if ordinary HTTP on intercepted host | **Dropped** (not XHR/Fetch) | **No** (not patched) |
| **WebSocket frames** | Yes by default (`captureWebSockets`) | Yes by default | **No** (documented limitation) |
| **Opaque / no-cors bodies** | Headers + status when visible; body may be empty | Emit capture; body null if unreadable | Skip unreadable clone |
| **Correlation on `Capture`** | `wsId` + `direction` for frames | `tabId`, `tabUrl`, `wsId`, `direction` | Runner sets `source: 'ext'`; tab fields depend on ingest |
| **F0.3 correlation** | optional (engine-dependent) | CDP emits `loaderId` / `pageLoadId` / `navigationId` when present | extension may omit |

### Design rules that matter for flows

1. **MITM defaults to full decrypt; scoping is opt-in.** With no host flags, Engine A
   terminates TLS for every host so unknown services are still captured (unattributed
   until an adapter claims them). Once you pass `--host` or set `interceptHosts` /
   `interceptAllHosts: false`, non-listed hosts are CONNECT-tunnelled. Do not add a
   pre-store “API-shaped only” filter on Engine A without an explicit product decision.
2. **CDP deliberately drops non-XHR/Fetch.** Companions that only appear as
   document navigations or beacons will not join CDP bursts; prefer MITM or the
   extension for those clients, or accept thinner templates.
3. **Extension does not see WebSockets.** RTM/socket companions require MITM or CDP.
4. **Clustering today** (`cartographer/flows.ts`) uses `adapterId` + `tabId` (when
   present) or host family, split on wall-clock gaps. CDP correlation ids
   tighten this; until then, pin flows manually when heuristics miss.

### F0.2 checklist (no silent same-host drops)

| Path | Status |
|---|---|
| MITM: matched host → store (redact on ingest) | OK — no path filter after decrypt |
| CDP: only type filter is XHR/Fetch | Intentional; not a silent host drop |
| Extension: host allowlist only | OK — default deny until configured |
| Replay / import / WS-as-primary clustering | Skipped by design in `clusterCapturesIntoFlows` |

### Related

- Single-request fidelity: `packages/cartographer/src/faithful.ts`
- Multi-step learn/run: `flow-learn.ts`, `flow-build.ts`, `flow-replay.ts`
- Rails: `replay-policy.ts` (method, operation denylist, budget)
