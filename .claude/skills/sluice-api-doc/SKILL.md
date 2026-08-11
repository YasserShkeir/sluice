---
name: sluice-api-doc
description: Capture a real service's API traffic with Sluice and turn it into a docs/<service>-api.md endpoint catalog. Use this whenever the user wants to discover or document what a SaaS web app actually calls — "what endpoints does Trello hit", "capture Notion's API", "document the Linear API", "generate the apidoc", "reverse-engineer X's API" — or as the reconnaissance step before writing a Sluice adapter for a new service. Also use when an existing docs/*-api.md needs regenerating or is cluttered with static-asset noise.
---

# Capturing and documenting a service's API

This is the reconnaissance pass that makes writing an adapter tractable: instead
of guessing at endpoints, you drive the real client, capture what it actually
calls, and render a catalog with real request/response shapes.

Output lands in `docs/<service>-api.md`. Note that the whole `docs/` tree is
gitignored (only `docs/linting.md` is force-added), so any example catalogs on a
given machine are **local-only** — do not expect to find them in a fresh clone,
and do not point a reader at one.

The lesson those examples teach, since you probably cannot read them: a
well-scoped catalog for a service with a dedicated API host runs a couple of
hundred lines and is almost entirely endpoints someone would actually call. An
unscoped catalog for a service that serves its SPA and its API from one host runs
to thousands of lines in which `/1/members/me`, `/1/board/{id}` and
`/1/cards/{id}` are buried under hundreds of `/assets/*.js` bundles, CDN PNGs and
analytics pings. Nobody reads the second kind, and it misrepresents the API
surface. The difference is entirely about scoping, which is the main thing this
skill exists to get right.

## 1. Capture

Pick the engine by what you're driving. Both write to the same store.

**Browser (preferred — no CA, no Keychain, no system proxy):**

```bash
pnpm sluice capture
```

This launches Chrome under the DevTools Protocol and passively records XHR/fetch.
Then sign in and *use the product* — click into the areas you want to understand.
Coverage comes from exercising features, not from waiting.

Three things to know before you start:

- **It launches a dedicated Chrome profile at `~/.sluice/chrome`, not yours.** You
  will land in a signed-out browser and have to sign in inside it. That profile
  persists between runs, so you only pay for it once. To use a Chrome you are
  already signed into, start that Chrome with `--remote-debugging-port=9222`
  yourself and attach with `pnpm sluice capture --no-launch`.
- **It captures XHR and Fetch only.** Documents, scripts, CSS, images, fonts,
  media and beacons are dropped before they reach the store. WebSocket **text**
  frames are captured (on by default); **binary** frames are not, so a realtime
  layer that uses a binary protocol is invisible here. Note that gap in the doc
  rather than concluding the endpoint doesn't exist.
- It attaches to **every** Chrome page target and re-runs discovery every 2 s, so
  a login flow that opens a new tab, a popout, and a second tab are all captured.
  The only loss is in-flight requests in a tab you close — those are dropped when
  the tab detaches. The engine reports stopped only when the last tab closes.

Flags: `--url` (start URL), `--cdp-port` (default 9222; also settable as
`cdpPort` in `sluice.config.json`, with the flag winning), `--port` (dashboard),
`--headless`, `--no-launch`, `--chrome-profile`, `--db`. `capture` is the one
server command that does **not** accept `--config`, and it uses the full app
registry rather than the `adapters` allow-list, so a disabled app still gets
attribution here.

**Desktop app, or when you need everything:**

```bash
pnpm sluice ca-install     # one-time, deliberate, reversible
pnpm sluice start          # MITM proxy engine on 127.0.0.1:8080
pnpm sluice proxy on       # ← routing. `start` does not do this for you.
```

`sluice start` starts the engine and **routes nothing on its own.** It prints an
`open -a <App> --args --proxy-server=127.0.0.1:<port>` instruction; the system
proxy is set only from the dashboard's Control panel or by `sluice proxy on`.
Skipping that step is the commonest way to spend ten minutes capturing nothing.
(`sluice start` also only *generates* the CA — trusting it is `ca-install`'s job
alone, so TLS interception fails until you run it.)

Engine A decrypts **every host by default**. Rather than racing a short session,
scope it:

```bash
pnpm sluice start --host api.trello.com      # repeatable
```

`--host` is repeatable and concatenates with `interceptHosts` in config; the
precedence is `--all-hosts` or `interceptAllHosts: true` → everything;
`interceptAllHosts: false` → scoped even with no hosts; any host entry → scoped to
adapter hosts plus those; otherwise → everything. Non-intercepted connections are
tunnelled as raw bytes, which is a stronger guarantee than redaction: Sluice
cannot read them, so it cannot store them.

Confirm traffic is arriving in the dashboard before you spend ten minutes
clicking. An engine that silently died looks exactly like a quiet app;
`sluice doctor --net` probes the proxy path end to end.

## 2. Render the catalog

```bash
pnpm sluice apidoc --host api.trello.com --out docs/trello-api.md
```

**Scope it.** This is the single most important flag. `apidoc` accepts:

- `--host a,b` — comma-separated **substrings**; keeps hosts containing any of them
- `--app <id>` — scope to one adapter id (once an adapter exists)
- `--db PATH`, `--out FILE` (omit `--out` to write to stdout)

Scope to the API host, not the app host — `api.trello.com` rather than
`trello.com`, `api.notion.com` rather than `notion.so`. If the service serves API
and assets from one host, render unscoped first, read the path list, then
re-render narrowed by path prefix or trim by hand.

Path parameters are collapsed automatically (`/1/board/{id}`), so many captures of
the same endpoint become one entry. Real ids surviving as literal path segments
(`/1/card/FBoYdIJW`) means the segment wasn't recognized as an id — worth a
manual merge, and worth noticing since the adapter will need the same rule.

## 3. Make it useful

The generated Markdown is a starting point — it records what was observed, not
what it means. Improve it where it pays:

- **Delete asset/analytics noise** the scoping didn't catch.
- **Say what each endpoint is for**, in one line. The generator can't know that
  `/1/members/me/cards` is "the user's open cards across all boards".
- **Mark the auth mechanism** — this is what the adapter's `buildReplayRequest`
  needs. Trello authorizes by browser session cookie with no token param; Slack
  uses a token form field plus a `d` cookie; LinkedIn needs a `csrf-token` header
  derived from the `JSESSIONID` cookie *in addition to* the cookie. Getting this
  wrong is the most expensive mistake downstream.
- **Note pagination shape** (cursor, offset, `before`/`since`, Relay
  `pageInfo.endCursor`) — this is what replay actions and `nextCursors` are built
  on.
- **Flag anything that looked client-computed** — nonces, request ids, csrf
  tokens, `_x_*` params. These can't be replayed verbatim and the adapter will
  need to regenerate or drop them.

Keep the coverage notes: which areas you exercised, and which you didn't. A
catalog that silently looks complete is worse than one that says "boards and
cards only; no admin or billing endpoints were driven".

## 4. Redaction caveat

Captures are secret-redacted before they reach the store, so the doc is safe to
commit — but the redactor is imprecise in both directions.

**It over-masks on any host with no declared `publicParams`.** A bare `token=`
query param is masked even when the value is public, so those URLs are not
reproducible as written. An app fixes this for its own hosts by declaring
`redaction.publicParams` — fast.com declares
`{ hosts: ['fast.com','nflxvideo.net'], params: ['token'] }`, which is why its
captured URLs stay replayable. If the service you are documenting has a public
token param, that declaration is part of the adapter work.

**It under-masks secrets with no registered value pattern.** The generic field
rule can't match inside a compound name — `\btoken\b` does not match `idToken` —
and there is no generic JWT pattern, so an opaque `"idToken":"eyJ…"` or a
service-specific bearer with no declared shape can survive. (Slack-shaped `xox…`
values are now caught wherever they appear, including under `api_token` and `d`,
because Slack registers a *value* pattern and app redaction applies globally.)

So **read the rendered doc before committing it** rather than trusting the
pipeline. If you find a live credential shape that got through, the durable fix
is a value-shaped pattern in the owning app's `redaction.patterns` — not a field
name, and not scrubbing the file by hand.

## Then what

The catalog is the input to the `sluice-app` skill: the host list becomes
`hosts` + `matchRequest`, the response shapes become `parse`, the interesting
endpoints become `listReplayActions`, the auth mechanism becomes
`buildReplayRequest`, the pagination shape becomes `nextCursors`, and any
service-specific token shape becomes `redaction`. Do this pass first — writing an
adapter against a real catalog is a different activity from writing one against a
guess.

## Commit policy

`docs/` is gitignored, so a catalog you generate stays local unless someone
deliberately force-adds it. Do not force-commit secrets from live capture. Prefer
redacted fixtures (`scrubCaptures` from `@sluice/adapter-sdk`) and the output path
the user names.
