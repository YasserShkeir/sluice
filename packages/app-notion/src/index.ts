// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-notion — the self-contained Notion app.
 *
 * The primary export is `notionApp: App` — the Notion `Adapter` plus:
 *   - a `credentials` provider that mints an in-memory Session from the local
 *     Chrome session cookie (macOS, via chrome-cookies.ts),
 *   - `redaction` so Notion's `token_v2` value is masked wherever it appears,
 *     not only in the `Cookie:` header the generic policy already covers, and
 *   - two MCP tools: one that lists the signed-in workspaces and teamspaces,
 *     one that reads a page (or database row) by id or URL.
 *
 * Notion's web API is authorized by the browser SESSION COOKIE (`token_v2`).
 * Everything the credential provider returns is SECRET (`credentials.values`)
 * and must never be persisted or streamed; only a RedactedSession may cross
 * those boundaries.
 */
import { errorMessage, newId } from '@sluice/core';
import type { App, AppMcpTool, AppRedaction, AppToolContext, CredentialProvider } from '@sluice/core';
import { localSessionCredentials, obj, replayAttempt, safeJson, str } from '@sluice/adapter-sdk';
import { ADAPTER_ID, API_ORIGIN, notionAdapter, notionHeaders } from './notion-adapter.js';
import { locateNotionProfile, readNotionCookieHeader } from './chrome-cookies.js';
import { recordMaps, recordTitle, tableRecords } from './record-map.js';

// ── Redaction ──────────────────────────────────────────────────────────────────

/**
 * Notion's session token has a distinctive, stable shape —
 * `v02:user_token_or_cookies:<~400 chars>` — and it does not stay in the
 * `Cookie:` header the generic policy masks. It also appears URL-encoded in
 * auth-sync redirects and inside `auth_sync_message_*` cookie payloads, where
 * the generic `token=` field rule cannot see it because the field is called
 * something else.
 *
 * A VALUE pattern is the durable fix: it catches the token regardless of which
 * field name it is hiding under.
 */
const TOKEN_V2 = /v0\d(?:%3A|:)user_token_or_cookies(?:%3A|:)[A-Za-z0-9_%\-+/=.]{16,}/;

/** True when `text` is exactly one Notion-shaped `token_v2` value. */
const isTokenV2 = (text: string): boolean => TOKEN_V2.exec(text)?.[0] === text;

const notionRedaction: AppRedaction = {
  patterns: [new RegExp(TOKEN_V2.source, 'g')],
  // `headers` is deliberately empty: x-notion-active-user-header is a user UUID, not a
  // credential (token_v2 is, masked by the pattern above and the generic Cookie rule).
  // It is unmasked in every recordMap as created_by_id, and it records which account a capture was made as.
};

// ── Credential provider (macOS Chrome local store) ─────────────────────────────

/**
 * The passive probe (see `LocalSessionSpec.locate`) looks for a Notion SESSION
 * cookie — `token_v2`, not merely any notion.com row. The workspace NAMES live
 * behind the session, so it reports the account; `notion_workspaces` names them.
 */
const notionCredentials: CredentialProvider = {
  ...localSessionCredentials({
    adapterId: ADAPTER_ID,
    label: 'Notion',
    kind: 'notion-session',
    workspace: { id: 'notion', name: 'Notion', domain: 'notion.com', url: `${API_ORIGIN}/` },
    locate: () => locateNotionProfile(),
    read: () => {
      const { cookieHeader, activeUserId } = readNotionCookieHeader();
      return {
        values: { cookieHeader, ...(activeUserId ? { activeUserId } : {}) },
        injection: {
          headers: { Cookie: 'cookieHeader', 'x-notion-active-user-header': 'activeUserId' },
        },
      };
    },
  }),

  /**
   * Paste-in fallback for a machine this cannot read Chrome on (not macOS, or a
   * browser that is not Chrome). `token_v2` alone is enough to authenticate;
   * the active user id is optional and only matters with several logins.
   *
   * Notion's own names win; `token` / `cookie` are the runner's generic pair.
   * Either a bare `token_v2` value or a Cookie header carrying one is accepted,
   * and only a Notion-SHAPED token: a pasted Slack or Toters credential must
   * never become a cookie sent to notion.com.
   */
  sessionFromInput: (input) => {
    const raw = (input.token_v2 ?? input.tokenV2 ?? input.cookieHeader ?? input.token ?? input.cookie)?.trim();
    if (!raw) return undefined;
    const bare = isTokenV2(raw);
    const value = bare ? raw : /(?:^|;\s*)token_v2=([^;]+)/.exec(raw)?.[1]?.trim();
    if (!value || !isTokenV2(value)) return undefined;
    const cookieHeader = bare ? `token_v2=${raw}` : raw;
    return {
      id: newId('sess'),
      adapterId: ADAPTER_ID,
      label: 'Notion (pasted)',
      credentials: {
        kind: 'notion-session',
        values: {
          cookieHeader,
          ...(input.activeUserId ? { activeUserId: input.activeUserId } : {}),
        },
        injection: {
          headers: { Cookie: 'cookieHeader', 'x-notion-active-user-header': 'activeUserId' },
        },
      },
      discoveredAt: Date.now(),
      source: 'manual',
    };
  },
};

// ── MCP tools ──────────────────────────────────────────────────────────────────

/**
 * POST a Notion API endpoint with the browser session cookie, through
 * `replayAttempt`.
 *
 * Notion answers some failures with HTTP 200 and `isNotionError: true`, so the
 * status is not on its own enough to tell success from failure.
 */
async function notionPost(
  operation: string,
  body: unknown,
  creds: { cookieHeader: string; activeUserId?: string },
  ctx?: AppToolContext,
): Promise<Record<string, unknown>> {
  const url = `${API_ORIGIN}/api/v3/${operation}`;
  const headers = notionHeaders(creds.cookieHeader, creds.activeUserId);
  const payload = JSON.stringify(body);

  const attempt = await replayAttempt({ method: 'POST', url, headers, body: payload }, ctx);
  if (attempt.authFailed) throw new Error('The Notion session is expired — sign in again in Chrome.');
  if (attempt.status === null || attempt.status >= 400) throw new Error(`HTTP ${attempt.status ?? 'error'} from ${operation}`);
  const parsed = safeJson(attempt.body ?? 'null');
  if (parsed === undefined) throw new Error(`Notion returned a non-JSON body from ${operation}`);
  const o = obj(parsed);
  if (!o) throw new Error(`Notion returned an unexpected body from ${operation}`);
  if (o.isNotionError === true) {
    throw new Error(`Notion rejected ${operation}: ${str(o.message) ?? str(o.name) ?? 'unknown error'}`);
  }
  return o;
}

async function withCredentials<T>(
  run: (creds: { cookieHeader: string; activeUserId?: string }) => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await run(readNotionCookieHeader());
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * A Notion page id out of whatever the caller had to hand.
 *
 * Notion URLs end in a 32-character hex id with no dashes, usually glued to a
 * slugified title (`…/Launch-checklist-0000000000004000800000000000a001`),
 * and the API only accepts the dashed uuid form. Accepting the URL is not a
 * convenience: pasting one is how anybody actually refers to a Notion page.
 */
export function toPageId(input: string): string | undefined {
  const trimmed = input.trim();
  const dashed = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(trimmed);
  if (dashed) return dashed[0].toLowerCase();
  // Match the 32-hex run in place, bounded both sides: stripping dashes from the whole
  // string first splices the slug's tail into the id.
  const bare = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i.exec(trimmed);
  if (!bare) return undefined;
  const h = bare[0].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function listWorkspacesTool(ctx?: AppToolContext): Promise<unknown> {
  return withCredentials(async (creds) => {
    const body = await notionPost('loadUserContent', {}, creds, ctx);
    const spaces: Array<Record<string, unknown>> = [];
    const teams: Array<Record<string, unknown>> = [];
    for (const map of recordMaps(body)) {
      for (const { id, record } of tableRecords(map, 'space')) {
        spaces.push({
          id,
          name: recordTitle(record),
          rootPages: Array.isArray(record.pages) ? record.pages.length : 0,
        });
      }
      for (const { id, record } of tableRecords(map, 'team')) {
        teams.push({ id, spaceId: record.space_id, name: recordTitle(record) });
      }
    }
    return { spaces, teamspaces: teams };
  });
}

async function readPageTool(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const raw = str(args.page) ?? str(args.pageId) ?? str(args.url) ?? '';
  const pageId = toPageId(raw);
  if (!pageId) {
    return { error: 'Pass a Notion page id or URL — 32 hex characters, dashed or not.' };
  }
  return withCredentials(async (creds) => {
    const body = await notionPost(
      'loadPageChunk',
      { pageId, limit: 200, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false },
      creds,
      ctx,
    );
    const blocks: Array<Record<string, unknown>> = [];
    const comments: Array<Record<string, unknown>> = [];
    let title = '';
    for (const map of recordMaps(body)) {
      for (const { id, record } of tableRecords(map, 'block')) {
        const text = recordTitle(record);
        if (id === pageId) title = text;
        if (text) blocks.push({ id, type: record.type, text });
      }
      for (const { id, record } of tableRecords(map, 'comment')) {
        comments.push({ id, authorId: record.created_by_id, ts: record.created_time });
      }
    }
    if (blocks.length === 0) {
      // A page the account cannot see answers 200 with an empty recordMap rather
      // than 403, so "no blocks" has to be reported as a distinct outcome — it
      // otherwise reads as an empty page.
      return { pageId, title: '', blocks: [], note: 'No blocks returned — the page is empty, deleted, or not shared with this account.' };
    }
    return { pageId, title, blockCount: blocks.length, blocks, commentCount: comments.length };
  });
}

const notionMcpTools: AppMcpTool[] = [
  {
    name: 'notion_workspaces',
    description:
      "List the signed-in Notion account's workspaces and teamspaces, using the local Chrome session cookie.",
    run: (_args, ctx) => listWorkspacesTool(ctx),
  },
  {
    name: 'notion_read_page',
    description:
      'Read one Notion page (or database row) by id or URL — its title, its blocks as plain text, and how many comments it carries.',
    run: (args, ctx) => readPageTool(obj(args) ?? {}, ctx),
  },
];

// ── The app ────────────────────────────────────────────────────────────────────

/** The one installed Notion app: adapter + credential provider + MCP tools. */
export const notionApp: App = {
  ...notionAdapter,
  credentials: notionCredentials,
  redaction: notionRedaction,
  mcpTools() {
    return notionMcpTools;
  },
};

// ── Named re-exports (adapter alias + raw pieces for callers/tests) ────────────
export {
  notionAdapter,
  parseNotionCapture,
  classifyNotionCapture,
  notionNextCursors,
  notionHeaders,
  reconcileNotion,
} from './notion-adapter.js';
export { readNotionCookieHeader } from './chrome-cookies.js';
export { plainText, recordValue } from './record-map.js';
