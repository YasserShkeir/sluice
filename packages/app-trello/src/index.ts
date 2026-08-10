// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-trello — the self-contained Trello app.
 *
 * The primary export is `trelloApp: App` — the Trello `Adapter` plus:
 *   - a `credentials` provider that mints an in-memory Session from the local
 *     Chrome session cookie (macOS, via chrome-cookies.ts), and
 *   - one MCP tool (`trello_my_cards`) that lists the logged-in user's open cards.
 *
 * Trello's web API is authorized by the browser SESSION COOKIE (the `Cookie:`
 * header) — there is no token query param. Everything the credential provider
 * returns is SECRET (`credentials.values`) and must never be persisted or
 * streamed; only a RedactedSession may cross those boundaries.
 */
import { isAuthFailure, newId } from '@sluice/core';
import type {
  App,
  AppMcpTool,
  AppToolContext,
  CredentialProvider,
  Session,
  WorkspaceInfo,
} from '@sluice/core';
import { ADAPTER_ID, CHROME_UA, trelloAdapter } from './trello-adapter.js';
import { locateTrelloProfile, readTrelloCookieHeader } from './chrome-cookies.js';

// ── Credential provider (macOS Chrome local store) ───────────────────────────────

/**
 * Is this "no Trello session here" (fine, return nothing) or "we could not read
 * it" (a real failure the user needs to see)? A blanket catch made a locked
 * cookie DB, a denied Keychain prompt and a decrypt failure all indistinguishable
 * from being signed out — so the user was told to sign in when they already were.
 */
function isNoSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not signed in|no .*cookie|not found|does not exist|ENOENT/i.test(msg);
}

const trelloCredentials: CredentialProvider = {
  /**
   * Passive readiness probe: does a Chrome profile hold trello.com cookies?
   * It counts rows without decrypting, so it never triggers a Keychain prompt.
   * `sluice doctor` needs this — an app with no probe cannot be verified, and a
   * broken Trello cookie would otherwise stay invisible until a tool failed.
   */
  listWorkspaces: async (): Promise<WorkspaceInfo[]> => {
    if (process.platform !== 'darwin') return [];
    try {
      const found = locateTrelloProfile();
      if (!found) return [];
      return [{ id: 'trello', name: 'Trello', domain: 'trello.com', url: 'https://trello.com/' }];
    } catch {
      return [];
    }
  },

  extractSessions: async (): Promise<Session[]> => {
    if (process.platform !== 'darwin') return [];
    try {
      const { cookieHeader } = readTrelloCookieHeader();
      const session: Session = {
        id: newId('sess'),
        adapterId: ADAPTER_ID,
        label: 'Trello',
        credentials: {
          kind: 'trello-session',
          values: { cookieHeader },
          injection: { headers: { Cookie: 'cookieHeader' } },
        },
        discoveredAt: Date.now(),
        source: 'local-store',
      };
      return [session];
    } catch (err) {
      // Genuinely absent → surface nothing. Anything else (locked Cookies DB,
      // Keychain denial, decrypt failure) is a real problem: report it rather
      // than letting it masquerade as "not signed in".
      if (isNoSessionError(err)) return [];
      throw new Error(
        `Trello credential extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

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

const TRELLO_TIMEOUT_MS = 20_000;

function trelloHeaders(cookieHeader: string): Record<string, string> {
  return {
    Cookie: cookieHeader,
    'User-Agent': CHROME_UA,
    Accept: 'application/json',
    Referer: 'https://trello.com/',
  };
}

/**
 * GET a Trello JSON endpoint with the browser session cookie. Throws on !ok.
 *
 * When the MCP server supplies a context, the call goes through the shared
 * replay pipeline: it picks up the real client's learned request fingerprint,
 * passes the replay safety rails, and lands in the capture store like any other
 * Sluice request. Without one (direct library use) it falls back to `fetch`.
 */
async function trelloGet(
  url: string,
  cookieHeader: string,
  ctx?: AppToolContext,
): Promise<unknown> {
  const first = await trelloGetOnce(url, cookieHeader, ctx);
  if (!first.authFailed) return unwrap(first);

  // The session expired mid-workflow. This used to end the call with "open
  // Trello in Chrome and sign in" — while the cookie that would have fixed it
  // sat in Chrome's cookie store the whole time, readable in a millisecond.
  //
  // Re-read it and try ONCE. Nothing is cached: re-reading IS the mechanism, and
  // it is why Sluice still has nowhere to put a secret. A second failure is a
  // real sign-in problem and says so.
  let fresh: string;
  try {
    ({ cookieHeader: fresh } = readTrelloCookieHeader());
  } catch {
    // Could not re-read — report the original auth failure, which is the more
    // useful of the two.
    return unwrap(first);
  }
  if (fresh === cookieHeader) {
    // Identical cookie: re-sending it would get the same answer and burn another
    // request. The session really is gone.
    return unwrap(first);
  }

  const second = await trelloGetOnce(url, fresh, ctx);
  if (second.authFailed) {
    throw new Error(
      `HTTP ${second.status ?? 'error'} — the Trello session is expired even after re-reading it; sign in again in Chrome`,
    );
  }
  return unwrap(second);
}

/** What one attempt produced: the body, or enough to decide whether to retry. */
interface TrelloAttempt {
  status: number | null;
  body: string | null;
  authFailed: boolean;
}

function unwrap(attempt: TrelloAttempt): unknown {
  if (attempt.authFailed || attempt.status === null || attempt.status >= 400) {
    throw new Error(`HTTP ${attempt.status ?? 'error'}`);
  }
  try {
    return JSON.parse(attempt.body ?? 'null') as unknown;
  } catch {
    throw new Error('Trello returned a non-JSON body');
  }
}

/**
 * One request, no retry. Split out so the retry above is a plain sequential
 * second call — `ctx.replay` funnels into `withReplaySlot`, which self-deadlocks
 * if it is re-entered from inside itself.
 */
async function trelloGetOnce(
  url: string,
  cookieHeader: string,
  ctx?: AppToolContext,
): Promise<TrelloAttempt> {
  if (ctx) {
    const capture = await ctx.replay({ method: 'GET', url, headers: trelloHeaders(cookieHeader) });
    return {
      status: capture.status,
      body: capture.resBody,
      authFailed: isAuthFailure(capture),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRELLO_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: trelloHeaders(cookieHeader), signal: controller.signal });
    const body = await res.text();
    return { status: res.status, body, authFailed: isAuthFailure({ status: res.status, resBody: body }) };
  } finally {
    clearTimeout(timer);
  }
}

/** id → name for every board the user can see. Used to resolve cards' idBoard. */
async function boardNames(cookieHeader: string, ctx?: AppToolContext): Promise<Map<string, string>> {
  const data = await trelloGet('https://trello.com/1/members/me/boards?fields=id,name', cookieHeader, ctx);
  const out = new Map<string, string>();
  for (const b of (Array.isArray(data) ? data : []) as TrelloNamed[]) {
    if (b.id && b.name) out.set(b.id, b.name);
  }
  return out;
}

/** id → name for the lists on one board (the card's column). */
async function listNames(
  boardId: string,
  cookieHeader: string,
  ctx?: AppToolContext,
): Promise<Map<string, string>> {
  const data = await trelloGet(
    `https://trello.com/1/boards/${encodeURIComponent(boardId)}/lists?fields=id,name`,
    cookieHeader,
    ctx,
  );
  const out = new Map<string, string>();
  for (const l of (Array.isArray(data) ? data : []) as TrelloNamed[]) {
    if (l.id && l.name) out.set(l.id, l.name);
  }
  return out;
}

async function fetchMyCards(ctx?: AppToolContext): Promise<unknown> {
  let cookieHeader: string;
  try {
    ({ cookieHeader } = readTrelloCookieHeader());
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  // `idList` is requested so the card's column can be named too — the previous
  // query omitted it entirely, so lists were not just unnamed but unavailable.
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
      boards = await boardNames(cookieHeader, ctx);
      const boardIds = [...new Set(cards.map((c) => c.idBoard).filter((b): b is string => Boolean(b)))];
      const perBoard = await Promise.all(
        boardIds.map(async (id) => {
          try {
            return await listNames(id, cookieHeader, ctx);
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
    return { error: err instanceof Error ? err.message : String(err) };
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
  CHROME_UA,
  ADAPTER_ID,
} from './trello-adapter.js';
export { readTrelloCookieHeader } from './chrome-cookies.js';
export type { TrelloCookieHeader } from './chrome-cookies.js';
