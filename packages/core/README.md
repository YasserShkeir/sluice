<!-- SPDX-License-Identifier: Apache-2.0 -->

# @sluice/core

The shared core of [Sluice](https://github.com/YasserShkeir/sluice) — a
local-only interceptor and explorer for your own SaaS API traffic. This package
is the part a third-party adapter (or an embedding app) depends on, so it is
Apache-2.0 rather than the runner's AGPL. So are `@sluice/adapter-sdk` and
`@sluice/protocol`; everything else in the workspace is AGPL-3.0-or-later.

Its only runtime dependencies are `better-sqlite3` and `nanoid`.

It contains:

- **Normalized types** — `Capture`, the entity model (`Workspace`, `Actor`,
  `Container`, `Item`, `Edge`), `Session` / `RedactedSession`, `EngineStatus`,
  the `Adapter` / `App` contract, and the rest of the domain.
- **The WebSocket protocol** — the 13 `ServerMsg` and 14 `ClientMsg` frames the
  dashboard and runner speak, plus the PTY frame types. **Types only.** Runtime
  validation lives in `@sluice/protocol` so that zod (a runtime value) and this
  package's `better-sqlite3` / `node:fs` dependency never reach the browser
  bundle. It validates *client* frames only; server frames are built in-process
  from typed values and are deliberately unvalidated, and the `/pty` frames sit
  outside the validated unions entirely.
- **The capture schema** — `SCHEMA_SQL`, 11 real tables plus 2 contentless FTS5
  virtual tables, applied idempotently on every open by `migrate()`.
- **Redaction** — the generic policy (four exact header names, one
  credential-shaped header regex, a `Bearer` value pattern, and a
  `name=value` secret-field rule) plus `AppRedaction` / `registerAppRedaction`,
  the seam an app uses to register its own token shapes.
- **`SqliteStore`** — the durable capture + entity store (better-sqlite3, WAL),
  with a `readOnlyStore` projection for untrusted consumers.

```ts
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SqliteStore, redactHeaders, type Capture } from '@sluice/core';

const store = new SqliteStore(join(homedir(), '.sluice', 'sluice.db'));
// or new SqliteStore(':memory:') in tests
```

The constructor does no tilde expansion — it `mkdir`s the literal parent
directory of the path you give it (unless the path is `':memory:'`), so
`'~/.sluice/sluice.db'` creates a directory named `~` in the process CWD.

> `SqliteStore` uses the native `better-sqlite3` addon; it runs under Node, not
> in a browser. The dashboard imports this package with `import type` only.

## The store

**Tables.** `captures` (27 columns), `workspaces`, `actors`, `containers`,
`items` (composite PK `(container_id, id)`), `sessions`, `edges`, `cursors`,
`interaction_flows`, `interaction_flow_steps`, `flow_templates` — plus
`captures_fts` (unicode61) and `items_fts` (porter unicode61), both FTS5
`content=''` with `contentless_delete=1`. Contentless means no second plaintext
copy of a body is stored and results must join back to the source table on
rowid, which is why writes upsert with `ON CONFLICT` rather than
`INSERT OR REPLACE` (REPLACE would assign a new rowid and orphan every indexed
body). The `sessions` table holds `RedactedSession` only — credential *kind*
names, never values. There is deliberately no credentials table anywhere.

**Migrations are additive only.** `migrate()` runs `SCHEMA_SQL`, then
`ADDITIVE_COLUMNS` (`ALTER TABLE ADD COLUMN` for existing databases), then
`ADDITIVE_INDEXES` (which must come after, or index creation fails with
`no such column`), then a one-time FTS backfill. A new column goes in **both**
the `CREATE TABLE` and `ADDITIVE_COLUMNS`. SQLite cannot drop or retype a column
without rebuilding the table, so destructive migration is out of scope.

**Bodies.** `encodeBody` gzips a body only above 2048 characters
(`BODY_COMPRESS_THRESHOLD`); at or below that it is stored as plain text with a
NULL encoding column, and the only non-null encoding value is `'gzip'`.
`decodeBody` is total — an undecodable body returns null rather than throwing.
Two invariants the codec documents but cannot enforce: compression happens
strictly *after* redaction, and the FTS index is fed the plaintext (already
redacted) body, never the gzip blob.

**Search.** `searchCaptures` / `searchItems` go through `ftsQuery(input)`, which
turns arbitrary user text into a safe FTS5 `MATCH` expression by quoting every
token (preserving only a trailing `*` as a prefix search) and returns
`undefined` when nothing searchable remains — so callers skip the join instead
of matching everything. `listCaptures` defaults to `LIMIT 500`, `queryItems` to
`LIMIT 200`.

**Edges.** `edges` records relationships between entities keyed by the composite
PK `(src_kind, src_id, rel, dst_kind, dst_id)`. Endpoints are `(kind, id)` pairs
rather than foreign keys, so a dangling edge is normal, not an error. Example
rels: `member-of`, `authored`, `mentions`, `replies-to`, `in-label`.

**Cursors.** The `cursors` table is the pagination worklist an adapter's
`nextCursors()` seeds and `sluice replay --all` drains: `enqueueCursors` (idempotent
against a unique dedupe index on adapter + action + container + cursor, carrying
`reason` and `depth`), `claimCursors` (claim-and-flip inside an *immediate*
transaction so two drainers cannot claim the same page), `completeCursor`,
`releaseStaleCursors(olderThanMs)` (startup recovery of `running` rows — a
lease: only claims untouched that long, so a live drainer keeps its own),
`releaseCursors(ids)` (return a drainer's own unsettled claims — it resets any
`running` id it is given), `countCursors`.

**Flows.** `upsertFlow` (rejects an empty step list, sorts by `seq`, guarantees
the primary capture appears as role `primary` with `required=true`),
`createPinnedFlow`, `upsertFlowTemplate` (re-learning overwrites rather than
stacks), `listFlows` / `listFlowTemplates` (user search text is LIKE-escaped),
`gcOrphanFlows` (run after any capture delete).

**Retention and storage.** `pruneCaptures({ maxAgeMs, maxRows, vacuum })`
deletes the FTS rows first while rowids still resolve; `deleteCaptures(q)`
refuses an empty query (`use wipe() to remove everything`); `vacuum()` is a bare
`VACUUM` that blocks the event loop and is never run automatically on a live
path; `wipe()` clears 13 tables in one transaction but does **not** drop the
cartographer's materialized per-app tables and reuses the same file, so freed
pages are only scrubbed by a following VACUUM; `storageStats()` reports total,
free and per-table bytes via `dbstat`. None of this runs on its own — with
neither `retentionDays` nor `maxCaptures` set in the runner config, nothing is
ever pruned.

**`readOnlyStore(store)`** returns a *fresh object of bound methods*
(`listWorkspaces`, `listContainers`, `listItems`, `queryItems`, `countItems`,
`searchItems`, `listEdges`, `countCaptures`, `newestCaptureTs`) — no `db`
handle, no writers, so a consumer cannot reach `insertCapture` or
`pruneCaptures` by casting. It returns no `Capture` at all; coverage questions
are answered by `countCaptures` / `newestCaptureTs` so capture bodies never
reach an untrusted caller. The MCP server keeps the read-write store for itself
(it inserts captures, applies parse results and runs `reconcile` at startup) and
hands this projection to app-contributed tools.

## Redaction

`redactHeaders` always masks `authorization`, `cookie`, `set-cookie` and
`proxy-authorization`, plus any header name matching the credential-shaped
regex (also concatenated names such as `X-CSRFToken` or `x-authtoken`).
`redactText` applies, in order, rules that each stay linear on hostile input:

1. the generic value patterns, which mask a secret by its SHAPE under any field
   name: `Bearer …` (also URL/form-encoded), PEM private-key blocks (raw,
   escaped at any JSON depth, URL/form-encoded or truncated), JWTs, Anthropic /
   OpenAI / Stripe keys, Google OAuth access and refresh tokens and API keys,
   AWS access key ids, GitHub tokens and Slack `xox?-` / `xapp-` tokens;
2. every app-registered pattern, in registration order;
3. the echoed-header rule — the WHOLE value after an `Authorization`,
   `Proxy-Authorization`, `Cookie` or `Set-Cookie` name echoed into a body, log
   line or error (`"cookie":"a=1; SID=…"`, `Authorization: Basic …`);
4. the multipart rule — the value line of a `form-data` part whose name is
   credential-shaped;
5. the field rule, which masks the value after any name ENDING in a credential
   word (`token`, `secret`, `password`, `passwd`, `passphrase`, `api_key`,
   `private_key`, `secret_access_key`, `client_assertion`, `session_id`,
   `oauth_verifier`, `code_verifier`, `SAMLResponse`, `csrf`, `xsrf`, `jwt`) —
   so `id_token`, `authToken` and `x-csrf-token` are covered — in `k=v`,
   `"k":"v"`, escaped-JSON and percent-encoded forms. A quoted value is masked
   up to its closing quote (spaces and commas included) and a bare JSON
   `true`/`false`/`null` is left alone, so the JSON stays parseable. Pagination
   cursors (`nextPageToken`, `page_token`, `nextToken`, `syncToken`, …) are
   deliberately left alone;
6. the query-param rule — `code`, `sig`, `signature`, `session`,
   `X-Amz-Signature`/`-Credential`, … are too generic as field names, so they are
   masked only as query-shaped params (after `?`, `&`, `#` or `;`) with a value of
   8+ characters, so `?code=US` survives. It is the last step of `redactText`, so
   it applies wherever `redactText` does: URLs, header values such as
   `Location`/`Referer`/`Link`, bodies, classifications and error messages.

`redactUrl` is `redactText` over a URL, keeping the query before the fragment,
except that params an app declared public survive on its hosts.
`redactCaptureUrls(c)` applies it to a capture's `url`, `path` and `tabUrl`
(plus `redactText` on `classification`);
`redactedErrorMessage(e)` is `redactText(errorMessage(e))`; `previewSecret`
shows the first 6 characters of a long secret and only `«present»` for one of
12 characters or fewer. The mask is the literal `«redacted»` (exported as
`MASK`).

`AppRedaction` has three optional fields: `headers` (extra always-masked names),
`patterns` (extra value patterns — the `g` flag is forced on and `y` removed at
registration, so every occurrence is masked), and `publicParams` (query params that
are *public* on the listed hosts and must survive redaction — this is what stops
the generic `token=` rule from destroying fast.com's speedtest token and making
the capture unreplayable). `registerAppRedaction(sources)` folds them into
module-level globals.

Redaction runs **before** attribution: the engines redact as they build the
`Capture` and the runner re-redacts in `sanitizeCapture()` before an adapter is
picked. That is why `@sluice/apps` registers every installed app's shapes as one
global union at import time, and why redaction is deliberately *not* narrowed by
the adapters allow-list.

## Also exported

- **`replay-deny.ts`** — `REPLAY_DENIED_OPERATION_PATTERNS` and
  `looksLikeDeniedWrite(method, ...haystacks)`: the name patterns whatever the
  method, plus unsafe methods on order/checkout/cart/payment/subscription/
  refund/tip paths and bare Trello collections (flow-learn calls it).
  `looksLikeDeniedReplay(req, ...extra)` is the whole-request check the
  interceptor replay-policy and cartographer flow-build call: it also matches the percent-decoded path/body and refuses
  method-override headers and `_method` fields. `isReplayMethodAllowed(method)`
  (GET/HEAD/POST) and `replayRequestProbe(url)` are the single source for the
  method allowlist and the `pathname?query` haystack, and `replayHostAllowed(host,
  allowed)` is the one host-rail matcher (exact host or a subdomain, `*.`
  stripped, empty list allows nothing). These are heuristics, not a proof that
  an allowed request does not mutate.
- **`persist.ts`** — `persistCapture(store, raw, adapter)`, the one persistence
  funnel the runner and the MCP server share: redact (`redactCapture`: headers,
  bodies and every URL-like field) → attribute → classify → store → parse
  (contained: a throwing parser leaves the capture stored with `parsedAt` null)
  → seed cursors. `matchAdapter(adapters, input, onError?)` is the guarded
  "which app is this?" check the engines use too.
- **`workspace-of.ts`** — `workspaceOfParams`, `workspaceOfValues` and
  `containerWorkspace`: the workspace a replay's own arguments name, so it goes
  out as that workspace's session.
- **`flow-summary.ts`** — secret-free flow and template projections
  (`flowSummary`, `templateSummary`, `paramSourcesSummary`, …) for MCP, the HTTP
  API and the CLI.
- **`oscrypt.ts`** — `decryptOscryptV10`, `keychainPassphrase` (retries without
  the account only on "item not found", 120 s timeout), `withCopiedSqliteDb`,
  and `KEYCHAIN_ALLOW_ADVICE`, the "Allow, not Always Allow" line to print
  before a Keychain read.
- **`chrome-cookies.ts`** — `locateChromeProfile(domain, { requireCookie })`
  (passive, bound SQL), `readChromeCookies`, `buildChromeCookieHeader`,
  `readChromeCookieHeader`, `NoChromeSessionError` and `isNoSessionError`
  ("signed out" vs "could not read it").
- **`safe-copy.ts`** — `copyFileSafe`, `copyDirSafe`: EINTR-tolerant JS copies
  that skip symlinks; `sweepStaleTempDirs`, which removes the private temp copies
  (`sluice-ldb-*`, `sluice-cookies-*`) a killed read left behind.
- **`auth-failure.ts`** — `isAuthFailure(capture)`: HTTP 401 always, 403 never,
  plus a 2xx whose JSON body is `{ ok: false, error: <code> }` for ten known
  codes (Slack signals failure as HTTP 200); `serviceError(body)` parses that
  `{ ok:false, error?, needed?, provided? }` shape.
- **`util.ts`** — `newId(prefix)` (nanoid, `prefix_<16 chars>`), `splitUrl`,
  `operationName(path)`, the generic fallback classification that strips
  `api`/`vN`/digit prefixes and replaces id-looking segments with `:id`, and the
  shared helpers `errorMessage`, `headerValue` (case-insensitive),
  `safeJsonParse` / `safeJsonObject` (never throw) and `resolveJsonPath`
  (flow-learn bind paths).
- **`store.ts`** — besides `SqliteStore` (which creates its database file 0600
  and tightens older files and `-wal`/`-shm` siblings), `restrictToOwner(path)`:
  best-effort, drops group/other bits of a regular file or directory.

## Interaction flows

`InteractionFlow` / `FlowTemplate` types and the store APIs above back
multi-step observation. Secrets never live on flow tables, and MCP/HTTP flow
summaries stay secret-free — a template describes param *binding kinds*
(`kind`, `name`, `fromStep`, `jsonPath`), not values. Flows are clustered and
learned by `@sluice/cartographer` and executed by
`@sluice/interceptor`'s `runFlowReplay`.

## License

Apache-2.0.
