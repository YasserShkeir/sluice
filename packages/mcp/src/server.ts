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
import { enabledApps, installExternalAdapters } from '@sluice/apps';
import { buildFlowStepRequest, faithfulReplayRequest } from '@sluice/cartographer';
import { mapAuthFlow, replayWithRefresh, runFlowReplay, runReplay, resolveJsonPath } from '@sluice/interceptor';

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

/**
 * Pick exactly one session: explicit/inferred workspace, or the sole session.
 * Multi-session without a workspace is an error — never silent sessions[0].
 */
export function pickSession(
  sessions: Session[],
  workspaceId: string | undefined,
  appLabel = 'app',
): { ok: true; session: Session } | { ok: false; error: string } {
  const inferred = workspaceId;
  const picked = inferred
    ? sessions.find((s) => s.workspaceId === inferred)
    : sessions.length === 1
      ? sessions[0]
      : undefined;
  if (picked) return { ok: true, session: picked };
  const have = sessions.map((s) => `${s.workspaceId ?? '(unknown)'} (${s.label})`).join(', ');
  if (inferred) {
    return {
      ok: false,
      error: `No signed-in workspace matched "${inferred}". Have: ${have || '(none)'}.`,
    };
  }
  if (sessions.length === 0) return { ok: false, error: 'No signed-in workspace found.' };
  return {
    ok: false,
    error: `${sessions.length} ${appLabel} workspaces are signed in. Pass workspaceId. Have: ${have}.`,
  };
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
 * `replay` / `sluice_replay_flow`, which are the network-touching tools.
 */

/** Secret-free template summary for MCP describe/list. */
function summarizeTemplate(t: {
  id: string;
  adapterId: string;
  primaryKey: string;
  label?: string;
  sampleCount: number;
  version: number;
  learnedAt: number;
  steps: Array<{
    seq: number;
    role: string;
    method: string;
    path: string;
    operation?: string;
    required: boolean;
    support: number;
    delayMsP50: number;
    offsetFromPrimaryMsP50?: number;
    offsetSpreadMs?: number;
    unreproducible?: boolean;
    unreproducibleReason?: string;
    params?: Record<string, { kind: string; name?: string; fromStep?: number; jsonPath?: string; reason?: string }>;
  }>;
  flowParams: Array<{ name: string; required: boolean }>;
}): Record<string, unknown> {
  const steps = t.steps.map((s) => ({
    seq: s.seq,
    role: s.role,
    method: s.method,
    path: s.path,
    operation: s.operation,
    required: s.required,
    support: s.support,
    delayMsP50: s.delayMsP50,
    /** Median ms from primary start (may be negative for pre-primary auth/bootstrap). */
    offsetFromPrimaryMsP50: s.offsetFromPrimaryMsP50,
    offsetSpreadMs: s.offsetSpreadMs,
    unreproducible: s.unreproducible || undefined,
    unreproducibleReason: s.unreproducibleReason,
    params: s.params
      ? Object.fromEntries(
          Object.entries(s.params).map(([k, src]) => [
            k,
            {
              kind: src.kind,
              name: src.name,
              fromStep: src.fromStep,
              jsonPath: src.jsonPath,
              reason: src.reason,
            },
          ]),
        )
      : undefined,
  }));
  const apiSteps = steps.filter(
    (s) =>
      s.role === 'primary' ||
      (s.operation &&
        !/^assets?\b/i.test(s.operation) &&
        !/\.(js|css|png|svg)(\?|$)/i.test(s.path)),
  );
  const negOffsets = steps.filter(
    (s) => typeof s.offsetFromPrimaryMsP50 === 'number' && s.offsetFromPrimaryMsP50 < 0,
  ).length;
  return {
    id: t.id,
    adapterId: t.adapterId,
    primaryKey: t.primaryKey,
    label: t.label,
    sampleCount: t.sampleCount,
    version: t.version,
    learnedAt: t.learnedAt,
    flowParams: t.flowParams,
    stepCount: steps.length,
    /** Steps that look like API (not SPA bundles) — prefer these when explaining a flow. */
    apiStepCount: apiSteps.length,
    /** Pre-primary companions (auth/bootstrap). Replay fires them immediately if still pending. */
    negativeOffsetSteps: negOffsets || undefined,
    qualityNotes: templateQualityNotes(t.primaryKey, steps.length, apiSteps.length, t.sampleCount, negOffsets),
    steps,
  };
}

function templateQualityNotes(
  primaryKey: string,
  stepCount: number,
  apiStepCount: number,
  sampleCount: number,
  negOffsets: number,
): string[] {
  const notes: string[] = [];
  if (/^assets?\b/i.test(primaryKey) || primaryKey === 'asset') {
    notes.push('primary looks like a static asset — prefer another template for agent replay');
  }
  if (sampleCount < 2) {
    notes.push('single-sample template — timing and companions are less reliable until more bursts are learned');
  }
  if (stepCount > 0 && apiStepCount / stepCount < 0.4) {
    notes.push('many non-API companions (SPA bundles); soft steps may skip at replay');
  }
  if (negOffsets > 0) {
    notes.push(
      'some offsetFromPrimaryMsP50 values are negative (companions observed before the learned primary); pacing clamps those to immediate',
    );
  }
  if (primaryKey.includes('graphql') || primaryKey.includes('gateway/api/gasv3')) {
    notes.push(
      'gateway/GraphQL primaries often sit inside large page-load bursts — confirm flowParams and required steps before replay',
    );
  }
  return notes;
}

// FLOW_AGENT_GUIDANCE is inlined into tool descriptions so every MCP client
// sees the same operational contract without reading a separate doc.
const FLOW_LIST_DESCRIPTION =
  "List observed/pinned interaction flows and learned multi-step templates from THIS machine's captures only. " +
  'Returns ids, primary ops, step counts, sampleCount, qualityNotes — never secrets, cookies, tokens, or bodies. ' +
  'Flows = one observed burst (primary + companions). Templates = parameterizable plans for sluice_replay_flow. ' +
  'Agent guidance: (1) Prefer templates with sampleCount≥2 and primaryKey that is a real API op (cards/:id, boards/:id, conversations.history) — not assets/* or bare hashed filenames. ' +
  '(2) MITM/WS capture has no pageLoadId; bursts are time-window clustered. CDP adds loaderId correlation when available. ' +
  '(3) WebSocket frames are excluded from HTTP flow clustering. ' +
  '(4) Call sluice_describe_flow before replay. Optional adapterId/source/q. Default limit 50.';

const FLOW_DESCRIBE_DESCRIPTION =
  'Detail one interaction flow (by flow id) or learned template (by template id or adapterId+primaryKey). ' +
  'Shows ordered steps, roles, required/support, delayMsP50, offsetFromPrimaryMsP50 (sibling timing from primary start; may be negative for pre-primary auth), ' +
  'offsetSpreadMs, param binding kinds (flowParam|bind|session|literal|unreproducible), qualityNotes. ' +
  'Never returns secrets, live tokens, or full bodies — binding kinds and names only. ' +
  'Agent guidance: required=false companions may soft-fail or skip; unreproducible steps are not guessed; ' +
  'F4.4 build rails refuse write-shaped ops and hosts outside the adapter allowlist. Pass id, or adapterId+primaryKey.';

const FLOW_REPLAY_DESCRIPTION =
  'Run a learned multi-step flow template READ-ONLY through the same rails as single replay ' +
  '(method allowlist GET|HEAD|POST, operation denylist, per-step budget, adapter hosts allowlist at build). ' +
  "Built only from this machine's observed/pinned captures — never invents fingerprints or credentials. " +
  'Pacing prefers offsetFromPrimaryMsP50 (primary-anchored; cap 2s) so siblings keep observed deltas when a soft step skips; falls back to delayMsP50. ' +
  'Auth failure → optional session refresh → full flow restart once. ' +
  'Unreproducible soft companions are skipped; required failures stop the flow. ' +
  'Agent guidance: pass params for every required flowParam from sluice_describe_flow; pick workspaceId when multiple sessions exist; ' +
  'expect SPA asset steps to be absent or skipped; do not use flow replay for writes. ' +
  'Returns per-step status summaries + parent flow id. No secrets returned.';

/**
 * Build (but do not start) the MCP server bound to an already-open store.
 * Every tool is a thin, typed wrapper over `@sluice/core` store reads, except
 * `replay` / `sluice_replay_flow`, which are the network-touching tools.
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
      const preferred = adapterId ? installed.find((a) => a.id === adapterId) : installed[0];
      if (adapterId && !preferred) {
        return errorResult(
          `Adapter "${adapterId}" is not enabled. Enable it in ~/.sluice/config.json or omit adapterId.`,
        );
      }
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
      // Workspace for first pick AND 401-refresh — one value for both paths.
      const inferred =
        workspaceId ?? workspaceOfParams(store, action, params);

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

        const choice = pickSession(sessions, inferred, app.displayName);
        if (!choice.ok) return errorResult(choice.error);
        session = choice.session;
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
                const again = (await app.credentials?.extractSessions()) ?? [];
                // Same inferred workspace as the first pick — never sessions[0] on multi.
                const choice = pickSession(again, inferred, app.displayName);
                return choice.ok ? choice.session : undefined;
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


  // ── Interaction flows (multi-step, observation-learned) ────────────────────

  server.registerTool(
    'sluice_list_flows',
    {
      title: 'List interaction flows and templates',
      description: FLOW_LIST_DESCRIPTION,
      inputSchema: {
        adapterId: z.string().optional(),
        source: z.enum(['observed', 'pinned', 'replay', 'learned']).optional(),
        q: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        templates: z.boolean().optional(),
      },
    },
    async ({ adapterId, source, q, limit, templates }) => {
      const lim = limit ?? 50;
      const flows = store.listFlows({ adapterId, source, q, limit: lim }).map((f) => ({
        id: f.id,
        adapterId: f.adapterId,
        label: f.label,
        source: f.source,
        primaryCaptureId: f.primaryCaptureId,
        primaryOp:
          f.steps.find((s) => s.captureId === f.primaryCaptureId)?.operation ??
          f.steps.find((s) => s.role === 'primary')?.operation,
        stepCount: f.steps.length,
        startedAt: f.startedAt,
        endedAt: f.endedAt,
      }));
      const out: Record<string, unknown> = {
        flows,
        guidance: {
          prefer: 'templates with sampleCount≥2 and API primaryKey (not assets/*)',
          next: 'sluice_describe_flow → sluice_replay_flow',
          learn: 'Run CLI `sluice learn-flows --adapter <id>` after capturing; MCP does not cluster',
          correlation:
            'pageLoadId/loaderId only when CDP captured; MITM bursts use time windows only',
        },
      };
      if (templates !== false) {
        out.templates = store.listFlowTemplates({ adapterId, q, limit: lim }).map((t) => {
          const apiStepCount = t.steps.filter(
            (s) =>
              s.role === 'primary' ||
              (s.operation && !/^assets?\b/i.test(s.operation) && !/^\/assets\//i.test(s.path)),
          ).length;
          const neg = t.steps.filter(
            (s) => typeof s.offsetFromPrimaryMsP50 === 'number' && s.offsetFromPrimaryMsP50 < 0,
          ).length;
          return {
            id: t.id,
            adapterId: t.adapterId,
            primaryKey: t.primaryKey,
            label: t.label,
            sampleCount: t.sampleCount,
            stepCount: t.steps.length,
            apiStepCount,
            flowParams: t.flowParams,
            learnedAt: t.learnedAt,
            version: t.version,
            qualityNotes: templateQualityNotes(
              t.primaryKey,
              t.steps.length,
              apiStepCount,
              t.sampleCount,
              neg,
            ),
          };
        });
      }
      return jsonResult(out);
    },
  );

  server.registerTool(
    'sluice_describe_flow',
    {
      title: 'Describe a flow or flow template',
      description: FLOW_DESCRIBE_DESCRIPTION,
      inputSchema: {
        id: z.string().optional(),
        adapterId: z.string().optional(),
        primaryKey: z.string().optional(),
      },
    },
    async ({ id, adapterId, primaryKey }) => {
      if (id) {
        const flow = store.getFlow(id);
        if (flow) {
          return jsonResult({
            kind: 'flow',
            id: flow.id,
            adapterId: flow.adapterId,
            label: flow.label,
            source: flow.source,
            primaryCaptureId: flow.primaryCaptureId,
            startedAt: flow.startedAt,
            endedAt: flow.endedAt,
            steps: flow.steps.map((s) => ({
              seq: s.seq,
              role: s.role,
              operation: s.operation,
              required: s.required,
              captureId: s.captureId,
            })),
          });
        }
        const tmpl = store.getFlowTemplate(id);
        if (tmpl) return jsonResult({ kind: 'template', ...summarizeTemplate(tmpl) });
        return errorResult(`No flow or template with id "${id}".`);
      }
      if (adapterId && primaryKey) {
        const tmpl = store.getFlowTemplateByPrimary(adapterId, primaryKey);
        if (!tmpl) {
          return errorResult(`No template for ${adapterId} / ${primaryKey}. Run learn-flows first.`);
        }
        return jsonResult({ kind: 'template', ...summarizeTemplate(tmpl) });
      }
      return errorResult('Pass id, or adapterId + primaryKey.');
    },
  );

  server.registerTool(
    'sluice_replay_flow',
    {
      title: 'Replay a multi-step flow (MAKES LIVE NETWORK REQUESTS)',
      description: FLOW_REPLAY_DESCRIPTION,
      inputSchema: {
        templateId: z.string().optional(),
        adapterId: z.string().optional(),
        primaryKey: z.string().optional(),
        params: z.record(z.string()).optional(),
        workspaceId: z.string().optional(),
      },
    },
    async ({ templateId, adapterId, primaryKey, params, workspaceId }) => {
      let tmpl = templateId ? store.getFlowTemplate(templateId) : undefined;
      if (!tmpl && adapterId && primaryKey) {
        tmpl = store.getFlowTemplateByPrimary(adapterId, primaryKey);
      }
      if (!tmpl) {
        return errorResult(
          'Unknown flow template. Pass templateId from sluice_list_flows, or adapterId + primaryKey after learn-flows.',
        );
      }

      const app = enabledApps().find((a) => a.id === tmpl.adapterId);
      if (!app) {
        return errorResult(
          `No enabled app for adapter "${tmpl.adapterId}". Enable it in ~/.sluice/config.json.`,
        );
      }

      let session: Session;
      if (app.credentials) {
        let sessions: Session[];
        try {
          sessions = await app.credentials.extractSessions();
        } catch (e) {
          return errorResult(`Could not acquire a session: ${errText(e)}`);
        }
        const choice = pickSession(sessions, workspaceId, app.displayName);
        if (!choice.ok) return errorResult(choice.error);
        session = choice.session;
      } else {
        session = { ...SYNTHETIC_SESSION, adapterId: app.id };
      }

      try {
        const result = await runFlowReplay({
          template: tmpl,
          params: params ?? {},
          session,
          io: {
            build: (step, s, ctx) =>
              buildFlowStepRequest(tmpl!, step, s, {
                params: ctx.params,
                priorResponses: ctx.priorResponses,
                resolvePath: resolveJsonPath,
                allowedHosts: app.hosts,
              }),
            run: (req) => runReplay(req),
            record: (c) => {
              c.adapterId = app.id;
              store.insertCapture(c);
              store.applyParseResult(app.parse(c), c.ts || Date.now());
            },
            refresh: app.credentials
              ? async () => {
                  const again = (await app.credentials?.extractSessions()) ?? [];
                  const choice = pickSession(again, workspaceId, app.displayName);
                  return choice.ok ? choice.session : undefined;
                }
              : undefined,
          },
        });

        if (result.flow) {
          try {
            store.upsertFlow(result.flow);
          } catch {
            /* parent flow persist is best-effort */
          }
        }

        return jsonResult({
          note: 'This tool made live network request(s) for each reproducible step.',
          ok: result.ok,
          error: result.error,
          refreshed: result.refreshed || undefined,
          flowId: result.flow?.id,
          templateId: tmpl.id,
          primaryKey: tmpl.primaryKey,
          steps: result.steps.map((s) => ({
            seq: s.seq,
            role: s.role,
            operation: s.operation,
            method: s.method,
            path: s.path,
            status: s.status,
            captureId: s.captureId,
            httpStatus: s.httpStatus,
            detail: s.detail,
            durationMs: s.durationMs,
          })),
        });
      } catch (e) {
        return errorResult(`Flow replay failed: ${errText(e)}`);
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
      replayFlow: async (templateId, flowParams, flowOpts) => {
        const tmpl = store.getFlowTemplate(templateId)
          ?? store.getFlowTemplateByPrimary(app.id, templateId);
        if (!tmpl) throw new Error(`Unknown flow template "${templateId}"`);
        let session: Session = { ...SYNTHETIC_SESSION, adapterId: app.id };
        const flowWs = flowOpts?.workspaceId;
        if (app.credentials) {
          const sessions = await app.credentials.extractSessions();
          const choice = pickSession(sessions, flowWs, app.displayName);
          if (!choice.ok) throw new Error(choice.error);
          session = choice.session;
        }
        const result = await runFlowReplay({
          template: tmpl,
          params: flowParams ?? {},
          session,
          io: {
            build: (step, s, ctxB) =>
              buildFlowStepRequest(tmpl, step, s, {
                params: ctxB.params,
                priorResponses: ctxB.priorResponses,
                resolvePath: resolveJsonPath,
                allowedHosts: app.hosts,
              }),
            run: (req) => runReplay(req),
            record: (c, _step) => {
              record(c);
            },
            refresh: app.credentials
              ? async () => {
                  const again = (await app.credentials?.extractSessions()) ?? [];
                  const choice = pickSession(again, flowWs, app.displayName);
                  return choice.ok ? choice.session : undefined;
                }
              : undefined,
          },
        });
        if (result.flow) {
          try {
            store.upsertFlow(result.flow);
          } catch {
            /* best-effort */
          }
        }
        return {
          ok: result.ok,
          error: result.error,
          flowId: result.flow?.id,
          steps: result.steps.map((s) => ({
            seq: s.seq,
            status: s.status,
            operation: s.operation,
            captureId: s.captureId,
            httpStatus: s.httpStatus,
          })),
        };
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
