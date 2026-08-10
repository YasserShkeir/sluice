# Security & Privacy

Sluice reads a credential equivalent to a live, logged-in session. The security design **is** the product. This document is the honest version of the caveats — it is deliberately not buried.

## What Sluice does and doesn't do

- **Reads your already-authenticated session on your own machine.** It injects nothing into the target service; it only sees what that session can already see.
- **100% local, zero-egress by construction.** The only outbound traffic is your own client's (through the proxy) and, optionally, replay calls to the *same* service you're already talking to. No telemetry, no cloud, ever.
- **Surfaces only what it actually observed.** Every normalized entity records the capture bytes it came from.

## Things to know before using

- **Session tokens vs supported APIs.** A *session* token (e.g. Slack's `xoxc`) is the same class of credential a browser extension would use on a logged-in tab. Prefer a workspace-issued API token when one is available.
- **Credential sensitivity.** A session token **plus** its session cookie together equal a logged-in session — treat both as highly sensitive until the session is revoked. That is exactly why Sluice keeps them in memory and never writes or transmits them.
- **Operational effects.** Rate-limiting and session invalidation can still happen; local storage of captures does not hide requests from the service's own logs.
- **Workplace policy.** Check any workplace rules that apply to how you access company tools on your machine.
- **You own the output.** An export is your workspace's content; treat it with the same sensitivity as the workspace itself.

## Defensive posture (enforced, not aspirational)

- **Secrets in memory only.** The session token + cookie exist only in the runner process's memory for its lifetime. They are **never** written to SQLite, logged, or streamed over the WebSocket. See the honest limit on zeroing below.
- **Central redactor on every sink.** `redactHeaders` / `redactText` / `redactUrl` (in `@sluice/core`) mask `authorization` / `cookie` / `proxy-authorization` headers and credential-shaped values *before* a capture reaches the store, the logs, or the UI. Each installed app additionally contributes its own token shapes (Slack registers `xoxc-`/`xoxd-`), so a service's secrets are matched by shape wherever they appear — not only under field names a generic pattern happens to know.
- **The store has nowhere to put a secret.** There is deliberately no credentials table; only a redacted session descriptor (names of credential kinds, never values) is persisted.
- **Loopback only.** Every local server binds `127.0.0.1`, checks the `Origin` header, and requires a random per-session bearer token, so other local processes or browser tabs can't subscribe. Pages are served with a strict `Content-Security-Policy` that permits no external origin.
- **Replay is read-only.** Replays are checked below every caller (CLI, web UI, MCP): mutating HTTP verbs are blocked, a denylist covers write/admin operations (`chat.postMessage`, `admin.*`, …), and a shared rate budget plus single-flight concurrency bound traffic volume. A modified frontend cannot route around this.
- **Reversible trust.** The MITM CA is a separate, deliberate, one-command install/uninstall. `sluice wipe` removes the capture DB; `sluice wipe --all` also untrusts and removes the CA and the dedicated Chrome profile. `sluice prune` bounds how long captures are kept.

## Known limits (what is NOT guaranteed)

Being straight about these matters more than the marketing value of omitting them.

- **Secrets are not reliably zeroed.** Credentials are held as ordinary JavaScript strings, which cannot be wiped: V8 copies them during GC and we cannot `mlock` the heap. Only the macOS Keychain passphrase `Buffer` is explicitly zeroed after use — and even that is preceded by an unzeroable string copy. Treat "in memory only" as "never persisted", not as "unrecoverable from process memory". A memory dump of a running Sluice can yield your session.
- **Redaction is best-effort pattern matching.** It masks known header names, credential-shaped values, and each app's registered token shapes. A novel secret format under an unrecognised field name can still reach the local store. The store is local and unshared, so the impact is limited to your own disk — but review before exporting or sharing anything.
- **The MITM engine decrypts every host** while it is running, not only the hosts an adapter claims. Keep proxy sessions short, and prefer `sluice capture` (browser CDP, no proxy and no CA) when it is sufficient.
- **Capture is retained until you remove it.** Nothing expires on its own; run `sluice prune --days N` or `sluice wipe`.

## Reporting a vulnerability

Please open a **private security advisory** on the repository (GitHub → Security → Report a vulnerability) rather than a public issue. If that's unavailable, contact the maintainer directly. We'll acknowledge and triage before any public disclosure.
