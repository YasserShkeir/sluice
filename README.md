# Sluice

> Capture and explore the API traffic your own Slack (and other SaaS) clients make — 100% locally, no app registration, no admin approval.

**Status: 🚧 Working MVP (Phase B).** The `@sluice/core` spine, three app plugins (Slack, Trello, fast.com), the `sluice` CLI + loopback web server, the API Cartographer, an MCP server, and the React dashboard are built and typecheck clean. All three capture engines are implemented: the MITM proxy (A), token-extract + replay (B), and passive browser capture via Chrome DevTools (C). Lint, typecheck and 102 tests run green in CI, covering the redactor, the store, the replay rails, the cartographer, the runner's server and the MCP handlers.

## Install

```bash
npx sluicejs doctor          # no install; check the environment
npm i -g sluicejs            # or install once — the binary is called `sluice`
sluice doctor
```

`sluicejs` is a bare-name launcher for `@sluice/runner`, which you can equally
run directly as `npx @sluice/runner`. (The plain `sluice` name on npm has
belonged to an unrelated package since 2013.)

macOS is the only platform with local credential extraction today; capture and
the dashboard work anywhere Node does.

## Quickstart from a clone (macOS)

```bash
pnpm install                 # native deps (better-sqlite3, classic-level, esbuild) build automatically
pnpm sluice doctor           # check your environment — reads no secrets
                             # (note: `pnpm doctor` is pnpm's own builtin — use `pnpm sluice doctor`)
pnpm webapp:build            # build the web UI (or: pnpm webapp:dev for hot-reload on :5273)

# read YOUR OWN Slack session (pops a macOS Keychain prompt — that is the consent boundary):
pnpm sluice extract-token    # prints a REDACTED summary only; token/cookie never touch disk
pnpm sluice serve            # then open the printed http://127.0.0.1:7788 URL to browse

# optional live capture (Engine A): starts a local MITM proxy you route Slack through
pnpm sluice start
```

No admin approval, no Slack app, no bot token — and everything stays on your machine.

---

## What is this?

Sluice is a **local-only** developer tool that intercepts the API calls made by your *own, already-authenticated* Slack client, reconstructs your workspace's structure (channels, DMs, users), and lets you read and export message history — all through an interactive web UI.

It exists for a specific, common situation: you work somewhere that **won't let you create a Slack app or issue a bot/user token**, but you still need programmatic access to *your own* data. The official paths (a registered Slack app, or a `xoxb`/`xoxp` token) are gated behind workspace-admin approval. Sluice needs neither — it reads the session you already have.

Slack is just the **first adapter**. The architecture generalizes to Notion, Linear, Jira, Discord, and other SaaS via pluggable adapters.

## How it works (three capture engines)

| Engine | Mechanism | Best for | Needs |
|--------|-----------|----------|-------|
| **A — MITM proxy** *(primary)* | Local HTTPS proxy + trusted local CA | Desktop app **and** browser; live traffic | One-time CA trust |
| **B — Token extract + replay** | Read your own `xoxc` token + `d` cookie from the local Slack store, call the Web API directly | Fast backfill, on-demand fetch, powering interactive replay | Keychain access |
| **C — Browser CDP / extension** | Observe `app.slack.com` traffic via Chrome DevTools Protocol or an injected fetch/WebSocket patch | Browser-only Slack users, zero cert install | Chrome |

All three normalize into one data model and stream into a local web app that's part traffic inspector (à la Charles/mitmweb/Proxyman), part data explorer.

![Sluice pipeline: sources feed three capture engines, which converge on a single ingest funnel that redacts, attributes, classifies and parses every exchange into a local SQLite store, read back by the dashboard, the MCP server and the CLI.](assets/architecture/01-pipeline.png)

Every engine converges on **one ingest funnel**, so redaction, attribution and parsing happen in exactly one place no matter how a capture arrived.

<details>
<summary><b>Architecture in detail</b> — four more diagrams</summary>

<br>

**Capture engines — how each one decides what it is allowed to see.** Interception is *scoped, not filtered*: a host outside the intercept list is CONNECT-tunnelled as raw bytes, so no row is ever written for it. A service with no adapter and no `--host` entry looks "not captured" rather than captured-but-empty.

![Engine A's scope decision, Engine C's XHR/Fetch-only filter and extension host allowlist, and Engine B's credential extraction.](assets/architecture/02-capture-engines.png)

**Ingest and normalization.** Redaction runs *before* attribution, which is why each app registers its own token shapes into one global policy applied to all traffic.

![The five ingest steps, the normalized model, and the cartographer's per-app table materialization.](assets/architecture/03-ingest-normalization.png)

**Replay.** Three independent limits — method, operation, budget — sit below every caller, so a modified frontend or a creative tool argument cannot route around them.

![Replay callers, the three safety gates, and the build-and-send chain from request template to stored capture.](assets/architecture/04-replay.png)

**Control plane and consumers.** The engine lifecycle, the three per-session capability secrets, and the full MCP tool surface.

![Engine lifecycle from serve to system proxy, the dashboard's token model, and the core plus app-contributed MCP tools.](assets/architecture/05-control-plane.png)

</details>

- 📄 **[Contributing →](./CONTRIBUTING.md)** — setup, the rules that matter, and how to add a service
- 📄 **[Security & privacy →](./SECURITY.md)** — read this one

## Security & scope — read this

Sluice is designed to be trustworthy because it's boring about data:

- **100% local.** Captured traffic and credentials never leave your machine. No telemetry, no cloud.
- **Your own session only.** It reads credentials your OS already holds for you. It cannot access anyone else's account.
- **Secrets stay in memory.** The `xoxc` token and `d` cookie are full-session credentials — Sluice keeps them in the runner process only, never writes them to disk, and `.gitignore` blocks captured data from ever being committed. (They are ordinary JS strings and cannot be reliably wiped — see [`SECURITY.md`](./SECURITY.md#known-limits-what-is-not-guaranteed).)
- **Replay cannot write.** Mutating verbs and write/admin operations are refused below every caller, with a shared rate budget. Sluice can read your session; it cannot act as you.
- **Explicit consent.** Installing the local CA (Engine A) is a deliberate, reversible step you run yourself.

**Honest caveat:** automating or scraping the Slack client is **against Slack's Terms of Service**, even for your own data. Sluice is a personal/research tool for accessing data you already have access to; it is not a supported integration path. If your workspace *can* grant an official token, prefer that. Don't use Sluice to collect other people's data or to evade access controls.

## Repo layout

```
packages/core          @sluice/core          types · normalized model · SQLite store · WS protocol · redactor
packages/interceptor   @sluice/interceptor   MITM engine (mockttp) · CDP engine · replay + safety rails · auth-reconstruct seed
packages/cartographer  @sluice/cartographer  API map · per-app table materialization · faithful replay templates
packages/apps          @sluice/apps          the installed-apps registry (the one place apps are named)
packages/app-slack     @sluice/app-slack     Slack: adapter · parser · macOS credential provider
packages/app-trello    @sluice/app-trello    Trello: adapter · Chrome-cookie credentials · MCP tool
packages/app-gmail     @sluice/app-gmail     Gmail: positional-array sync API · thread/label MCP tools
packages/app-loom      @sluice/app-loom      Loom: adapter · Chrome-cookie credentials · transcript MCP tool
packages/app-fast      @sluice/app-fast      fast.com: credential-free adapter · speed-test MCP tool
packages/mcp           @sluice/mcp           the `sluice-mcp` stdio MCP server
packages/runner        @sluice/runner        the `sluice` CLI + loopback HTTP/WS server
packages/cli           sluicejs              bare-name launcher — `npx sluicejs`, no logic of its own
apps/webapp            @sluice/webapp        Vite + React dashboard (overview · traffic table · inspector)
```

## Commands

```
doctor          Check the local environment (Node, app sign-in, proxy engine, DB). No secrets.
extract-token   Read your local session token + cookie; print a REDACTED summary only.
serve           Start the loopback web UI + WS server (no proxy).
start           Like serve, plus the MITM proxy engine for live capture.
capture         Passively capture browser API traffic via Chrome DevTools (no proxy/CA/Keychain).
proxy           Toggle the macOS system web proxy: sluice proxy <on|off|status>.
ca-install      Generate + trust Sluice's local CA (for MITM capture of a desktop app).
ca-uninstall    Remove trust for Sluice's local CA.
sync            Reconstruct structure for ALL (or one) workspace via the Web API.
build-db        Materialize per-app tables from captures.
apidoc          Render a Markdown API catalog from captured traffic (scope it with --host).
replay          Run one replay action by id and store the parsed entities.
export          Dump a container's items to JSON.
adapters        List installed apps: hosts, credential source, replay actions, MCP tools.
status          Is a runner serving? Report pid/port/uptime and store size.
stop            Ask a running runner to shut down (--force to SIGKILL).
prune           Delete old captures: --days N and/or --max-rows N.
wipe            THE PANIC BUTTON: delete the capture DB; --all also removes the CA + Chrome profile.
```

Run `pnpm sluice <command> --help` for per-command options.

## Install

```bash
pnpm install && pnpm build     # bundles the CLI, the MCP server and the dashboard
node packages/runner/dist/cli.js doctor
```

`pnpm build` produces two self-contained binaries that run under plain `node` —
no `tsx`, no workspace. The dashboard is copied in alongside the CLI bundle, so
the published package serves it without needing the repo.

Native modules (`better-sqlite3`, `classic-level`) and `mockttp` are deliberately
left external and declared as runtime dependencies; bundling a native addon
breaks its `.node` binding lookup.

## MCP server

Sluice exposes its captured data — and each app's tools — to Claude over MCP:

```bash
claude mcp add sluice -- node /path/to/sluice/packages/mcp/dist/cli.js
```

(after `pnpm build`; before that, `pnpm --dir /path/to/sluice exec tsx packages/mcp/src/cli.ts`)

## License

Split-licensed: **`packages/core` is Apache-2.0** (permissive, so anyone can build adapters on the model) and **everything else is AGPL-3.0-or-later** (a hosted derivative must publish source; running it locally carries no obligations). See [`LICENSING.md`](./LICENSING.md).

## Support

Sluice is unfunded and maintained by one person. Adapters, engine work, and macOS-version breakage all cost time; sponsorship pays for that time.

- **GitHub Sponsors** — [github.com/sponsors/YasserShkeir](https://github.com/sponsors/YasserShkeir) (recurring, counts toward your GitHub profile)
- **Donate page** — [yasser-shkeir.com/donate](https://www.yasser-shkeir.com/donate)

Direct Stripe checkout, if you'd rather skip a page:

| One-time | Monthly |
|----------|---------|
| [$5](https://buy.stripe.com/6oUfZbgh17Km5xQ2HzcMM00) · [$10](https://buy.stripe.com/bJe00d8Oz4ya8K21DvcMM01) · [$25](https://buy.stripe.com/00wfZb5Cn7Km8K21DvcMM02) · [$50](https://buy.stripe.com/aFa14h7Kv0hU1hAfulcMM03) | [$5/mo](https://buy.stripe.com/8x2eV76Gr9Su1hAci9cMM04) · [$15/mo](https://buy.stripe.com/28EeV7e8TaWy2lE5TLcMM05) · [$50/mo](https://buy.stripe.com/bJe8wJ7Kvc0C7FY2HzcMM06) |

Sponsorship buys no support contract, no roadmap influence, and no license exception — the split license above applies to sponsors and non-sponsors identically. Nothing in the tool phones home for this: these are plain links in a Markdown file, and no Sluice binary or command fetches them.

---

*Working name; subject to change.*

## Configuration

Optional. Every setting also has a CLI flag, and a flag always wins.

Sluice reads the nearest `sluice.config.json` walking up from the CWD, then
`~/.sluice/config.json`; `--config PATH` overrides both.

```jsonc
{
  "db": "~/work/sluice.db",      // SQLite path
  "port": 7788,                  // HTTP + WS port
  "proxyPort": 8080,             // MITM proxy port (sluice start)
  "adapters": ["slack"],         // restrict which installed apps are active
  "retentionDays": 14,           // drop captures older than this on startup
  "maxCaptures": 50000           // keep at most this many
}
```

A malformed config is a hard error rather than a silent fallback — running with
settings you believe you overrode is worse than not starting.

## HTTP API

The runner exposes a read-only JSON API on the same loopback origin, gated by the
same per-session token as the WebSocket (`?token=…` or `Authorization: Bearer`):

```
GET /api/status                     GET /api/captures?limit&app&host&tab
GET /api/adapters                   GET /api/captures/:id/body
GET /api/workspaces                 GET /api/containers?workspaceId
GET /api/actors                     GET /api/items?containerId
GET /api/apidoc[?format=markdown]   GET /api/tables
                                    GET /api/tables/:name?limit&offset&orderBy
```

`/api/tables` is the Cartographer's output — the typed per-app tables derived
from real responses. Table and column names are validated against the live schema
before use, so only materialized `<app>_*` tables are reachable.
