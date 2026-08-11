<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @sluice/runner

The `sluice` CLI and the loopback HTTP + WebSocket server behind it — the daemon
half of [Sluice](https://github.com/YasserShkeir/sluice), a local-only
interceptor and explorer for **your own** SaaS API traffic.

`src/cli.ts` dispatches 24 commands over `process.argv[2]`, each parsing its own
flags with `node:util` `parseArgs` (strict — an option a command does not declare
is an error, not a warning). Four of them bind the loopback server. As a library the package
exports only `startServer`, its option/result types, and everything from
`config.js`; the CLI entry is the `sluice` bin, which points at the bundled
`dist/cli.js`.

> Not published to npm yet. Build from a clone with `pnpm install && pnpm build`,
> then run `node packages/runner/dist/cli.js <command>`, or `pnpm sluice <command>`
> in the repo (which runs the TypeScript source through tsx).

## The server modes

| | `serve` | `start` | `capture` |
|---|---|---|---|
| Engine | MITM, **idle** until you start it | MITM, started immediately | Chrome DevTools Protocol |
| Proxy / CA needed | yes, when you start capture | yes | **no** |
| Dashboard engine control | yes (start/stop, proxy toggle) | yes | **no** — the buttons answer *"This runner does not expose engine control."* |
| Isolated child engine | `--isolated` | — (always in-process) | — |
| Extension ingest | `--ingest` | — | — |
| Embedded terminal | `--terminal` | — | — |
| Adapters allow-list applied | yes | yes | **no** — uses the full registry |
| Retention pruning at startup | yes | yes | no |
| Run-state `mode` | `serve` | `start (mitm)` | `capture (cdp)` |

`serve` is *not* a read-only viewer over past captures: it builds the same
`EngineController` and hands it to the dashboard as both `engine` and `control`.
The banner says so — *"Capture: idle — start it from the dashboard (Control), or
run `sluice start`."*

`start` is `serve` plus `controller.startEngine()`. It does **not** set the
system proxy; it prints an `open -a <App> --args --proxy-server=127.0.0.1:<port>`
instruction instead. The OS proxy is set only from the dashboard or
`sluice proxy on`. `start` also only *generates* the CA — trusting it is
`sluice ca-install`'s job alone.

`capture` launches a **dedicated** Chrome into `~/.sluice/chrome`, so you sign in
inside that fresh profile — or pass `--no-launch` to attach to a Chrome you
already started with `--remote-debugging-port`.

## Commands

Run `sluice <command> --help` for any of these. `--help` / `-h` is available
everywhere; every listed flag below is the real, complete set for that command.

### Capture

| Command | Options |
|---|---|
| `serve` | `--port`, `--proxy-port`, `--db`, `--config`, `--token`, `--cookie`, `--app-support`, `--host` (repeatable), `--all-hosts`, `--isolated`, `--ingest`, `--terminal`, `--terminal-cwd`, `--terminal-model`, `--terminal-effort`, `--terminal-mcp`, `--terminal-no-mcp`, `--terminal-skip-permissions`, `--terminal-bin` |
| `start` | `--port`, `--proxy-port`, `--db`, `--config`, `--token`, `--cookie`, `--app-support`, `--host` (repeatable), `--all-hosts` |
| `capture` | `--url`, `--cdp-port`, `--port`, `--db`, `--headless`, `--no-launch`, `--chrome-profile` (no `--config`) |
| `mock <fixture.ndjson>` | `--speed` (default 10), `--port`, `--db`, `--config`, `--loop`, `--serve` |

`--host` values are **concatenated** with `interceptHosts` from the config file,
not substituted for them.

### Environment (macOS)

| Command | Options |
|---|---|
| `doctor` | `--db`, `--net` |
| `proxy <on\|off\|status>` | `--service`, `--proxy-port` |
| `ca-install` | — |
| `ca-uninstall` | — |
| `status` | `--json`, `--db`, `--config` |
| `stop` | `--force` |

`doctor`'s only hard checks — the ones that decide the exit code — are Node ≥ 20
and a writable DB directory; everything else is an advisory warning.
`doctor --net` additionally probes `https://example.com/` and Slack's
unauthenticated `api.test` **through the local proxy**.

`ca-uninstall` deliberately does not mint a CA just to untrust one: with no CA
file it exits 1. `proxy` never spawns `sudo` — on a permission failure it prints
the exact `sudo networksetup …` commands for you to run.

### Replay

| Command | Options |
|---|---|
| `replay [actionId]` | `--action`, `--flow`, `--param k=v` (repeatable), `--adapter`, `--container`, `--all`, `--dry-run`, `--list`, `--db`, `--token`, `--cookie`, `--app-support` |
| `sync` | `--workspace`, `--db`, `--token`, `--cookie`, `--app-support` |
| `extract-token` | `--adapter`, `--token`, `--cookie`, `--app-support`, `--db` |
| `auth` | `--app`, `--json`, `--hints`, `--db`, `--config` |

`replay --all` drains the `cursors` worklist in batches of 25 claims, releasing
stale claims before and after, and stops cleanly on a `ReplayDeniedError`
(exit 0 for a spent rate budget, 1 otherwise). `sync` replays only the actions
with no required params, each session against its **own** adapter, then runs
reconcile + materialize. `extract-token` stores and prints a redacted summary
only — never the token or cookie.

### Flows

| Command | Options |
|---|---|
| `learn-flows` | `--adapter`, `--window-ms`, `--min-steps`, `--min-samples`, `--no-cluster`, `--db` |
| `flows list` | `--adapter`, `--source`, `--q`, `--db` |
| `flows templates` | `--adapter`, `--db` |
| `flows show <id>` | `--db` |
| `flows pin <id>` / `flows unpin <id>` | `--db` |
| `flows pin-captures` | `--primary`, `--capture` (repeatable), `--label`, `--adapter`, `--db` |

The lifecycle is observed → pinned → learned: `learn-flows` clusters captures
into flows and then learns templates from them; `flows pin` promotes a burst you
trust; `replay --flow <template>` runs one. `flows show` prints a raw flow as
JSON but sanitizes a **template**, reducing params to kind/name/fromStep/jsonPath
and reporting only `hasRequestTemplate: boolean`.

### Data

| Command | Options |
|---|---|
| `build-db` | `--db` |
| `apidoc` | `--host` (comma-separated substrings), `--app`, `--out`, `--db` |
| `export [containerId]` | `--container`, `--format` (`json\|ndjson\|markdown\|sqlite`), `--out`, `--all`, `--list`, `--db` |
| `record` | `--out`, `--adapter`, `--limit` (default 10000), `--since` (minutes), `--include-assets`, `--db` |
| `prune` | `--days`, `--max-rows`, `--vacuum`, `--db` |
| `wipe` | `--all`, `--yes`/`-y`, `--db` |

`prune` refuses with exit 1 when neither `--days` nor `--max-rows` is given.
`wipe` without `--yes` prints the target list and exits 1; it deletes the db plus
its `-wal`/`-shm`, and with `--all` also the CA directory and `~/.sluice/chrome`,
untrusting the CA first. `record` re-redacts on the way out even though captures
were redacted on ingest, and skips `asset`/`binary` classifications unless
`--include-assets`. The `sqlite` export writes a fresh standalone store holding
entities only.

### Apps

| Command | Options |
|---|---|
| `adapters` | `--json`, `--config` |
| `app list \| enable <id> \| disable <id>` | *(no `parseArgs` — positional only)* |

`adapters` reports hosts, credential source, replay-action count and MCP tool
names per app, and calls `installExternalAdapters()` so an external adapter's
rejection reasons are diagnosable without starting a capture. It is the fastest
smoke test for a new app.

`app enable`/`disable` writes the `adapters` array to `~/.sluice/config.json`,
and refuses to disable the last remaining app.

## Configuration

`SluiceConfig` has 10 optional keys, all JSON:

| Key | Effect |
|---|---|
| `db` | SQLite path (default `~/.sluice/sluice.db`) |
| `port` | HTTP + WS port (default 7788) |
| `proxyPort` | MITM proxy port (default 8080) |
| `cdpPort` | Chrome remote-debugging port for `capture` (default 9222) |
| `adapters` | Allow-list of adapter ids — **home config only**, see below |
| `retentionDays` | Prune captures older than this at `serve`/`start` startup |
| `maxCaptures` | Prune down to this row count at startup |
| `maxBodyBytes` | **RESERVED** — not threaded through; both engines hard-cap at 5,000,000 chars |
| `interceptHosts` | Extra hosts to TLS-terminate, on top of the adapters' declared hosts |
| `interceptAllHosts` | Decrypt every host. **Defaults to true** when omitted |

Precedence is CLI flag → config file → built-in default, and the file is read
once per process and cached.

**Lookup order:** an explicit `--config PATH` (which throws if the file is
missing), else the nearest `sluice.config.json` and then `.sluicerc.json`
walking up from the CWD to the filesystem root, else `~/.sluice/config.json`.
Nothing found anywhere yields `{}`.

**A malformed or non-object config file is a hard error** —
`Invalid config at <path>: …` — never a silent fall back to defaults. Only JSON
is supported; a `.ts` config is rejected by design, since honouring it would mean
shipping a runtime transpiler.

**Two traps.**

1. `--config` is advertised as a common option, but only six commands actually
   declare it: `serve`, `start`, `mock`, `adapters`, `status`, `auth`. Everywhere
   else it fails with `Unknown option '--config'` because `parseArgs` is strict.
   Most of the rest still *read* a discovered config file — they just cannot be
   pointed at one. Four read none at all: `proxy`, `ca-install`, `ca-uninstall`
   and `stop`. `sluice proxy on` in particular takes its port from
   `--proxy-port` or the built-in 8080, so a config file that sets `proxyPort`
   leaves the system proxy aimed where `sluice start` is not listening.
2. **The `adapters` allow-list is read from `~/.sluice/config.json` only.** The
   `configPath` argument threaded through `selectApps` is accepted for call-site
   compatibility and deliberately ignored, so a project-local
   `sluice.config.json` cannot widen or narrow the enabled apps — despite
   `SluiceConfig` declaring the key. An unknown id in that array throws at
   startup. Use `sluice app enable/disable`, which edits the home file.

### TLS scope

`resolveInterceptScope` decides what Engine A decrypts, in this order:

1. `--all-hosts`, or `interceptAllHosts: true` → **all hosts**.
2. `interceptAllHosts: false` → scoped, even with an empty host list.
3. Any `--host` / `interceptHosts` entry → scoped to the adapters' hosts plus
   those.
4. Otherwise → **all hosts**. That is the default: with no flags at all, every
   host routed through the proxy is decrypted, so services with no adapter yet
   are still captured.

A non-intercepted CONNECT is tunnelled as raw bytes — Sluice cannot read it, so
it cannot store it, which is a stronger guarantee than redaction.

## The loopback surface

`startServer` binds `127.0.0.1` and mints **up to three independent capability
secrets**, each 32 bytes of hex, each gating a different door:

| Secret | Minted | Gates |
|---|---|---|
| read token | always | the `/ws` upgrade and every `GET /api/*` |
| pty token | only with `--terminal` | the `/pty` upgrade, and nothing else |
| ingest token | only with `--ingest` | `POST /api/ingest`, and nothing else |

Tokens travel in the **URL fragment** the CLI prints (`#k=<read>` plus
`&p=<pty>`), which a browser never sends to a server. Only
`{__SLUICE_WS_PATH__, __SLUICE_PORT__}` are injected into the served document —
the read token is not. That is what makes it safe for static assets to be served
unauthenticated.

| Door | Conditions |
|---|---|
| `GET /api/*` | loopback `Host`, loopback `Origin` *if one is sent*, read token via `?token=` or `Authorization: Bearer`, compared with `timingSafeEqual`. GET only — the API is read-only and answers 405 otherwise |
| `POST /api/ingest` | loopback `Host` + the ingest secret (`Authorization: Bearer` or `X-Sluice-Ingest`). **No Origin requirement** — the poster is a `chrome-extension://` origin. 404 `ingest_disabled` without `--ingest`; 413 above 32 MiB or 500 captures |
| `/ws` upgrade | loopback `Host`, loopback `Origin` (**absent Origin allowed**, so CLIs and tests can connect), read token. Plain `GET /ws` over HTTP answers 426 |
| `/pty` upgrade | loopback `Host`, a **present** loopback `Origin` (fails closed on absence), and the separate pty secret. The read token cannot open a terminal |

Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, and a CSP whose `connect-src` is limited to `'self'` plus `ws://`
and `http://` on 127.0.0.1. Static serving has a path-traversal guard confined to
the webapp dist root, with SPA fallback to `index.html`.

**Reads over HTTP, mutations over WS.** `GET /api/*` exposes exactly: `/status`,
`/storage`, `/adapters`, `/captures`, `/captures/search`, `/captures/:id/body`,
`/captures/:id/entities`, `/sessions`, `/workspaces`, `/containers`, `/actors`,
`/items`, `/flows`, `/flow-templates`, `/apidoc`, `/tables`, `/tables/:name`.
Paging caps at 1000 (default 100), and `?ids=` at 500. `/api/tables/:name`
interpolates a table name into SQL only after an exact match against
materialized tables read live from `sqlite_master`.

The `/ws` protocol carries 13 server frame types and accepts 14 client message
types, all validated by `@sluice/protocol`'s zod schemas — an invalid frame gets
a `notice` naming the reason rather than a silent drop. `seq` is stamped on
*broadcast* frames only and counted per runner, so a filtered subscriber
legitimately sees gaps; `subscribe { sinceSeq }` either resumes from a 500-frame
ring or triggers a chunked full backfill of up to 2000 captures in 250-row
chunks. A subscribe filter scopes `capture.new` only — status, notices and the
app catalog always reach everyone.

`/pty` is a second WebSocket server entirely off the broadcast path, with
hand-validated frames. The session is **persistent**: dropping the socket
detaches the view but keeps the `claude` child alive, and a re-attaching tab is
replayed a rolling 256 KiB buffer. One viewer at a time — a new connection closes
the previous socket but keeps the same child. The launcher passes
`--strict-mcp-config` and, unless overridden, writes a temp MCP config wiring the
built `@sluice/mcp` server at this runner's store; it refuses to spawn if any
argv token looks like a permission bypass unless `--terminal-skip-permissions`
was passed explicitly.

## Ingest

All four producers — the in-process MITM engine, the isolated child engine, the
CDP engine or extension POST, and replay/sync — converge on **one** funnel:
re-redact → attribute to an adapter → classify → `insertCapture` →
`adapter.parse` → `applyParseResult` → enqueue `nextCursors` seeds → broadcast
`capture.new` + `entity.upsert`, then a 1 s-debounced app catalog and a
2 s-debounced `materialize`. Cursor seeding happens on every ingested capture
(enqueue only, never execute — draining stays behind the explicit
`sluice replay --all`).

The pause switch sits on the exported `ingest()` entry only, so live engine
traffic stops while replay and sync continue.

## macOS-only paths

Everything in `proxy.ts` calls `assertDarwin()` first. Concretely, off macOS you
lose:

- the system proxy (`/usr/sbin/networksetup`, `/sbin/route`),
- CA trust and its removal (`/usr/bin/security` against
  `~/Library/Keychains/login.keychain-db`),
- credential extraction for four of the six installed apps (Slack from Slack
  desktop's LevelDB + Keychain; Trello, Loom and LinkedIn from a Chrome profile's
  cookie DB + Keychain), which return `[]` or throw elsewhere.

Pass `--token` / `--cookie` by hand instead — though paste-in only works where the
app implements `sessionFromInput`, which today is Slack alone. The CA lives at
`~/Library/Application Support/Sluice/ca` on macOS (`~/.sluice/ca` elsewhere), and
that directory is created automatically the first time the MITM engine starts.

## Files on disk

`~/.sluice` is where the runner keeps its own state:

- `~/.sluice/sluice.db` (+ `-wal`, `-shm`) — the capture store.
- `~/.sluice/config.json` — the home config, and the only source of the
  `adapters` allow-list.
- `~/.sluice/runner.json` — run state: `{pid, port, db, mode, startedAt, proxyPort?}`.
  `status` reads it and tests liveness with `process.kill(pid, 0)`; there is no
  IPC channel between CLI invocations.
- `~/.sluice/chrome` — the dedicated Chrome profile `sluice capture` launches.

Licensed AGPL-3.0-or-later.
