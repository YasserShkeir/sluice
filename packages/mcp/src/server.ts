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

import {
  anonymousSession,
  decodeBody,
  redactedErrorMessage as errText,
  flowStepSummary,
  flowSummary,
  paramSourcesSummary,
  persistCapture,
  readOnlyStore,
  safeJsonObject,
  SqliteStore,
  templateStepSummary,
  templateSummary,
  workspaceOfParams,
} from '@sluice/core';
import type {
  App,
  AppToolContext,
  Capture,
  FlowTemplate,
  ReplayAction,
  Session,
  UpsertCounts,
} from '@sluice/core';
import { enabledApps, installExternalAdapters } from '@sluice/apps';
// The same bound the dashboard's replay.run / flow.run frames use.
import { replayParamsSchema } from '@sluice/protocol';
import { FLOW_TEMPLATE_VERSION, faithfulReplayRequest, flowStepBuilder } from '@sluice/cartographer';
import { mapAuthFlow, replayWithRefresh, runFlowReplay, runReplay } from '@sluice/interceptor';
import type { FlowReplayResult } from '@sluice/interceptor';

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

/** Which session to act as: an agent's explicit `workspaceId`, else one `inferred` from the request's params. */
interface SessionWant {
  workspaceId?: string;
  inferred?: string;
}

/**
 * Pick exactly one session — never a silent sessions[0]. An explicit
 * `workspaceId` must match a signed-in session. An `inferred` one picks its
 * owner when one is signed in; a workspace nobody owns (a synthetic or
 * unreconciled id) says nothing about which account to use, so it falls
 * through to the sole session, as the runner's picker does. Several sessions
 * with nothing to choose by is an error.
 */
function pickSession(
  sessions: Session[],
  want: SessionWant,
  appLabel: string,
): { ok: true; session: Session } | { ok: false; error: string } {
  const id = want.workspaceId || want.inferred;
  const owner = id === undefined ? undefined : sessions.find((s) => s.workspaceId === id);
  if (owner) return { ok: true, session: owner };
  const have = sessions.map((s) => `${s.workspaceId ?? '(unknown)'} (${s.label})`).join(', ');
  if (want.workspaceId) {
    return {
      ok: false,
      error: `No signed-in workspace matched "${want.workspaceId}". Have: ${have || '(none)'}.`,
    };
  }
  const [only] = sessions;
  if (sessions.length === 1 && only) return { ok: true, session: only };
  if (sessions.length === 0) return { ok: false, error: 'No signed-in workspace found.' };
  return {
    ok: false,
    error: `${sessions.length} ${appLabel} workspaces are signed in. Pass workspaceId. Have: ${have}.`,
  };
}

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
 * The session a replay for `app` runs under. Apps WITH a credential provider
 * cold-start-extract a live in-memory session (SECRET: it goes to the request
 * builder and nowhere else); credential-free apps (e.g. fast.com) get the
 * anonymous empty session, which the builder is free to ignore.
 *
 * Exported for tests; not part of the package surface.
 */
export async function acquireSession(
  app: App,
  want: SessionWant,
): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
  if (!app.credentials) return { ok: true, session: anonymousSession(app.id) };
  let sessions: Session[];
  try {
    sessions = await app.credentials.extractSessions();
  } catch (e) {
    return { ok: false, error: `Could not acquire a session: ${errText(e)}` };
  }
  return pickSession(sessions, want, app.displayName);
}

/**
 * The auth-failure refresh hook: re-extract and pick the SAME workspace as the
 * session first picked (pass its `workspaceId`), strictly — a 401 after that
 * workspace signed out must not retry as another account. Credential-free apps
 * have nothing to refresh and must never be sent to a Keychain prompt they have
 * no use for.
 */
function sessionRefresher(
  app: App,
  workspaceId: string | undefined,
): (() => Promise<Session | undefined>) | undefined {
  const credentials = app.credentials;
  if (!credentials) return undefined;
  return async () => {
    const choice = pickSession(await credentials.extractSessions(), { workspaceId }, app.displayName);
    return choice.ok ? choice.session : undefined;
  };
}

/**
 * One of `app`'s replay actions, end to end: acquire the session (for the given
 * workspace, else the one the params name), build and fingerprint the request,
 * send it under the app's host rail, record every attempt, and on an auth
 * failure re-extract the SAME workspace and retry once. The single path the
 * `replay` tool and `ctx.replayAction` share. A session failure is returned; a
 * build or send failure throws.
 *
 * Exported for tests; not part of the package surface.
 */
export async function replayActionFor(
  store: SqliteStore,
  app: App,
  action: ReplayAction,
  params: Record<string, string>,
  workspaceId: string | undefined,
): Promise<{ ok: true; capture: Capture; counts: UpsertCounts; refreshed: boolean } | { ok: false; error: string }> {
  // An explicit workspace is strict; one read off the params is a hint.
  const inferred = workspaceId === undefined ? workspaceOfParams(store, action, params) : undefined;
  // In-memory SECRET session; passed only to the request builder below.
  const choice = await acquireSession(app, { workspaceId, inferred });
  if (!choice.ok) return choice;

  // On an auth failure re-extract the local credential and retry once;
  // nothing is cached — re-extraction IS the mechanism.
  let refreshed = false;
  let counts: UpsertCounts = { workspaces: 0, actors: 0, containers: 0, items: 0, edges: 0 };
  let stored: Capture | undefined;
  const capture = await replayWithRefresh(choice.session, {
    // Rebuilt per attempt: the first request carries the STALE credential in
    // its headers, so reusing it would send the dead cookie back.
    build: (s) => faithfulReplayRequest(store, app.buildReplayRequest(action, params, s)),
    run: (req) => runReplay(req, { allowedHosts: app.hosts }),
    // Both attempts land in the store — the failed one is the evidence that
    // makes "the session expired at 14:03" answerable later. The LAST attempt's
    // counts are the answer; summing both would double-count.
    record: (c) => {
      ({ capture: stored, counts } = persistCapture(store, c, app));
    },
    refresh: sessionRefresher(app, choice.session.workspaceId),
    onRetry: () => {
      refreshed = true;
    },
  });
  return { ok: true, capture: stored ?? capture, counts, refreshed };
}

/**
 * Run one learned template under `session` through the flow rails (build-time
 * host + read-action rails, then the runtime rails), record every step capture
 * against `app` and keep the parent flow; `runFlowReplay` redacts error/step
 * details. The single path `sluice_replay_flow` and `ctx.replayFlow` share.
 */
async function replayTemplate(
  store: SqliteStore,
  app: App,
  tmpl: FlowTemplate,
  params: Record<string, string>,
  session: Session,
): Promise<FlowReplayResult> {
  const result = await runFlowReplay({
    template: tmpl,
    params,
    session,
    io: {
      build: flowStepBuilder(tmpl, app),
      run: (req) => runReplay(req, { allowedHosts: app.hosts }),
      record: (c) => {
        persistCapture(store, c, app);
      },
      refresh: sessionRefresher(app, session.workspaceId),
    },
  });
  if (result.flow) {
    try {
      store.upsertFlow(result.flow);
    } catch {
      /* parent flow persist is best-effort */
    }
  }
  return result;
}

/**
 * A step that looks like an API call rather than an SPA bundle or static file.
 * The primary always counts. One rule for list and describe, so the two views
 * can never report different numbers for the same template.
 */
function isApiStep(s: { role: string; operation?: string; path: string }): boolean {
  if (s.role === 'primary') return true;
  return (
    Boolean(s.operation) &&
    !/^assets?\b/i.test(s.operation ?? '') &&
    !/\.(js|css|png|svg)(\?|$)/i.test(s.path) &&
    !/^\/assets\//i.test(s.path)
  );
}

/** How much of a template is worth an agent's attention, and why not. */
function templateQuality(t: FlowTemplate): {
  apiStepCount: number;
  negativeOffsetSteps: number;
  qualityNotes: string[];
} {
  const apiStepCount = t.steps.filter(isApiStep).length;
  const negativeOffsetSteps = t.steps.filter((s) => (s.offsetFromPrimaryMsP50 ?? 0) < 0).length;
  const notes: string[] = [];
  if (t.version < FLOW_TEMPLATE_VERSION) {
    notes.push(
      "learned by an older Sluice — steps without a learned host, or non-GET steps outside the app's read actions, are refused; re-run `sluice learn-flows`",
    );
  }
  if (/^assets?\b/i.test(t.primaryKey)) {
    notes.push('primary looks like a static asset — prefer another template for agent replay');
  }
  if (t.sampleCount < 2) {
    notes.push('single-sample template — timing and companions are less reliable until more bursts are learned');
  }
  if (t.steps.length > 0 && apiStepCount / t.steps.length < 0.4) {
    notes.push('many non-API companions (SPA bundles); soft steps may skip at replay');
  }
  if (negativeOffsetSteps > 0) {
    notes.push(
      'some offsetFromPrimaryMsP50 values are negative (companions observed before the learned primary); pacing clamps those to immediate',
    );
  }
  if (t.primaryKey.includes('graphql') || t.primaryKey.includes('gateway/api/gasv3')) {
    notes.push(
      'gateway/GraphQL primaries often sit inside large page-load bursts — confirm flowParams and required steps before replay',
    );
  }
  return { apiStepCount, negativeOffsetSteps, qualityNotes: notes };
}

/** Secret-free template summary for MCP describe: never a literal value or a request fingerprint. */
function summarizeTemplate(t: FlowTemplate): Record<string, unknown> {
  const q = templateQuality(t);
  return {
    ...templateSummary(t),
    /** Steps that look like API (not SPA bundles) — prefer these when explaining a flow. */
    apiStepCount: q.apiStepCount,
    /** Pre-primary companions (auth/bootstrap). Replay fires them immediately if still pending. */
    negativeOffsetSteps: q.negativeOffsetSteps || undefined,
    qualityNotes: q.qualityNotes,
    steps: t.steps.map((s) => ({ ...templateStepSummary(s), params: paramSourcesSummary(s.params) })),
  };
}

/**
 * The same pipeline `replay` uses, handed to an app's own MCP tools so their
 * traffic is fingerprint-matched, rate-limited, sent under the app's host rail,
 * and recorded — rather than escaping through a bare `fetch` nothing can see.
 *
 * Exported for tests; not part of the package surface.
 */
export function appToolContext(store: SqliteStore, app: App): AppToolContext {
  return {
    // Read-only by VALUE, not merely by type: `SqliteStore` satisfies
    // `ReadOnlyStore` structurally, so passing it straight through would hand
    // an app tool `insertCapture`, `pruneCaptures` and the raw `db` handle
    // alongside the reads it actually needs.
    store: readOnlyStore(store),
    replay: async (base) => {
      // One attempt, no host-side refresh: the tool's request carries its own
      // credentials, so there is no Session to re-extract (apps that build their
      // own auth refresh themselves). A tool that needs the app's session and
      // its 401 retry uses replayAction below.
      const capture = await runReplay(faithfulReplayRequest(store, base), { allowedHosts: app.hosts });
      return persistCapture(store, capture, app).capture;
    },
    replayAction: async (actionId, actionParams, actionOpts) => {
      // Only this app's own declared actions: its session never builds
      // another app's request.
      const action = app.listReplayActions().find((a) => a.id === actionId);
      if (!action) throw new Error(`Unknown replay action "${actionId}" for ${app.id}`);
      const out = await replayActionFor(store, app, action, actionParams ?? {}, actionOpts?.workspaceId);
      if (!out.ok) throw new Error(out.error);
      return out.capture;
    },
    replayFlow: async (templateId, flowParams, flowOpts) => {
      const tmpl = store.getFlowTemplate(templateId)
        ?? store.getFlowTemplateByPrimary(app.id, templateId);
      // Sessions are adapter-scoped: this app's session never runs another
      // app's template, even one whose steps its host rail would refuse.
      if (!tmpl || tmpl.adapterId !== app.id) {
        throw new Error(`Unknown flow template "${templateId}" for ${app.id}`);
      }
      const choice = await acquireSession(app, { workspaceId: flowOpts?.workspaceId });
      if (!choice.ok) throw new Error(choice.error);
      const result = await replayTemplate(store, app, tmpl, flowParams ?? {}, choice.session);
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
}

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
  "F4.4 build rails refuse write-shaped ops, non-GET steps that match none of the app's replay actions, and hosts outside the adapter allowlist. " +
  'Pass id, or adapterId+primaryKey.';

const FLOW_REPLAY_DESCRIPTION =
  'Run a learned multi-step flow template for reads through the same rails as single replay ' +
  "(method allowlist GET|HEAD|POST, non-GET steps only when they match one of the app's replay actions, best-effort write-operation denylist, " +
  'per-step budget, adapter hosts allowlist at build and at send). The rails are heuristics, not a proof that nothing is mutated. ' +
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

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description: 'List every captured workspace (id, adapterId, name, domain).',
      inputSchema: {},
    },
    async () => jsonResult(store.listWorkspaces()),
  );

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

  server.registerTool(
    'list_endpoints',
    {
      title: 'List captured endpoints',
      description:
        'Distinct method+host+path across all captures, with a call count each, most-hit first.',
      inputSchema: {},
    },
    async () => {
      const rows = store.db
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
      const rows = store.db
        .prepare(
          `SELECT id, ts, method, host, path, status, adapter_id AS adapterId
             FROM captures
            WHERE url LIKE @q OR path LIKE @q OR host LIKE @q
            ORDER BY ts DESC
            LIMIT @limit`,
        )
        .all({ q: `%${query}%`, limit: limit ?? 50 });
      return jsonResult(rows);
    },
  );

  server.registerTool(
    'describe_endpoint',
    {
      title: 'Describe endpoint response shape',
      description:
        'For captures matching method+path, summarize the response: observed status codes and the union of top-level JSON keys seen in response bodies. Inline inference — no schema store.',
      inputSchema: { method: z.string(), path: z.string() },
    },
    async ({ method, path }) => {
      const rows = store.db
        .prepare(
          `SELECT status, res_body AS resBody, res_body_encoding AS resBodyEncoding
             FROM captures
            WHERE method = @method AND path = @path
            ORDER BY ts DESC
            LIMIT @limit`,
        )
        .all({ method, path, limit: 100 }) as Array<{
        status: number | null;
        // Raw column (no rowToCapture decoding): a Buffer when gzip-encoded, so
        // decodeBody it — a miss fails silently as zero keys.
        resBody: string | Buffer | null;
        resBodyEncoding: string | null;
      }>;

      const statusCodes = new Set<number>();
      const responseKeys = new Set<string>();
      let jsonSampleCount = 0;
      for (const r of rows) {
        if (r.status !== null) statusCodes.add(r.status);
        // A non-object body (HTML error page, empty, truncated) is skipped.
        const o = safeJsonObject(decodeBody(r.resBody, r.resBodyEncoding));
        if (o) {
          for (const k of Object.keys(o)) responseKeys.add(k);
          jsonSampleCount++;
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

  server.registerTool(
    'replay',
    {
      title: 'Replay a captured API call (MAKES A LIVE NETWORK REQUEST)',
      description:
        'The ONLY tool that performs a network call. Cold-start-extracts your local session for the owning app (may trigger a macOS Keychain prompt), re-issues the chosen replay action, stores the redacted result, and returns a summary (status + parsed entity counts). No secrets are returned, logged, or persisted. actionId must be one of the replay-action ids an installed app exposes; pass action params via `params`, and optionally pin the app with `adapterId`.',
      inputSchema: {
        actionId: z.string(),
        params: replayParamsSchema.optional(),
        workspaceId: z.string().optional(),
        adapterId: z.string().optional(),
      },
    },
    async ({ actionId, params, workspaceId, adapterId }) => {
      // The owning app + action: the first enabled app declaring the id, or
      // only the pinned app — a pin never resolves to another app's action.
      const pool = enabledApps().filter((a) => !adapterId || a.id === adapterId);
      if (adapterId && pool.length === 0) {
        return errorResult(
          `Adapter "${adapterId}" is not enabled. Enable it in ~/.sluice/config.json or omit adapterId.`,
        );
      }
      const actions = pool.flatMap((app) => app.listReplayActions().map((action) => ({ app, action })));
      const match = actions.find((m) => m.action.id === actionId);
      if (!match) {
        return errorResult(`Unknown actionId "${actionId}". Available: ${actions.map((m) => m.action.id).join(', ')}`);
      }

      try {
        const out = await replayActionFor(store, match.app, match.action, params ?? {}, workspaceId);
        if (!out.ok) return errorResult(out.error);
        const { capture, counts, refreshed } = out;
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
      const flows = store.listFlows({ adapterId, source, q, limit: lim }).map((f) => flowSummary(f));
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
          const { apiStepCount, qualityNotes } = templateQuality(t);
          return { ...templateSummary(t), apiStepCount, qualityNotes };
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
          return jsonResult({ kind: 'flow', ...flowSummary(flow), steps: flow.steps.map(flowStepSummary) });
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
        params: replayParamsSchema.optional(),
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

      const choice = await acquireSession(app, { workspaceId });
      if (!choice.ok) return errorResult(choice.error);

      try {
        // Already redacted by runFlowReplay: error and step details can quote the request.
        const result = await replayTemplate(store, app, tmpl, params ?? {}, choice.session);
        return jsonResult({
          note: 'This tool made live network request(s) for each reproducible step.',
          ok: result.ok,
          error: result.error,
          refreshed: result.refreshed || undefined,
          flowId: result.flow?.id,
          templateId: tmpl.id,
          primaryKey: tmpl.primaryKey,
          steps: result.steps,
        });
      } catch (e) {
        return errorResult(`Flow replay failed: ${errText(e)}`);
      }
    },
  );

  server.registerTool(
    'auth_flow',
    {
      title: 'Map the auth flow',
      description:
        'Derive from captured traffic which endpoints issue credentials, which refresh them, and what later requests depend on them. Never returns a secret — names, endpoints, counts and redacted previews only.',
      inputSchema: { app: z.string().optional() },
    },
    async ({ app }) => jsonResult(mapAuthFlow(store.listCaptures({ limit: 5_000, adapterId: app }), app ?? null)),
  );

  // App-contributed MCP tools, only for apps this machine has ENABLED (others
  // only eat the client's tool budget). run may touch the network, so a thrown
  // error becomes a redacted tool error rather than crashing the handler.
  for (const app of enabledApps()) {
    const ctx = appToolContext(store, app);

    for (const t of app.mcpTools?.() ?? []) {
      server.registerTool(
        t.name,
        { title: t.name, description: t.description, inputSchema: (t.inputSchema ?? {}) as ZodRawShape },
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
  // Before the first tool call: a capture session that ended without
  // reconciling leaves data under a placeholder workspace no caller can name.
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
