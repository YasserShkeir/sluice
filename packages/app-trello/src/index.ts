// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-trello — the self-contained Trello app.
 *
 * The primary export is `trelloApp: App` — the Trello `Adapter` plus:
 *   - a `credentials` provider that mints an in-memory Session from the local
 *     Chrome session cookie (macOS, via core's Chrome cookie reader), and
 *   - one MCP tool (`trello_my_cards`) that lists the logged-in user's open cards.
 *
 * Trello's web API is authorized by the browser SESSION COOKIE (the `Cookie:`
 * header) — there is no token query param. Everything the credential provider
 * returns is SECRET (`credentials.values`) and must never be persisted or
 * streamed; only a RedactedSession may cross those boundaries.
 */
import { errorMessage, locateChromeProfile, readChromeCookieHeader } from '@sluice/core';
import type { App, AppMcpTool, AppToolContext, CredentialProvider } from '@sluice/core';
import { localSessionCredentials, replayAttempt, safeJson, withCookieRefresh } from '@sluice/adapter-sdk';
import { ADAPTER_ID, trelloAdapter, trelloHeaders } from './trello-adapter.js';

// ── Credential provider (macOS Chrome local store) ───────────────────────────────

/** The trello.com session cookie from Chrome, as a `Cookie:` header. SECRET. */
const readCookie = (): string =>
  readChromeCookieHeader({ domainSuffix: 'trello.com', serviceLabel: 'Trello' }).cookieHeader;

const trelloCredentials: CredentialProvider = localSessionCredentials({
  adapterId: ADAPTER_ID,
  label: 'Trello',
  kind: 'trello-session',
  workspace: { id: 'trello', name: 'Trello', domain: 'trello.com', url: 'https://trello.com/' },
  locate: () => locateChromeProfile('trello.com'), // passive probe; see LocalSessionSpec.locate
  read: () => ({ values: { cookieHeader: readCookie() }, injection: { headers: { Cookie: 'cookieHeader' } } }),
});

// ── MCP tool ───────────────────────────────────────────────────────────────────────

/** The subset of card fields the `trello_my_cards` tool returns. */
interface TrelloCardLite {
  id?: string;
  name?: string;
  idBoard?: string;
  idList?: string;
  url?: string;
  due?: string | null;
}

interface TrelloNamed {
  id?: string;
  name?: string;
}

/**
 * GET a Trello JSON endpoint with the browser session cookie, through
 * `replayAttempt`, re-reading the cookie once on an auth failure
 * (`withCookieRefresh`). Throws on !ok.
 */
async function trelloGet(
  url: string,
  cookieHeader: string,
  ctx?: AppToolContext,
): Promise<unknown> {
  const { attempt, refreshed } = await withCookieRefresh(
    cookieHeader,
    (cookie) => replayAttempt({ method: 'GET', url, headers: trelloHeaders(cookie) }, ctx),
    readCookie,
  );
  if (refreshed && attempt.authFailed) {
    throw new Error(
      `HTTP ${attempt.status ?? 'error'} — the Trello session is expired even after re-reading it; sign in again in Chrome`,
    );
  }
  if (attempt.authFailed || attempt.status === null || attempt.status >= 400) {
    throw new Error(`HTTP ${attempt.status ?? 'error'}`);
  }
  const data = safeJson(attempt.body ?? 'null');
  if (data === undefined) throw new Error('Trello returned a non-JSON body');
  return data;
}

/** id → name for every `{ id, name }` row at `url` (boards, or one board's lists). */
async function names(url: string, cookieHeader: string, ctx?: AppToolContext): Promise<Map<string, string>> {
  const data = await trelloGet(url, cookieHeader, ctx);
  const out = new Map<string, string>();
  for (const row of (Array.isArray(data) ? data : []) as TrelloNamed[]) {
    if (row.id && row.name) out.set(row.id, row.name);
  }
  return out;
}

async function fetchMyCards(ctx?: AppToolContext): Promise<unknown> {
  let cookieHeader: string;
  try {
    cookieHeader = readCookie();
  } catch (err) {
    return { error: errorMessage(err) };
  }

  const url =
    'https://trello.com/1/members/me/cards?fields=id,name,url,idBoard,idList,dateLastActivity,due,dueComplete,closed&filter=open';

  try {
    const data = await trelloGet(url, cookieHeader, ctx);
    const cards = (Array.isArray(data) ? data : []) as TrelloCardLite[];

    // Resolve ids → names. Trello has no nested-expansion param that works here,
    // so this is a small number of extra reads: one for boards, then one per
    // board that actually has a card. Name resolution is best-effort — a failure
    // degrades to the raw id rather than failing the whole tool.
    let boards = new Map<string, string>();
    const lists = new Map<string, string>();
    try {
      boards = await names('https://trello.com/1/members/me/boards?fields=id,name', cookieHeader, ctx);
      const boardIds = [...new Set(cards.map((c) => c.idBoard).filter((b): b is string => Boolean(b)))];
      const perBoard = await Promise.all(
        boardIds.map(async (id) => {
          try {
            return await names(
              `https://trello.com/1/boards/${encodeURIComponent(id)}/lists?fields=id,name`,
              cookieHeader,
              ctx,
            );
          } catch {
            return new Map<string, string>();
          }
        }),
      );
      for (const m of perBoard) for (const [k, v] of m) lists.set(k, v);
    } catch {
      /* names unavailable — fall back to ids below */
    }

    return {
      count: cards.length,
      cards: cards.map((c) => ({
        id: c.id,
        name: c.name,
        board: (c.idBoard && boards.get(c.idBoard)) || c.idBoard,
        boardId: c.idBoard,
        list: (c.idList && lists.get(c.idList)) || c.idList,
        url: c.url,
        due: c.due ?? null,
      })),
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

const trelloMcpTools: AppMcpTool[] = [
  {
    name: 'trello_my_cards',
    description:
      "Fetch the logged-in Trello user's open cards (name, board, url, due) using the local Chrome session cookie.",
    run: (_args, ctx) => fetchMyCards(ctx),
  },
];

// ── The app ──────────────────────────────────────────────────────────────────────

/** The one installed Trello app: adapter + credential provider + MCP tool. */
export const trelloApp: App = {
  ...trelloAdapter,
  credentials: trelloCredentials,
  mcpTools() {
    return trelloMcpTools;
  },
};

// ── Named re-exports (adapter alias + raw pieces for callers/tests) ─────────────
export {
  trelloAdapter,
  parseTrelloCapture,
  classifyTrelloCapture,
  trelloNextCursors,
  trelloHeaders,
} from './trello-adapter.js';
