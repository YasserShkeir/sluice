// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/mcp — a Model Context Protocol stdio server that exposes Sluice's
 * captured data + replay to an MCP client (e.g. Claude Code).
 *
 * Transport discipline: stdout is the MCP framing channel — NOTHING may be
 * written there except protocol frames. All diagnostics go to stderr.
 *
 * Secrets discipline (inherited from the Sluice contract): the store holds no
 * secrets (only redacted captures / RedactedSessions). The single `replay` tool
 * acquires a live Session in-memory via the interceptor, hands it straight to
 * the adapter's request builder, and never returns, logs, or persists it — only
 * the redacted Capture that `runReplay` produces is stored, and only a summary
 * is returned. Error strings pass through `redactText` before leaving a handler.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ZodRawShape } from 'zod';

import { decodeBody, readOnlyStore, redactText, SqliteStore } from '@sluice/core';
import type { App, AppToolContext, Capture, ReplayAction, Session } from '@sluice/core';
import { enabledApps, getApp, installExternalAdapters } from '@sluice/apps';
import { faithfulReplayRequest } from '@sluice/cartographer';
import { mapAuthFlow } from '@sluice/interceptor';
import { replayWithRefresh, runReplay } from '@sluice/interceptor';

// ── MCP result helpers ──────────────────────────────────────────────────────────

interface TextResult {
  // The SDK's CallToolResult carries an index signature; matching it here keeps
  // our helper assignable to the tool-handler return type.
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const jsonResult = (data: unknown): TextResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const errorResult = (message: string): TextResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

const errText = (e: unknown): string =>
  redactText(e instanceof Error ? e.message : String(e));

/**
 * The workspace a replay's arguments already imply, or undefined.
 *
 * Reads the action's own param declarations rather than guessing at names: a
 * param of kind `containerId` holds a container id, and a container row carries
 * its workspace. That is the whole inference, and it is exact when it fires —
 * no heuristics on key names, which would break the moment an adapter called
 * something `board` instead of `channel`.
 */
export function workspaceOfParams(
  store: SqliteStore,
  action: ReplayAction,
  params: Record<string, string> | undefined,
): string | undefined {
  if (!params) return undefined;
  for (const p of action.params) {
    if (p.kind !== 'containerId') continue;
    const value = params[p.name];
    if (value === undefined || value.length === 0) continue;
    const owner = store.listContainers().find((c) => c.id === value)?.workspaceId;
    if (owner !== undefined) return owner;
  }
  return undefined;
}

// ── Raw SQLite access (structural, to stay off better-sqlite3's type surface) ────

interface RawStatement {
  all(params?: Record<string, unknown>): unknown[];
  get(params?: Record<string, unknown>): unknown;
}
interface RawDb {
  prepare(sql: string): RawStatement;
}
const rawDb = (store: SqliteStore): RawDb => store.db as unknown as RawDb;

// ── Store location ──────────────────────────────────────────────────────────────

/** Default `~/.sluice/sluice.db`, overridable with the `SLUICE_DB` env var. */
export function defaultDbPath(): string {
  const override = process.env.SLUICE_DB;
  return override && override.length > 0 ? override : join(homedir(), '.sluice', 'sluice.db');
}

export function openStore(): SqliteStore {
  return new SqliteStore(defaultDbPath());
}

/**
 * The stand-in session for apps with no credential provider (fast.com). Its
 * `values` are empty by construction, so it can never carry a secret and can
 * never justify a Keychain prompt.
 */
const SYNTHETIC_SESSION: Session = {
  id: '',
  adapterId: '',
  label: '',
  credentials: { kind: 'none', values: {}, injection: {} },
  discoveredAt: 0,
  source: 'manual',
};

// ── Server construction ─────────────────────────────────────────────────────────

/**
 * Build (but do not start) the MCP server bound to an already-open store.
 * Every tool is a thin, typed wrapper over `@sluice/core` store reads, except
 * `replay`, which is the one network-touching tool.
 */
export function buildServer(store: SqliteStore): McpServer {
  const server = new McpServer({ name: 'sluice', version: '0.0.0' });

  // list_workspaces() -> every known workspace across adapters.
  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description: 'List every captured workspace (id, adapterId, name, domain).',
      inputSchema: {},
    },
    async () => jsonResult(store.listWorkspaces()),
  );

  // list_channels({ workspaceId? }) -> containers, optionally scoped to a workspace.
  server.registerTool(
    'list_channels',
    {
      title: 'List channels / containers',
      description:
        'List containers (channels, DMs, groups, boards…). Pass workspaceId to scope to one workspace; omit for all.',
      inputSchema: { workspaceId: z.string().optional() },
    },
    async ({ workspaceId }) => jsonResult(store.listContainers(workspaceId)),
  );

  // get_messages({ containerId, limit? }) -> items in a container, newest first.
  server.registerTool(
    'get_messages',
    {
      title: 'Get messages / items',
      description:
        'List items (messages, pages, issues…) in a container, newest first. Default limit 200.',
      inputSchema: {
        containerId: z.string(),
        limit: z.number().int().positive().max(1000).optional(),
      },
    },
    async ({ containerId, limit }) => jsonResult(store.listItems(containerId, { limit })),
  );

  // list_endpoints() -> distinct method+host+path with call counts.
  server.registerTool(
    'list_endpoints',
    {
      title: 'List captured endpoints',
      description:
        'Distinct method+host+path across all captures, with a call count each, most-hit first.',
      inputSchema: {},
    },
    async () => {
      const rows = rawDb(store)
        .prepare(
          `SELECT method, host, path, COUNT(*) AS count
             FROM captures
            GROUP BY method, host, path
            ORDER BY count DESC, host, path`,
        )
        .all() as Array<{ method: string; host: string; path: string; count: number }>;
      return jsonResult(rows);
    },
  );

  // search_captures({ query, limit? }) -> capture metadata matching url/path/host.
  server.registerTool(
    'search_captures',
    {
      title: 'Search captures',
      description:
        'Find captures whose url, path, or host contains the query substring. Returns redacted metadata (no bodies), newest first. Default limit 50.',
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ query, limit }) => {
      const rows = rawDb(store)
        .prepare(
          `SELECT id, ts, method, host, path, status, adapter_id AS adapterId
             FROM captures
            WHERE url LIKE @q OR path LIKE @q OR host LIKE @q
            ORDER BY ts DESC
            LIMIT @limit`,
        )
        .all({ q: `%${query}%`, limit: limit ?? 50 }) as Array<{
        id: string;
        ts: number;
        method: string;
        host: string;
        path: string;
        status: number | null;
        adapterId: string | null;
      }>;
      return jsonResult(rows);
    },
  );

  // describe_endpoint({ method, path }) -> inline response-shape summary.
  server.registerTool(
    'describe_endpoint',
    {
      title: 'Describe endpoint response shape',
      description:
        'For captures matching method+path, summarize the response: observed status codes and the union of top-level JSON keys seen in response bodies. Inline inference — no schema store.',
      inputSchema: { method: z.string(), path: z.string() },
    },
    async ({ method, path }) => {
      const rows = rawDb(store)
        .prepare(
          `SELECT status, res_body AS resBody, res_body_encoding AS resBodyEncoding
             FROM captures
            WHERE method = @method AND path = @path
            ORDER BY ts DESC
            LIMIT @limit`,
        )
        .all({ method, path, limit: 100 }) as Array<{
        status: number | null;
        // Raw column value — a Buffer when resBodyEncoding says gzip. This query
        // reads the table directly, so it does not get rowToCapture's decoding
        // and must decode for itself. Getting this wrong fails SILENTLY: the
        // JSON.parse below is inside a try, so the tool would just report zero
        // samples and no keys, forever.
        resBody: string | Buffer | null;
        resBodyEncoding: string | null;
      }>;

      const statusCodes = new Set<number>();
      const responseKeys = new Set<string>();
      let jsonSampleCount = 0;
      for (const r of rows) {
        if (r.status !== null) statusCodes.add(r.status);
        const body = decodeBody(r.resBody, r.resBodyEncoding);
        if (!body) continue;
        try {
          const parsed: unknown = JSON.parse(body);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const k of Object.keys(parsed)) responseKeys.add(k);
            jsonSampleCount++;
          }
        } catch {
          // Non-JSON body (HTML error page, empty, truncated) — skip it.
        }
      }

      return jsonResult({
        method,
        path,
        sampleCount: rows.length,
        jsonSampleCount,
        statusCodes: [...statusCodes].sort((a, b) => a - b),
        responseKeys: [...responseKeys].sort(),
      });
    },
  );

  // replay({ actionId, params?, workspaceId?, adapterId? }) -> THE ONE NETWORK-TOUCHING TOOL.
  server.registerTool(
    'replay',
    {
      title: 'Replay a captured API call (MAKES A LIVE NETWORK REQUEST)',
      description:
        'The ONLY tool that performs a network call. Cold-start-extracts your local session for the owning app (may trigger a macOS Keychain prompt), re-issues the chosen replay action, stores the redacted result, and returns a summary (status + parsed entity counts). No secrets are returned, logged, or persisted. actionId must be one of the replay-action ids an installed app exposes; pass action params via `params`, and optionally pin the app with `adapterId`.',
      inputSchema: {
        actionId: z.string(),
        params: z.record(z.string()).optional(),
        workspaceId: z.string().optional(),
        adapterId: z.string().optional(),
      },
    },
    async ({ actionId, params, workspaceId, adapterId }) => {
      // Resolve the owning app + action: prefer the pinned (or first) app, then
      // fall back to scanning every installed app for the action id.
      const installed = enabledApps();
      const preferred = adapterId ? getApp(adapterId) : installed[0];
      let match: { app: App; action: ReplayAction } | undefined;
      const tryApp = (app: App): void => {
        if (match) return;
        const action = app.listReplayActions().find((a) => a.id === actionId);
        if (action) match = { app, action };
      };
      if (preferred) tryApp(preferred);
      for (const app of installed) tryApp(app);
      if (!match) {
        const ids = installed.flatMap((a) => a.listReplayActions().map((x) => x.id));
        return errorResult(`Unknown actionId "${actionId}". Available: ${ids.join(', ')}`);
      }

      const app = match.app;
      const action = match.action;

      // Resolve a Session. Apps WITH a credential provider cold-start-extract a
      // live in-memory session; credential-free apps (e.g. fast.com) replay with
      // a synthetic empty session that the builder is free to ignore.
      let session: Session;
      if (app.credentials) {
        let sessions: Session[];
        try {
          // In-memory SECRET sessions; passed only to the request builder below.
          sessions = await app.credentials.extractSessions();
        } catch (e) {
          return errorResult(`Could not acquire a session: ${errText(e)}`);
        }

        // Which workspace: the one asked for, or the one the ARGUMENTS belong to.
        //
        // Falling straight through to `sessions[0]` was a trap with four Slack
        // workspaces signed in. A `conversations.history` for a GreenTomato
        // channel, replayed with Atlagene's session, comes back HTTP 200 with
        // `{"ok":false,"error":"channel_not_found"}` — which reads as "that
        // channel does not exist" and is really "you asked the wrong workspace".
        // The store already knows which workspace owns the container, so the
        // answer is available and was simply not being looked up.
        const inferred = workspaceId ?? workspaceOfParams(store, match.action, params);
        const picked = inferred
          ? sessions.find((s) => s.workspaceId === inferred)
          : sessions.length === 1
            ? sessions[0]
            : undefined;
        if (!picked) {
          const have = sessions.map((s) => `${s.workspaceId ?? '(unknown)'} (${s.label})`).join(', ');
          if (inferred) {
            return errorResult(
              `No signed-in workspace matched "${inferred}". Have: ${have || '(none)'}.`,
            );
          }
          if (sessions.length === 0) return errorResult('No signed-in workspace found.');
          // Ambiguous, and saying so beats guessing: the guess is wrong
          // (sessions.length - 1)/sessions.length of the time, and its symptom
          // is an error message about the wrong thing entirely.
          return errorResult(
            `${sessions.length} ${app.displayName} workspaces are signed in and nothing in the ` +
              `arguments says which to use. Pass workspaceId. Have: ${have}.`,
          );
        }
        session = picked;
      } else {
        session = { ...SYNTHETIC_SESSION, adapterId: app.id };
      }

      try {
        // Replay, and on an auth failure re-extract the local credential and try
        // once more. This is the whole of D1: a long-running agent workflow used
        // to die on cookie expiry with "open the app and sign in", even though
        // the credential it needed was sitting in the OS keychain the entire
        // time. Nothing is cached — re-extraction IS the mechanism.
        let refreshed = false;
        let counts = { workspaces: 0, actors: 0, containers: 0, items: 0, edges: 0 };
        const capture = await replayWithRefresh(session, {
          // Rebuilt per attempt: the first request carries the STALE credential
          // in its headers, so reusing it would send the dead cookie back.
          build: (s) => faithfulReplayRequest(store, app.buildReplayRequest(action, params ?? {}, s)),
          run: (req) => runReplay(req),
          // Both attempts land in the store. The failed one is the evidence that
          // makes "the session expired at 14:03" answerable later.
          record: (c) => {
            c.adapterId = app.id;
            store.insertCapture(c);
            // The LAST attempt's counts are the answer; a failed first attempt
            // parses to nothing anyway, and summing both would double-count.
            counts = store.applyParseResult(app.parse(c), c.ts || Date.now());
          },
          // Credential-free apps have nothing to refresh and must never be sent
          // to a Keychain prompt they have no use for.
          refresh: app.credentials
            ? async () => {
                const again = await app.credentials?.extractSessions();
                return workspaceId ? again?.find((s) => s.workspaceId === workspaceId) : again?.[0];
              }
            : undefined,
          onRetry: () => {
            refreshed = true;
          },
        });
        return jsonResult({
          note: 'This tool made a live network request.',
          // Surfaced so an agent can tell "it worked" from "it worked on the
          // second try after your session expired" — the second is worth knowing.
          credentialRefreshed: refreshed || undefined,
          actionId,
          captureId: capture.id,
          status: capture.status,
          method: capture.method,
          host: capture.host,
          path: capture.path,
          durationMs: capture.durationMs,
          parsed: counts,
        });
      } catch (e) {
        return errorResult(`Replay failed: ${errText(e)}`);
      }
    },
  );

  // auth_flow() -> how the service issues/refreshes the credential you hold.
  server.registerTool(
    'auth_flow',
    {
      title: 'Map the auth flow',
      description:
        'Derive from captured traffic which endpoints issue credentials, which refresh them, and what later requests depend on them. Never returns a secret — names, endpoints, counts and redacted previews only.',
      inputSchema: { app: z.string().optional() },
    },
    async ({ app }) => jsonResult(mapAuthFlow(store.listCaptures({ limit: 1_000_000, adapterId: app }), app ?? null)),
  );

  // App-contributed MCP tools (e.g. fast.com's speed test, Gmail's mailbox
  // reads). Each installed app
  // may expose zero or more; register them under their own names. A tool's `run`
  // may touch the network, so wrap it: a thrown error becomes a tool error rather
  // than crashing the handler, and its message is redacted before leaving.
  //
  // Only the apps this machine has ENABLED. A client that installed Sluice for
  // Gmail was being shown Slack's and Trello's tools too — tools it cannot use,
  // occupying the tool budget of every request it makes.
  for (const app of enabledApps()) {
    /**
     * The same pipeline `sluice_replay` uses, handed to the app's own tools so
     * their traffic is fingerprint-matched, rate-limited, and recorded — rather
     * than escaping through a bare `fetch` that nothing can see.
     */
    const record = (capture: Capture): void => {
      capture.adapterId = app.id; // attribute so the cartographer + stats include it
      store.insertCapture(capture);
      store.applyParseResult(app.parse(capture), capture.ts || Date.now());
    };
    const ctx: AppToolContext = {
      // Read-only by VALUE, not merely by type: `SqliteStore` satisfies
      // `ReadOnlyStore` structurally, so passing it straight through would hand
      // an app tool `insertCapture`, `pruneCaptures` and the raw `db` handle
      // alongside the reads it actually needs.
      store: readOnlyStore(store),
      replay: async (base) => {
        // An app tool gets the same 401 → re-extract → retry-once treatment as
        // sluice_replay. It cannot rebuild the request from a Session (the tool
        // handed us a finished ReplayRequest), so the refresh here is "ask the
        // app for a fresh session and let it re-inject" — apps whose tools build
        // their own auth, like Trello's cookie header, refresh internally
        // instead. Both paths retry exactly once.
        const capture = await replayWithRefresh(SYNTHETIC_SESSION, {
          build: () => faithfulReplayRequest(store, base),
          run: (req) => runReplay(req),
          record,
        });
        return capture;
      },
    };

    for (const t of app.mcpTools?.() ?? []) {
      // Pass the tool's declared parameters through. This used to be hardcoded
      // to `{}`, which told every client the tool took no arguments — so `run`
      // could never receive any, no matter what it was typed to accept.
      const inputSchema = (t.inputSchema ?? {}) as ZodRawShape;
      server.registerTool(
        t.name,
        { title: t.name, description: t.description, inputSchema },
        async (args) => {
          try {
            return jsonResult(await t.run((args ?? {}) as Record<string, unknown>, ctx));
          } catch (e) {
            return errorResult(errText(e));
          }
        },
      );
    }
  }

  return server;
}

// ── Start ───────────────────────────────────────────────────────────────────────

/**
 * Open the store, build the server, and serve it over stdio. Resolves once the
 * transport is connected; the process then stays alive handling MCP requests.
 */
export async function startStdioServer(): Promise<void> {
  const store = openStore();
  // Before the catalog is built, so an external adapter's tools are registered
  // like any other app's. Same explicit opt-in as the runner: only what
  // `~/.sluice/config.json` names is loaded.
  for (const r of (await installExternalAdapters()).rejected) {
    process.stderr.write(`[sluice-mcp] external adapter ${r.specifier} rejected: ${r.reason}\n`);
  }
  // Before the first tool call, not after: a store written by a capture session
  // that ended without reconciling holds mail under a placeholder workspace, and
  // a placeholder is not a name any caller can pass as `account`. That mail
  // would read as an empty mailbox rather than as an unattributed one, which is
  // the failure mode worth spending a few milliseconds of startup on.
  for (const app of enabledApps()) {
    if (app.reconcile === undefined) continue;
    try {
      const { changed, note } = app.reconcile(store);
      if (changed > 0 || note !== undefined) {
        process.stderr.write(`[sluice-mcp] ${app.id}: ${note ?? `${changed} identities settled`}\n`);
      }
    } catch (e) {
      process.stderr.write(`[sluice-mcp] ${app.id} reconcile failed: ${errText(e)}\n`);
    }
  }
  const server = buildServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout carries the MCP protocol.
  process.stderr.write(`[sluice-mcp] serving Sluice store ${defaultDbPath()} over stdio\n`);
}
