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
import { isAuthFailure, newId } from '@sluice/core';
import type {
  App,
  AppMcpTool,
  AppRedaction,
  AppToolContext,
  CredentialProvider,
  Session,
  WorkspaceInfo,
} from '@sluice/core';
import { obj, str } from '@sluice/adapter-sdk';
import { ADAPTER_ID, API_ORIGIN, CHROME_UA, notionAdapter } from './notion-adapter.js';
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
const notionRedaction: AppRedaction = {
  patterns: [/v0\d(?:%3A|:)user_token_or_cookies(?:%3A|:)[A-Za-z0-9_%\-+/=.]{16,}/g],
  // `headers` is deliberately empty. `x-notion-active-user-header` was masked
  // here at first, on the reasoning that anything account-shaped should be —
  // and that was wrong twice over. It carries a user UUID, not a credential
  // (the credential is `token_v2`, caught by the pattern above and by the
  // generic Cookie rule), and the same UUID appears unmasked all over every
  // recordMap as `created_by_id`. So masking it protected nothing and destroyed
  // the one field that records WHICH signed-in account a capture was made as —
  // which is exactly what a downstream consumer needs to attribute the read to
  // a principal. Without it, a downstream loader could not name who authorized a pull.
};

// ── Credential provider (macOS Chrome local store) ─────────────────────────────

/**
 * Is this "no Notion session here" (fine, return nothing) or "we could not read
 * it" (a real failure the user needs to see)? A blanket catch makes a locked
 * cookie DB, a denied Keychain prompt and a decrypt failure all indistinguishable
 * from being signed out — so the user is told to sign in when they already are.
 */
function isNoSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no chrome profile|not signed in|no .*cookie|not found|does not exist|ENOENT/i.test(msg);
}

const notionCredentials: CredentialProvider = {
  /**
   * Passive readiness probe: does a Chrome profile hold a Notion SESSION cookie?
   * It counts rows without decrypting, so it never triggers a Keychain prompt.
   * `sluice doctor` needs this — an app with no probe cannot be verified, and a
   * broken Notion cookie would otherwise stay invisible until a tool failed.
   */
  listWorkspaces: async (): Promise<WorkspaceInfo[]> => {
    if (process.platform !== 'darwin') return [];
    try {
      const found = locateNotionProfile();
      if (!found) return [];
      // The workspace NAMES live behind the session, and reading them would mean
      // decrypting — which this probe must not do. So it reports the account,
      // not the spaces, and `notion_workspaces` is the tool that names them.
      return [{ id: 'notion', name: 'Notion', domain: 'notion.com', url: `${API_ORIGIN}/` }];
    } catch {
      return [];
    }
  },

  extractSessions: async (): Promise<Session[]> => {
    if (process.platform !== 'darwin') return [];
    try {
      const { cookieHeader, activeUserId } = readNotionCookieHeader();
      const session: Session = {
        id: newId('sess'),
        adapterId: ADAPTER_ID,
        label: 'Notion',
        credentials: {
          kind: 'notion-session',
          values: { cookieHeader, ...(activeUserId ? { activeUserId } : {}) },
          injection: {
            headers: {
              Cookie: 'cookieHeader',
              'x-notion-active-user-header': 'activeUserId',
            },
          },
        },
        discoveredAt: Date.now(),
        source: 'local-store',
      };
      return [session];
    } catch (err) {
      if (isNoSessionError(err)) return [];
      throw new Error(
        `Notion credential extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },

  /**
   * Paste-in fallback for a machine this cannot read Chrome on (not macOS, or a
   * browser that is not Chrome). `token_v2` alone is enough to authenticate;
   * the active user id is optional and only matters with several logins.
   */
  sessionFromInput: (input) => {
    const token = input.token_v2 ?? input.tokenV2 ?? input.cookieHeader;
    if (!token) return undefined;
    const cookieHeader = token.includes('=') ? token : `token_v2=${token}`;
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

const NOTION_TIMEOUT_MS = 30_000;

function notionHeaders(cookieHeader: string, activeUserId?: string): Record<string, string> {
  return {
    Cookie: cookieHeader,
    'User-Agent': CHROME_UA,
    Accept: '*/*',
    'Content-Type': 'application/json',
    Origin: API_ORIGIN,
    Referer: `${API_ORIGIN}/`,
    'notion-audit-log-platform': 'web',
    ...(activeUserId ? { 'x-notion-active-user-header': activeUserId } : {}),
  };
}

/**
 * POST a Notion API endpoint with the browser session cookie.
 *
 * When the MCP server supplies a context the call goes through the shared replay
 * pipeline: it picks up the real client's learned request fingerprint, passes
 * the replay safety rails, and lands in the capture store like any other Sluice
 * request. Without one (direct library use) it falls back to `fetch`.
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

  let status: number | null;
  let text: string | null;
  if (ctx) {
    const capture = await ctx.replay({ method: 'POST', url, headers, body: payload });
    status = capture.status;
    text = capture.resBody;
    if (isAuthFailure(capture)) {
      throw new Error('The Notion session is expired — sign in again in Chrome.');
    }
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTION_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal });
      status = res.status;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  if (status === null || status >= 400) throw new Error(`HTTP ${status ?? 'error'} from ${operation}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? 'null');
  } catch {
    throw new Error(`Notion returned a non-JSON body from ${operation}`);
  }
  const o = obj(parsed);
  if (!o) throw new Error(`Notion returned an unexpected body from ${operation}`);
  if (o.isNotionError === true) {
    throw new Error(`Notion rejected ${operation}: ${str(o.message) ?? str(o.name) ?? 'unknown error'}`);
  }
  return o;
}

function withCredentials<T>(run: (creds: { cookieHeader: string; activeUserId?: string }) => Promise<T>) {
  return async (): Promise<T | { error: string }> => {
    try {
      const { cookieHeader, activeUserId } = readNotionCookieHeader();
      return await run({ cookieHeader, activeUserId });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * A Notion page id out of whatever the caller had to hand.
 *
 * Notion URLs end in a 32-character hex id with no dashes, usually glued to a
 * slugified title (`…/Launch-checklist-7bf74c6fdcff4013a680bf4fd4e5a048`),
 * and the API only accepts the dashed uuid form. Accepting the URL is not a
 * convenience: pasting one is how anybody actually refers to a Notion page.
 */
export function toPageId(input: string): string | undefined {
  const trimmed = input.trim();
  const dashed = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(trimmed);
  if (dashed) return dashed[0].toLowerCase();
  // Match the 32-hex run IN PLACE, bounded on both sides. Stripping dashes from
  // the whole string first — the obvious implementation — splices the slug into
  // the id: `…some-title-7bf74c6f…` became `e7bf74c6-fdcf-…`, a valid-looking
  // uuid for a page that does not exist.
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
  })();
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
  })();
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
  reconcileNotion,
  ADAPTER_ID,
  API_ORIGIN,
  CHROME_UA,
} from './notion-adapter.js';
export { readNotionCookieHeader, locateNotionProfile } from './chrome-cookies.js';
export type { NotionCookieHeader } from './chrome-cookies.js';
export { recordMaps, recordValue, recordTitle, recordTs, plainText, tableRecords } from './record-map.js';
