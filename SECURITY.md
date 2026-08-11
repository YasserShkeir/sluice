# Security & Privacy

Sluice reads a credential equivalent to a live, logged-in session. The security design **is** the product. This document is the honest version of the caveats — it is deliberately not buried.

## What Sluice does and doesn't do

- **Reads your already-authenticated session on your own machine.** It injects nothing into the target service; it only sees what that session can already see.
- **100% local. No telemetry, no cloud, ever.** Outbound traffic is your own client's (through the proxy) and, optionally, replay calls to the *same* service you're already talking to. Two documented exceptions: `sluice doctor --net` makes two diagnostic probes through the local proxy (a round-trip to `https://example.com/` and a TLS-pinning check against `https://slack.com/api/api.test`, Slack's unauthenticated no-op), and an app's own MCP tool may fetch from that service's CDN — Fast.com's `fast_speed_test` downloads range files from `*.nflxvideo.net`, Loom's `loom_get_transcript` follows a signed captions URL on `cdn.loom.com`. Nothing is ever sent to a Sluice-operated endpoint, because there isn't one.
- **Surfaces only what it actually observed.** Every normalized entity records the capture bytes it came from.

## Things to know before using

- **Session tokens vs supported APIs.** A *session* token (e.g. Slack's `xoxc`) is the same class of credential a browser extension would use on a logged-in tab. Prefer a workspace-issued API token when one is available.
- **Credential sensitivity.** A session token **plus** its session cookie together equal a logged-in session — treat both as highly sensitive until the session is revoked. That is exactly why Sluice keeps them in memory and never writes or transmits them.
- **Operational effects.** Rate-limiting and session invalidation can still happen; local storage of captures does not hide requests from the service's own logs.
- **Workplace policy.** Check any workplace rules that apply to how you access company tools on your machine.
- **You own the output.** An export is your workspace's content; treat it with the same sensitivity as the workspace itself.

## Defensive posture (enforced, not aspirational)

- **Secrets in memory only.** The session token + cookie exist only in memory, for the lifetime of whichever Sluice process extracted them — the runner, a one-shot CLI command (`sluice replay`, `sluice sync`, `sluice extract-token`), or the separate `sluice-mcp` server process, which cold-start-extracts a session itself and re-extracts on auth failure. They are **never** written to SQLite, logged, or streamed over the WebSocket. See the honest limit on zeroing below.
- **Central redactor on every sink.** `redactHeaders` / `redactText` / `redactUrl` (in `@sluice/core`) run *before* a capture reaches the store, the logs, or the UI. The generic policy masks four header names exactly — `authorization`, `cookie`, `set-cookie`, `proxy-authorization` — plus **any header whose name looks credential-shaped**, via a regex over `api-key` / `auth` / `token` / `secret` / `session` / `signature` / `csrf` / `xsrf` / `password` / `credential` (this is what catches `x-api-key`, `x-csrf-token`, `x-amz-security-token`). It also masks `Bearer …` values and the value after a `token=` / `access_token:` / `client_secret=` style field name. `set-cookie` is in that list deliberately: it is how a session is minted in the first place.
- **Apps contribute token shapes — and can also exempt a param.** Each installed app registers its own patterns at import time: Slack registers the whole `xox[abcdeprs]-` token family plus the headers `x-slack-auth` and `x-slack-session`; Gmail registers `x-framework-xsrf-token`. Note the capability in the other direction: `AppRedaction.publicParams` lets an app declare that a named query param on named hosts is **public and must survive redaction**. Fast.com uses it (`token` on `fast.com` / `nflxvideo.net`) because the generic `token=` rule would otherwise destroy the speedtest token and make the capture unreplayable. Widening what survives redaction is a real capability — review it when adding or installing an app.
- **The store has nowhere to put a secret.** There is deliberately no credentials table; only a redacted session descriptor (names of credential kinds, never values) is persisted.
- **Loopback, plus three separate capability secrets.** The server binds `127.0.0.1` and mints up to three independent 32-byte per-run secrets. Holding one does not grant the others:
  - the **read token**, always minted, gates every `GET /api/*` and the `/ws` upgrade;
  - a **pty token**, minted only with `--terminal`, gates `/pty` and nothing else;
  - an **ingest token**, minted only with `--ingest`, gates `POST /api/ingest` and nothing else.

  Each door has its own gate condition, and the differences are deliberate:
  - `GET /api/*` — loopback `Host` with the exact port, a loopback `Origin` *when one is sent*, and the read token (`?token=` or `Authorization: Bearer`), compared with `timingSafeEqual`. Non-GET is `405`; the HTTP API is read-only and all mutations go over the WebSocket.
  - `/ws` upgrade — the same, except an **absent** `Origin` is tolerated so CLIs and tests can connect.
  - `/pty` upgrade — strictest: it **fails closed on a missing `Origin`** and requires the separate pty secret. The read token cannot open a terminal.
  - `POST /api/ingest` — loopback `Host` + the ingest secret, and **no `Origin` check at all**, because the poster is a browser extension with a `chrome-extension://` origin. This is the only non-GET route on the server.
  - **static assets are unauthenticated** and carry no secret.

  That last point is safe only because of the delivery model: the read token is **never injected into any served page** (only `__SLUICE_WS_PATH__` and `__SLUICE_PORT__` are). It travels in the URL fragment `#k=<token>` (plus `&p=<ptyToken>`), which browsers never send to a server; the dashboard moves both into `sessionStorage` and strips the hash with `history.replaceState`. The CLI banner is the only place a token is printed. Pages are served with a strict `Content-Security-Policy` whose `connect-src` permits only `self` plus loopback, along with `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- **Replay is read-only.** Replays are checked below every caller (CLI, web UI, MCP): only GET, HEAD and POST are allowed, a denylist covers write/admin operations (`chat.postMessage`, `admin.*`, `files.upload`, GraphQL `mutation`, …) matched against the path, query and body, and a process-global budget of 60 requests per 60 seconds plus single-flight concurrency bounds traffic volume. The same rails apply per step of a multi-step flow replay. A modified frontend cannot route around this.
- **Generating the CA is automatic; trusting it is not.** The key/cert pair is written the first time the MITM engine starts — no command, no prompt — to `~/Library/Application Support/Sluice/ca` as `sluice-ca.key` (mode 0600) and `sluice-ca.cert` (0644). So starting capture from the dashboard mints a private CA key on disk before you have typed anything. Making the system **trust** it is the separate, deliberate, one-command step: `sluice ca-install` adds it to your login keychain and `sluice ca-uninstall` removes it (uninstall will not mint a CA just to untrust one — it exits with an error if none exists). `sluice wipe` removes the capture DB; `sluice wipe --all` also untrusts and removes the CA and the dedicated Chrome profile.

## Known limits (what is NOT guaranteed)

Being straight about these matters more than the marketing value of omitting them.

- **Secrets are not reliably zeroed.** Credentials are held as ordinary JavaScript strings, which cannot be wiped: V8 copies them during GC and we cannot `mlock` the heap. Only the macOS Keychain passphrase `Buffer` is explicitly zeroed after use — and even that is preceded by an unzeroable string copy. Treat "in memory only" as "never persisted", not as "unrecoverable from process memory". A memory dump of a running Sluice can yield your session.
- **Redaction is best-effort pattern matching.** It masks known header names, credential-shaped values, and each app's registered token shapes. A novel secret format under an unrecognised field name can still reach the local store. The store is local and unshared, so the impact is limited to your own disk — but review before exporting or sharing anything.
- **The MITM engine decrypts every host by default** while it is running, not only the hosts an adapter claims. Unrelated tabs and apps on the same proxy path are redacted and stored unless you scope with `--host` / `interceptHosts` or set `interceptAllHosts: false`. Keep proxy sessions short, and prefer `sluice capture` (browser CDP, no proxy and no CA) when it is sufficient.
- **Nothing expires by default.** Capture is retained until you remove it. Set `retentionDays` and/or `maxCaptures` in `sluice.config.json` (or `~/.sluice/config.json`) and the runner prunes at every `serve` and `start`, printing what it removed. Those two keys are the settings that most directly bound your exposure. Without them, use `sluice prune --days N` / `--max-rows N` or `sluice wipe`.

### Data at rest is plaintext

`~/.sluice/sluice.db` holds up to **5 MB of response body per capture, in plaintext**. There is no encryption and no file-mode hardening: Sluice creates the parent directory and nothing calls `chmod`, so the database inherits your umask. Bodies over 2048 characters are gzip-compressed, which is a size optimisation and **not** protection.

The plaintext body is additionally tokenized into the `captures_fts` FTS5 index at insert time. The index is contentless, so there is no second full copy of the body — but the terms are derived from the plaintext, which means a secret the redactor missed is not merely stored, it is **searchable**.

Wiping from the dashboard deletes every row and then runs `VACUUM`; a plain delete or `sluice prune` does not, unless you pass `--vacuum`. Until a VACUUM runs, the freed pages still hold the old bytes in the same file. The CLI's `sluice wipe` sidesteps this by deleting `sluice.db` along with its `-wal` and `-shm` files outright.

### The embedded terminal (`sluice serve --terminal`)

This is the largest local-privilege surface in the product, and it is **off unless you pass the flag**. With it, the runner spawns a real `claude` child process that inherits your environment and can run arbitrary commands on your machine. Anything that can reach `/pty` gets that.

What is enforced:

- **Its own secret, behind the strictest gate.** `/pty` needs the separate pty token — the dashboard's read token cannot open a terminal — and it **fails closed on a missing `Origin`**, unlike `/ws`.
- **No shell.** One binary (`claude`) is launched with a fixed argv. There is no `sh -c` anywhere in the path.
- **No Sluice secret on argv or in the environment.** The child also starts clean: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT` and every `CLAUDE_CODE_*` variable are stripped so it begins as a fresh top-level session, and `--strict-mcp-config` means only the Sluice MCP server Sluice itself wired up is loaded.
- **Permission bypass is refused by default.** `assertNoBypass` will not spawn if any argv token contains `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` or `bypasspermissions`. That audit is lifted only when the operator explicitly passes `--terminal-skip-permissions`.

What to know anyway: the session is **persistent**. Closing the tab detaches the view but keeps the child process alive, and a re-attaching tab is replayed a rolling 256 KiB of prior output. Only one viewer at a time — a new `/pty` connection closes the previous socket but keeps the same child. The process dies only on an explicit end frame, on `claude` exiting, or when the server stops.

### The browser extension ingest path (`sluice serve --ingest`)

`POST /api/ingest` is the only non-GET route on the server and the only way capture data enters the store from another process. It exists so the MV3 extension can capture in a normal browser profile with no proxy and no CA. It is **off unless you pass the flag** — without it the route answers `404 ingest_disabled`.

On the runner side: it requires its own ingest secret and a loopback `Host`, and performs **no `Origin` check**, because the poster's origin is `chrome-extension://`. Batches are capped at 32 MiB of body and 500 captures (`413` beyond). It honours the pause switch — while paused it replies `{ ingested: 0, paused: true }` and writes nothing. Ingested exchanges are normalized, then run through the **same** `sanitizeCapture` redaction funnel as proxy traffic; the normalizer itself does not redact, so that funnel is the whole of the protection.

On the extension side: the host allowlist is **default-deny** — an empty list captures nothing — and the extension is inert until an endpoint, a token and at least one host are all configured. It refuses any non-loopback endpoint. Bodies are clipped at 512 KiB in both the MAIN-world patch and the ISOLATED-world bridge. A failed POST **drops the batch rather than retrying**, because a service worker can be suspended at any moment and an unbounded queue is worse than a gap. It sees `fetch` and `XHR` only: no WebSockets, no document navigations.

## Reporting a vulnerability

Please open a **private security advisory** on the repository (GitHub → Security → Report a vulnerability) rather than a public issue. If that's unavailable, contact the maintainer directly. We'll acknowledge and triage before any public disclosure.
