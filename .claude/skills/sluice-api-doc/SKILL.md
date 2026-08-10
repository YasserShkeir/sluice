---
name: sluice-api-doc
description: Capture a real service's API traffic with Sluice and turn it into a docs/<service>-api.md endpoint catalog. Use this whenever the user wants to discover or document what a SaaS web app actually calls — "what endpoints does Trello hit", "capture Notion's API", "document the Linear API", "generate the apidoc", "reverse-engineer X's API" — or as the reconnaissance step before writing a Sluice adapter for a new service. Also use when an existing docs/*-api.md needs regenerating or is cluttered with static-asset noise.
---

# Capturing and documenting a service's API

This is the reconnaissance pass that makes writing an adapter tractable: instead
of guessing at endpoints, you drive the real client, capture what it actually
calls, and render a catalog with real request/response shapes.

Output lands in `docs/<service>-api.md`. `docs/fast.com-api.md` (203 lines, clean)
and `docs/trello-api.md` (2610 lines, mostly noise) are the two existing
examples — the difference between them is entirely about scoping, which is the
main thing this skill exists to get right.

## 1. Capture

Pick the engine by what you're driving. Both write to the same store.

**Browser (preferred — no CA, no Keychain, no system proxy):**

```bash
pnpm sluice capture
```

This launches Chrome under DevTools Protocol and passively records XHR/fetch.
Then sign in and *use the product* — click into the areas you want to
understand. Coverage comes from exercising features, not from waiting.

Two live limitations to work around:
- It attaches to a **single page target**, so a login flow that opens a new tab,
  or work done in a second tab or a popout, produces nothing. Stay in one tab.
- It captures XHR/Fetch only — **no WebSocket frames**. If the service's realtime
  layer matters (Slack RTM, live cursors, presence), it will be invisible here.
  Note that gap in the doc rather than concluding the endpoint doesn't exist.

**Desktop app, or when you need everything:**

```bash
pnpm sluice ca-install     # one-time, deliberate, reversible
pnpm sluice start          # MITM proxy engine
```

Be aware this currently decrypts **all** hosts, not just the ones you care
about — so keep the session short and prefer `capture` when the browser is enough.

Confirm traffic is arriving in the dashboard before you spend ten minutes
clicking. An engine that silently died looks exactly like a quiet app.

## 2. Render the catalog

```bash
pnpm sluice apidoc --host api.trello.com --out docs/trello-api.md
```

**Scope it.** This is the single most important flag. `apidoc` accepts:

- `--host a,b` — comma-separated **substrings**; keeps hosts containing any of them
- `--app <id>` — scope to one adapter id (once an adapter exists)
- `--db PATH`, `--out FILE` (omit `--out` to write to stdout)

Without scoping you get everything the browser touched. `docs/trello-api.md` is
the cautionary example: 2610 lines in which the genuinely useful entries
(`/1/members/me`, `/1/board/{id}`, `/1/cards/{id}`) are buried under hundreds of
`/assets/*.js` bundles, CDN PNGs and analytics pings. Nobody reads that, and it
misrepresents the API surface.

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
  uses a token form field plus a `d` cookie. Getting this wrong is the most
  expensive mistake downstream.
- **Note pagination shape** (cursor, offset, `before`/`since`) — this is what
  replay actions and any future worklist are built on.
- **Flag anything that looked client-computed** — nonces, request ids, csrf
  tokens, `_x_*` params. These can't be replayed verbatim and the adapter will
  need to regenerate or drop them.

Keep the coverage notes: which areas you exercised, and which you didn't. A
catalog that silently looks complete is worse than one that says "boards and
cards only; no admin or billing endpoints were driven".

## 4. Redaction caveat

Captures are secret-redacted before they reach the store, so the doc is safe to
commit — but the redactor is currently **imprecise in both directions**:

- It over-masks: a bare `token=` query param is masked even when it's a public,
  non-secret value (fast.com's speedtest token), so some URLs in the doc are not
  reproducible as written.
- It under-masks: values under field names the generic pattern misses
  (`api_token`, `idToken`, a bare `d` cookie in a JSON body) can survive.

So **read the rendered doc before committing it** rather than trusting the
pipeline. If you find a live credential shape that got through, that's a
redaction bug worth fixing at the source in `packages/core/src/redact.ts`, not
just scrubbing from the file.

## Then what

The catalog is the input to the `sluice-app` skill: the host list becomes
`hosts` + `matchRequest`, the response shapes become `parse`, the interesting
endpoints become `listReplayActions`, and the auth mechanism becomes
`buildReplayRequest`. Do this pass first — writing an adapter against a real
catalog is a different activity from writing one against a guess.

## Commit policy

`docs/*-api.md` catalogs may be local/gitignored depending on repo policy — do not force-commit secrets from live capture. Prefer redacted fixtures and the skill output path the user names.

