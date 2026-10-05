<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @sluice/interceptor

Capture engines (MITM, CDP), rail-checked replay, flow replay, and the
process-global safety rails. The runner and MCP never open sockets for multi-step work except
through `runReplay` / `runFlowReplay`.

## F0 · Capture completeness matrix

Without complete bursts, flow learning invents structure. What each engine keeps
today (code-verified; live probe notes belong next to a real session if you add
them):

| Class | Engine A — MITM (`mitm-engine.ts`) | Engine C — CDP (`cdp-engine.ts`) | Engine C — extension (`packages/extension`) |
|---|---|---|---|
| **Scope gate** | **Default: all hosts** (TLS terminated for everything routed through the proxy) **except `NEVER_DECRYPT_HOSTS`** (AI-assistant hosts, always tunnelled; see `src/mitm-engine.ts`). Optional scope via `--host` / `interceptHosts` / `interceptAllHosts: false` → adapter `hosts[]` + extras; non-matching CONNECT is opaque tunnel (no row) | Attaches to every Chrome page target, re-discovering new/closed tabs every 2 s; no host filter at CDP layer — adapter match sets `adapterId` or null | Default-deny host allowlist in `background.js`; unconfigured = inert |
| **Remote HTTP proxy client / LAN bind** | Default listen `127.0.0.1`. `--lan-proxy` rebinds to `0.0.0.0` so a phone on this Wi-Fi can CONNECT, and only the `--lan-allow` addresses (`MitmEngineOptions.lanClients`) plus loopback are accepted — every other connection is dropped before the proxy reads it; CA at `/sluice-ca.mobileconfig` (iOS profile), `/sluice-ca.cer` and `/sluice-ca.pem` on the MITM port only when LAN. Dashboard/WS stay loopback. Not a VPN. | Desktop Chrome only | Desktop Chrome only |
| **XHR / `fetch`** | Yes (full HTTP on intercepted hosts) | Yes (`ResourceType` `XHR` \| `Fetch`) | Yes (MAIN-world patch of `fetch` + `XMLHttpRequest`) |
| **Document / HTML navigations** | Yes if on intercepted host | Captured when an installed adapter claims the host (`shouldCaptureCdpResource`); otherwise dropped | No (not patched) |
| **Scripts, CSS, images, fonts, media** | Yes if on intercepted host (can be noisy) | **Dropped** | No |
| **`navigator.sendBeacon` / Ping** | Yes if ordinary HTTP on intercepted host | **Dropped** (not XHR/Fetch) | **No** (not patched) |
| **WebSocket frames** | **Text frames only** by default (`captureWebSockets`); binary frames are dropped with no row | **Text frames only** by default (opcode 1); binary frames are dropped | **No** (documented limitation) |
| **Request body** | Always attempted; a read failure yields null rather than dropping the row | `requestWillBeSent`'s `request.postData` when Chrome supplies it, else null | String bodies only — `FormData` / `Blob` / `URLSearchParams` / `ArrayBuffer` / stream bodies are recorded as null |
| **Response body decode** | **Textual content-types only** — `json`, `text`, `xml`, `javascript`, `html`, `x-www-form-urlencoded`, `graphql`, `csv`, `+json`, or an empty content-type. Anything else (protobuf, `application/octet-stream`, grpc-web, msgpack) stores the row with `resBody: null` | Any type via `Network.getResponseBody`, base64-decoded when flagged; an evicted or opaque body yields null and the row is still emitted | Response text via `res.clone().text()`; an XHR whose `responseType` is not `''`/`text` yields an empty body |
| **Body cap** | 5,000,000 chars, with a `…[truncated N chars]` marker | Same cap and marker (request and response bodies, frames) | 512 KiB per body, clipped in `inject.js` and again in `content.js` |
| **Correlation on `Capture`** | `wsId` + `direction` for frames | `tabId`, `tabUrl`, `loaderId` (aliased to `pageLoadId`), `wsId`, `direction` | Runner sets `source: 'ext'`; tab fields depend on ingest |
| **F0.3 correlation** | none — MITM captures carry no page-load ids | CDP emits `loaderId` / `pageLoadId` when present | extension may omit |

### Design rules that matter for flows

1. **MITM defaults to full decrypt; scoping is opt-in.** With no host flags, Engine A
   terminates TLS for every host except `NEVER_DECRYPT_HOSTS`, so unknown services are
   still captured (unattributed until an adapter claims them). Once you pass `--host` or set `interceptHosts` /
   `interceptAllHosts: false`, non-listed hosts are CONNECT-tunnelled. Do not add a
   pre-store “API-shaped only” filter on Engine A without an explicit product decision.
2. **CDP keeps XHR/Fetch, plus Document only on adapter-claimed hosts.** Beacons,
   and navigations on hosts no adapter claims, will not join CDP bursts; prefer
   MITM or the extension for those clients, or accept thinner templates.
3. **Extension does not see WebSockets.** RTM/socket companions require MITM or CDP.
4. **Clustering prefers correlation ids.** `cartographer/flows.ts` keys a burst on
   `pageLoadId ?? loaderId ?? navigationId` when the capture has one (a same-document
   load is a stronger boundary than wall-clock alone), and only falls back to
   `adapterId` + `tabId`, or host family, otherwise. CDP fills those ids; MITM
   captures carry none, so MITM bursts are still time-window clustered — pin flows
   manually when that misses.

### F0.2 checklist (no silent same-host drops)

| Path | Status |
|---|---|
| MITM: matched host → store (redact on ingest) | OK — the only path filter after decrypt is `isCaDownloadPath`: `/sluice-ca.pem`, `.cer` and `.mobileconfig` are never stored, on any host |
| MITM: non-textual response body | **Same-host body drop.** The row is stored, `resBody` is null. Not a row drop, but the burst carries less than it looks like |
| MITM / CDP: binary WebSocket frames | Dropped with no row on both engines |
| CDP: type filter is XHR/Fetch, plus Document on adapter-claimed hosts | Intentional; not a silent host drop |
| CDP: `loadingFailed` | The pending exchange is deleted — a failed request produces no capture at all |
| Extension: host allowlist only | OK — default deny until configured |
| Replay / import / WS-as-primary clustering | Skipped by design in `clusterCapturesIntoFlows` |

## What's exported

`src/index.ts` is the whole public surface.

**Engines** — `MitmEngine`, `LAN_LISTEN_HOST`, `NEVER_DECRYPT_HOSTS` (the frozen
list all-hosts mode tunnels instead of decrypting; scoped mode decrypts only what
it names anyway), `CdpEngine`. Host scoping (`tlsInterceptList` in
`mitm-engine.ts`) unions every adapter's `hosts` with the extras and adds a
`*.host` wildcard for any entry that lacks one. Both engines build every Capture through `capture-build.ts`
(`redactedCapture`, which applies core's `redactCapture` — headers, bodies,
`url`, `path`, `tabUrl` and `classification`), and core's `matchAdapter` reports
and skips a `matchRequest` that throws. `--lan-proxy` clients are gated by
`MitmEngineOptions.lanClients` (loopback is always admitted).

**Chrome** — `launchDebugChrome`, `defaultChromeProfileDir`.
The launcher spawns Chrome with `--remote-debugging-port`, its own
`--user-data-dir` (default `~/.sluice/chrome`, created 0700), `--no-first-run`,
`--no-default-browser-check` and optional `--headless=new`, then polls
`/json/version` every 200 ms with a 15 s deadline. It deliberately does not pass
`--remote-allow-origins`: the CDP client sends no Origin header, and the flag
would only let web pages drive the signed-in debug browser.
Because it is a dedicated profile, you sign in *inside* that Chrome — or attach
to your own with `sluice capture --no-launch`.

**CA** — `ensureSluiceCA()` and `sluiceCaCertPath()`. The root lives at
`~/Library/Application Support/Sluice/ca` on macOS (`~/.sluice/ca` elsewhere,
created 0700) as `sluice-ca.key` (0600) and `sluice-ca.cert` (0644). `ensureSluiceCA` reuses the
pair whenever both files exist and otherwise mints one; `sluiceCaCertPath`
reports the path *without* generating anything, so callers can test for
existence without the side effect. `MitmEngine.start()` and `sluice ca-install`
share this one definition — start **generates** the CA, only `ca-install`
**trusts** it.

**Supervision** — `superviseEngine`. Probes every 5 s (the runner's
MITM probe is a TCP connect to the proxy port), allows at most 5 consecutive
restarts, and backs off 1 s / 2 s / 4 s / 8 s / 16 s (`backoffMs`). It acts only on an engine
that self-reports `running`, and a probe that throws counts as unhealthy. A
supervisor is single-use, so the controller builds a fresh one per start.

**Replay** — `runReplay` (which applies `assertReplayAllowed` and
`withReplaySlot` from `replay-policy.ts`), `replayBudget`, `ReplayDeniedError`,
and `replayWithRefresh`.
`replayWithRefresh` runs `runReplay`, and on `isAuthFailure` re-extracts the
session and runs *exactly once* more, rebuilding the request from the fresh
session and recording both attempts (failure first). It must sit **above**
`runReplay` — calling `runReplay` from inside anything `runReplay` invoked
deadlocks on the single-flight promise.

**Flow replay** — `runFlowReplay`. Pacing (`nextPaceWaitMs`, capped by
`FLOW_DELAY_CAP_MS`) and the default deadline (`DEFAULT_FLOW_TIMEOUT_MS`) live in
`flow-replay.ts`. A result's `error` and `steps[].detail` come back redacted.

**Credential forensics** — `mapAuthFlow` (correlates capture history into
issuers by evidence: `Set-Cookie` minus known analytics cookies, plus
token-shaped JSON fields, ranked by how many later requests carried what they
minted) and `reconstructCredentials` (composes an adapter's
`extractCredentialHints` with a generic scan of Authorization, Cookie,
Set-Cookie and `token=` body fields, deduped to the highest confidence per
`location:name`). Both report names, roles, counts and redacted previews —
never live values.

`sendableHeaders` is intentionally *not* exported; it is importable from
`./replay.js` for tests. It drops HTTP/2 pseudo-headers (any name starting `:`)
and any header whose value contains a code unit above 255, both of which undici
rejects with an opaque `fetch failed`.

## Rails

Independent gates sit below every caller — CLI, dashboard, sync and MCP alike.
There is no path to the network from Sluice that skips them. They are per
process: the runner, each CLI command and `sluice-mcp` each hold their own budget
and slot.

| Gate | Value | Failure |
|---|---|---|
| Method allowlist | `isReplayMethodAllowed` from `@sluice/core`: `GET`, `HEAD`, `POST` | `ReplayDeniedError` `method_not_allowed` |
| Operation denylist | `looksLikeDeniedReplay` from `@sluice/core` — the same check the flow build gate runs: path + query **and** the request body, as sent and percent-decoded, plus method-override headers and `_method` fields. A best-effort heuristic, not a proof of non-mutation | `ReplayDeniedError` `operation_not_allowed` |
| Host allowlist | `replayHostAllowed` from `@sluice/core`; `runReplay` requires `allowedHosts` (the owning app's hosts): the URL host must be one of them or a subdomain. An empty list allows nothing | `ReplayDeniedError` `host_not_allowed` |
| Rate budget | Token bucket, 60 requests per 60 s, per process | `ReplayDeniedError` `rate_budget_exhausted`, with a retry-in estimate |
| Concurrency | `withReplaySlot` — single-flight, one in-flight promise chain, kept alive on rejection so a failure cannot wedge it | serialized, never concurrent |
| Timeout | 20 s, covering the response **body** read | throws `replay request failed: <redacted>` |
| Body cap | 5,000,000 chars before redaction | truncated |
| Redirects | Never followed (`redirect: 'manual'`); the rails checked only the original URL | the 3xx itself is the capture, `Location` redacted |

Any HTTP status, including 4xx and 5xx, comes back as a `Capture` with
`source: 'replay'` and `adapterId: null` — only a network-level failure throws.
Attribution is the caller's job.

Flow steps add build-time rails on top of the same runtime gates:
`flowStepBuilder(template, app)` enforces the owning adapter's declared hosts
(the same core matcher), refuses a non-GET/HEAD step that matches none of the
adapter's replay actions, and raises `path_unresolved` when a placeholder
survives into the assembled URL or a path value is `.` / `..`. Each step charges its own budget token,
inter-step waits are capped at 2 s, and the whole flow times out at 120 s. An
auth failure on any step stops the flow and triggers exactly one whole-flow
restart after a credential refresh.

### Related

- Single-request fidelity: `packages/cartographer/src/faithful.ts`
- Multi-step learn/run: `flow-learn.ts`, `flow-build.ts`, `flow-replay.ts`
- Rails: `replay-policy.ts` (method, operation denylist, host allowlist, budget)
