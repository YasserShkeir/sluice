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
- **Central redactor on every sink.** `redactHeaders` / `redactText` / `redactUrl` / `redactCaptureUrls` (in `@sluice/core`) run *before* a capture reaches the store, the logs, or the UI — every capture path goes through core's `persistCapture` funnel, which redacts headers, bodies and every URL-like field (`url`, `path`, `tabUrl`, `classification`). The generic policy:
  - masks four header names exactly — `authorization`, `cookie`, `set-cookie`, `proxy-authorization` — plus **any header whose name looks credential-shaped**, via a regex over `api-key` / `auth` / `token` / `secret` / `session` / `signature` / `csrf` / `xsrf` / `password` / `credential` (this is what catches `x-api-key`, `x-csrf-token`, `x-amz-security-token`). `set-cookie` is in that list deliberately: it is how a session is minted in the first place;
  - masks `Bearer …` values and the value of any body field whose name **ends in** a credential word (`token`, `secret`, `password`, `passphrase`, `api_key`, `private_key`, `session_id`, `csrf`, `xsrf`, `jwt`, …), so `id_token`, `auth_token`, `authToken` and `x-csrf-token` are covered in `k=v`, JSON, escaped-JSON and percent-encoded forms. Pagination cursors (`nextPageToken`, `page_token`, `syncToken`, …) are deliberately left alone;
  - masks credential **value shapes** wherever they appear: PEM private keys, JWTs, Anthropic / OpenAI / Stripe / Google / AWS / GitHub / Slack key and token formats, and `multipart/form-data` parts named like a credential;
  - masks the query-shaped params `code`, `sig`, `signature`, `session`, `X-Amz-Signature` / `X-Amz-Credential` and `X-Goog-Signature` / `X-Goog-Credential` (`?name=` / `&name=` / `#name=` / `;name=`, values of 8+ characters) wherever they appear: URLs, header values such as `Location` and `Referer`, bodies and classifications. They are too generic to mask as bare field names.
- **Apps contribute token shapes — and can also exempt a param.** Each installed app registers its own patterns at import time: Slack registers the whole `xox[abcdeprs]-` token family plus the headers `x-slack-auth` and `x-slack-session`; Gmail registers `x-framework-xsrf-token`. Note the capability in the other direction: `AppRedaction.publicParams` lets an app declare that a named query param on named hosts is **public and must survive redaction**. Fast.com uses it (`token` on `fast.com` / `nflxvideo.net`) because the generic `token=` rule would otherwise destroy the speedtest token and make the capture unreplayable. Widening what survives redaction is a real capability — review it when adding or installing an app.
- **The store has nowhere to put a secret.** There is deliberately no credentials table; only a redacted session descriptor (names of credential kinds, never values) is persisted.
- **Loopback, plus three separate capability secrets.** The server binds `127.0.0.1` and mints up to three independent 32-byte per-run secrets. Holding one does not grant the others:
  - the **session token**, always minted, gates every `GET /api/*` and the `/ws` upgrade. It is **full dashboard control**, not a read token: reads, replay and flows against your live accounts, sync, engine and system-proxy control, and every `data.*` operation including wipe. Treat a leak of it as exactly that;
  - a **pty token**, minted only with `--terminal`, gates `/pty` and nothing else;
  - an **ingest token**, minted only with `--ingest`, gates `POST /api/ingest` and nothing else.

  Each door has its own gate condition, and the differences are deliberate:
  - `GET /api/*` — loopback `Host` with the exact port, an `Origin` *when one is sent* that is the runner's own (`http://127.0.0.1|localhost|[::1]:<port>`) or the pinned dev UI's (`:5273`) — any other local port is refused — and the session token (`Authorization: Bearer`, which the dashboard sends, or `?token=`), compared with `timingSafeEqual`. Non-GET is `405`; the HTTP API only reads, and every mutation goes over the WebSocket.
  - `/ws` upgrade — the same, except an **absent** `Origin` is tolerated so CLIs and tests can connect.
  - `/pty` upgrade — strictest: it **fails closed on a missing `Origin`** and requires the separate pty secret. The session token cannot open a terminal.
  - `POST /api/ingest` — loopback `Host` + the ingest secret, and **no `Origin` check at all**, because the poster is a browser extension with a `chrome-extension://` origin. This is the only non-GET route on the server.
  - **static assets are unauthenticated** and carry no secret.

  That last point is safe only because of the delivery model: the session token is **never injected into any served page** (only `__SLUICE_WS_PATH__` and `__SLUICE_PORT__` are). It travels in the URL fragment `#k=<token>` (plus `&p=<ptyToken>`), which browsers never send to a server; the dashboard moves both into `sessionStorage` and strips the hash with `history.replaceState`. The CLI banner is the only place a token is printed, and only to a terminal: when stdout is redirected (a background launch's `runner.log`), the tokens are masked there and the full lines go to the controlling terminal instead. Pages are served with a strict `Content-Security-Policy` whose `connect-src` permits only `self` plus loopback, along with `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- **Replay is for reads, behind best-effort rails.** Replays are checked below every caller (CLI, web UI, MCP): only GET, HEAD and POST are allowed; a heuristic denylist covers write/admin operations (`chat.postMessage`, `admin.*`, `files.upload`, read receipts, GraphQL `mutation`, …) matched against the path, query and body as sent and percent-decoded, along with method-override headers and `_method` fields; the URL's host must be one of the owning app's declared hosts; redirects are never followed; and a budget of 60 requests per 60 seconds plus single-flight concurrency bounds traffic volume. The same rails apply per step of a multi-step flow replay, where a step that is not GET/HEAD must also match one of the app's own reviewed replay actions. A modified frontend cannot route around this — but these rails are heuristics, **not a proof that an allowed request does not mutate**. The budget is per process (the runner, each CLI command and `sluice-mcp` each have their own), not per account.
- **Some hosts are never decrypted.** In its default all-hosts mode the MITM engine tunnels the AI-assistant and coding-agent hosts listed in `NEVER_DECRYPT_HOSTS` (`packages/interceptor/src/mitm-engine.ts`, the single source of truth) and their subdomains as raw TLS, so those tokens are never decrypted or stored. Scoped mode (`--host` / `interceptAllHosts: false`) decrypts only what you name, so an explicit `--host` for one of them is a deliberate opt-in. Captures stored before this rule may still hold such traffic: delete them and rotate those tokens.
- **Paste-in credentials go to one app.** `--token` / `--cookie` build a session for exactly one app (`--adapter`, default `slack`), never offered to every provider. Prefer `SLUICE_TOKEN` / `SLUICE_COOKIE` or `--token -` (stdin): a literal argv value is visible to other local users in `ps` and lands in shell history.
- **Generating the CA is automatic; trusting it is not.** The key/cert pair is written the first time the MITM engine starts — no command, no prompt — to `~/Library/Application Support/Sluice/ca` as `sluice-ca.key` (mode 0600) and `sluice-ca.cert` (0644). So starting capture from the dashboard mints a private CA key on disk before you have typed anything. Making the system **trust** it is the separate, deliberate, one-command step: `sluice ca-install` adds it to your login keychain and `sluice ca-uninstall` removes it (uninstall will not mint a CA just to untrust one — it exits with an error if none exists). `sluice wipe` removes the capture DB; `sluice wipe --all` also untrusts and removes the CA and the dedicated Chrome profile.

## Known limits (what is NOT guaranteed)

Being straight about these matters more than the marketing value of omitting them.

- **Keychain prompts: click Allow, not Always Allow.** Local credential extraction reads Chrome's (and Slack's) Safe Storage key through `/usr/bin/security`, which raises a Keychain prompt. **Always Allow** adds `security` itself to that item's access list, so every process on your account could then read it without asking. Click **Allow**; the CLI prints this reminder before it extracts.
- **Secrets are not reliably zeroed.** Credentials are held as ordinary JavaScript strings, which cannot be wiped: V8 copies them during GC and we cannot `mlock` the heap. Only the macOS Keychain passphrase `Buffer` is explicitly zeroed after use — and even that is preceded by an unzeroable string copy. Treat "in memory only" as "never persisted", not as "unrecoverable from process memory". A memory dump of a running Sluice can yield your session.
- **Redaction is best-effort pattern matching.** It masks known header names, credential-shaped values, and each app's registered token shapes. A novel secret format under an unrecognised field name can still reach the local store. The store is local and unshared, so the impact is limited to your own disk — but review before exporting or sharing anything.
- **The MITM engine decrypts every host by default** while it is running (except the never-decrypt hosts above), not only the hosts an adapter claims. Unrelated tabs and apps on the same proxy path are redacted and stored unless you scope with `--host` / `interceptHosts` or set `interceptAllHosts: false`. Keep proxy sessions short, and prefer `sluice capture` (browser CDP, no proxy and no CA) when it is sufficient.
- **Credential store copies touch disk briefly.** Reading Slack's LevelDB and a Chromium `Cookies` database copies them into a private (0700) directory under `$TMPDIR`, deleted when the read ends. A process killed mid-read cannot delete its copy — and a Slack LevelDB copy holds every workspace's token in plaintext — so each read, the runner and `sluice-mcp` sweep stale `sluice-ldb-*` / `sluice-cookies-*` copies older than ten minutes at startup.
- **Nothing expires by default.** Capture is retained until you remove it. Set `retentionDays` and/or `maxCaptures` in `sluice.config.json` (or `~/.sluice/config.json`) and the runner prunes at every `serve` and `start`, printing what it removed. Those two keys are the settings that most directly bound your exposure. Without them, use `sluice prune --days N` / `--max-rows N` or `sluice wipe`.

### The MITM proxy on the LAN (`--lan-proxy`)

By default the proxy binds `127.0.0.1`: mockttp's `start(port)` listens on every
interface, so Sluice immediately rebinds that listener to loopback, and a failed
rebind stops the proxy rather than leaving it on every interface.

`--lan-proxy` is the one opt-in LAN bind (`0.0.0.0`), for a phone on this Wi-Fi.
The proxy has **no authentication**, so it also requires `--lan-allow <phone IP>`
(repeatable): a connection from any other non-loopback address is dropped before
the proxy reads a byte of it. What remains while it runs:

- **An allowed device can use your machine as a proxy.** Its traffic leaves from
  your IP, is decrypted when the device trusts the Sluice CA, and is written
  into *your* store. An IP address is not an identity — on a network where
  someone can take over the phone's address, they get the same access. Use it
  only on a network you trust, and stop capture as soon as the phone is done.
- **It is a path to the loopback API.** A request sent *through* the proxy to
  `127.0.0.1:<port>` arrives at the server looking local, so the loopback `Host`
  check passes. What still stops it is the session token, which is required for
  every `GET /api/*` and the `/ws` upgrade and compared in constant time. This
  is the same shape as mitmproxy's CVE-2025-23217.
- **The system proxy is refused.** With `--lan-proxy` the runner will not point
  this Mac's system proxy at the LAN listener. `sluice proxy off` clears only a
  proxy Sluice set (pass `--force` to clear another), and `sluice proxy on` will
  not replace a proxy something else configured.

### The extension's host allowlist is a client-side promise

The MV3 extension is default-deny and captures nothing until you name hosts. That
check lives **only in the extension**; the server does not re-check scope against
the installed adapters. So the guarantee "capturing my Slack will not ship my
bank" holds only as long as the client is the one you installed — anything else
holding the ingest token can post captures for any host, and Sluice will store
them.

What the server does enforce on `POST /api/ingest`: it mints every capture id
itself (a post cannot overwrite an existing row), derives `host` and `path` only
from an absolute `http(s)` URL (a post cannot claim `slack.com` for another
host's traffic, and relative or non-http(s) URLs are dropped), clamps a future
timestamp to now, and redacts every field — URL-like ones included — through the
same funnel as proxy traffic.

In the extension, `content.js` forwards only the nine fields the page-side patch
emits, and `background.js` requires **both** the browser-reported sender frame
(`sender.origin ?? sender.url`) and the request URL to be on the allowlist. The
remaining risk is structural: capture runs in the page's own (MAIN) world, which
cannot be authenticated, so script on an in-scope page — including third-party
script it loads, or any subdomain of a listed host — can still forge in-scope
captures.

The ingest token is write-only and gates nothing else, so the blast radius is
"false records in your own store" rather than disclosure. Still, the honest
framing is that scope is enforced at the client end.

### Data at rest is plaintext

`~/.sluice/sluice.db` holds up to **5 MB of response body per capture, in plaintext**. There is no encryption. What there is, is owner-only file modes: the runner creates `~/.sluice` as `0700` and tightens an existing looser one, writes `runner.json` and `config.json` as `0600`, and every store open strips group/other bits from the database and its `-wal` / `-shm` files (a missing parent directory is created `0700`). Modes are only ever narrowed, never loosened, and not managed on Windows. A `runner.log` written by an older version can hold banner tokens from before they were masked — delete it. Bodies over 2048 characters are gzip-compressed, which is a size optimisation and **not** protection.

The dashboard's list and WebSocket views carry at most 64 KiB of each body; the full body is fetched by id, on demand, from `/api/captures/:id/body`.

`sluice export --out` and `sluice record --out` warn when they write captured data inside a Git worktree at a path Git does not ignore, where it could be committed or indexed.

The plaintext body is additionally tokenized into the `captures_fts` FTS5 index at insert time. The index is contentless, so there is no second full copy of the body — but the terms are derived from the plaintext, which means a secret the redactor missed is not merely stored, it is **searchable**.

Wiping from the dashboard deletes every row and then runs `VACUUM`; a plain delete or `sluice prune` does not, unless you pass `--vacuum`. Until a VACUUM runs, the freed pages still hold the old bytes in the same file. The CLI's `sluice wipe` sidesteps this by deleting `sluice.db` along with its `-wal` and `-shm` files outright.

### The embedded terminal (`sluice serve --terminal`)

This is the largest local-privilege surface in the product, and it is **off unless you pass the flag**. With it, the runner spawns a real `claude` child process that inherits your environment and can run arbitrary commands on your machine. Anything that can reach `/pty` gets that.

What is enforced:

- **Its own secret, behind the strictest gate.** `/pty` needs the separate pty token — the dashboard's session token cannot open a terminal — and it **fails closed on a missing `Origin`**, unlike `/ws`.
- **No shell.** One binary (`claude`) is launched with a fixed argv. There is no `sh -c` anywhere in the path.
- **No Sluice secret on argv or in the environment.** The child also starts clean: `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT` and every `CLAUDE_CODE_*` variable are stripped so it begins as a fresh top-level session, and `--strict-mcp-config` means only the Sluice MCP server Sluice itself wired up is loaded.
- **Permission bypass is refused by default.** `assertNoBypass` will not spawn if any argv token contains `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` or `bypasspermissions`. That audit is lifted only when the operator explicitly passes `--terminal-skip-permissions`.

What to know anyway: everything captured is **untrusted data** — a message, a card title or a page body is written by whoever sent it. The terminal's seeded context tells `claude` so, and normal permission prompting is what stands between that text and a command. With `--terminal-skip-permissions` there are no prompts, so third-party-authored text in your captures can try to make it run commands; trusting your own account is not enough.

The session is **persistent**. Closing the tab detaches the view but keeps the child process alive, and a re-attaching tab is replayed a rolling 256 KiB of prior output. Only one viewer at a time — a new `/pty` connection closes the previous socket but keeps the same child. The process dies only on an explicit end frame, on `claude` exiting, or when the server stops.

### The browser extension ingest path (`sluice serve --ingest`)

`POST /api/ingest` is the only non-GET route on the server and the only way capture data enters the store from another process. It exists so the MV3 extension can capture in a normal browser profile with no proxy and no CA. It is **off unless you pass the flag** — without it the route answers `404 ingest_disabled`.

On the runner side: it requires its own ingest secret and a loopback `Host`, and performs **no `Origin` check**, because the poster's origin is `chrome-extension://`. Batches are capped at 32 MiB of body and 500 captures (`413` beyond). It honours the pause switch — while paused it replies `{ ingested: 0, paused: true }` and writes nothing. Ingested exchanges are normalized, then stored through the **same** redacting funnel as proxy traffic (core's `persistCapture`: headers, bodies, and the URL-like fields); the normalizer itself does not redact, so that funnel is the whole of the protection.

On the extension side (see also the section above): the host allowlist is **default-deny** — an empty list captures nothing — and the extension is inert until an endpoint, a token and at least one host are all configured. It refuses any non-loopback endpoint. Bodies are clipped at 512 KiB in both the MAIN-world patch and the ISOLATED-world bridge. A failed POST **drops the batch rather than retrying**, because a service worker can be suspended at any moment and an unbounded queue is worse than a gap. It sees `fetch` and `XHR` only: no WebSockets, no document navigations.

## Reporting a vulnerability

Please open a **private security advisory** on the repository (GitHub → Security → Report a vulnerability) rather than a public issue. If that's unavailable, contact the maintainer directly. We'll acknowledge and triage before any public disclosure.
