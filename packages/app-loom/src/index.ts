// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-loom — the self-contained Loom app.
 *
 * The primary export is `loomApp: App` — the Loom `Adapter` plus:
 *   - a `credentials` provider that mints an in-memory Session from the local
 *     Chrome session cookie (macOS, via chrome-cookies.ts), and
 *   - four MCP tools:
 *       loom_list_videos          — the signed-in user's videos (cursor-paged)
 *       loom_get_video            — one video's details
 *       loom_list_notifications   — notifications + unseen count
 *       loom_get_transcript       — a video's transcript (the headline feature)
 *
 * Loom's web API is one GraphQL endpoint authorized by the browser SESSION COOKIE
 * (`Cookie:` header) — see loom-adapter.ts. Everything the credential provider
 * returns is SECRET (`credentials.values`) and must never be persisted or
 * streamed; only a RedactedSession may cross those boundaries.
 *
 * Network discipline (mirrors app-trello): every call prefers `ctx.replay`, so it
 * picks up the real client's learned fingerprint, passes the replay safety rails,
 * and lands in the capture store like any other Sluice request. Without a context
 * (direct library use) it falls back to `fetch`.
 *
 * The transcript is a TWO-hop fetch: `fetchVideoTranscript` returns a signed
 * `captions_source_url` (a WebVTT file on cdn.loom.com), which the tool then GETs
 * and `parseVtt` turns into timed segments + prose.
 */
import { isAuthFailure, newId } from '@sluice/core';
import type {
  App,
  AppMcpTool,
  AppToolContext,
  CredentialProvider,
  ReplayRequest,
  Session,
  WorkspaceInfo,
} from '@sluice/core';
import { arr, num, obj, str } from '@sluice/adapter-sdk';
import { z } from 'zod';
import {
  ADAPTER_ID,
  buildGraphqlRequest,
  CHROME_UA,
  getVideoOp,
  libraryOp,
  LOOM_SHARE_BASE,
  loomAdapter,
  notificationsOp,
  transcriptOp,
  unseenNotificationsOp,
  type GraphqlOp,
} from './loom-adapter.js';
import { locateLoomProfile, readLoomCookieHeader } from './chrome-cookies.js';
import { parseVtt } from './transcript.js';

// ── Credential provider (macOS Chrome local store) ───────────────────────────────

/**
 * Is this "no Loom session here" (fine, return nothing) or "we could not read it"
 * (a real failure the user needs to see)? A blanket catch made a locked cookie DB,
 * a denied Keychain prompt and a decrypt failure all indistinguishable from being
 * signed out — so the user was told to sign in when they already were.
 */
function isNoSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not signed in|no .*cookie|not found|does not exist|ENOENT/i.test(msg);
}

const loomCredentials: CredentialProvider = {
  /**
   * Passive readiness probe: does a Chrome profile hold loom.com cookies? It
   * counts rows without decrypting, so it never triggers a Keychain prompt.
   * `sluice doctor` needs this — an app with no probe cannot be verified.
   */
  listWorkspaces: async (): Promise<WorkspaceInfo[]> => {
    if (process.platform !== 'darwin') return [];
    try {
      const found = locateLoomProfile();
      if (!found) return [];
      return [{ id: 'loom', name: 'Loom', domain: 'loom.com', url: 'https://www.loom.com/' }];
    } catch {
      return [];
    }
  },

  extractSessions: async (): Promise<Session[]> => {
    if (process.platform !== 'darwin') return [];
    try {
      const { cookieHeader } = readLoomCookieHeader();
      const session: Session = {
        id: newId('sess'),
        adapterId: ADAPTER_ID,
        label: 'Loom',
        credentials: {
          kind: 'loom-session',
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
        `Loom credential extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

// ── GraphQL over the shared replay pipeline (or a bare fetch fallback) ────────────

const LOOM_TIMEOUT_MS = 30_000;

/** What one attempt produced: enough to decide whether to retry. */
interface LoomAttempt {
  status: number | null;
  body: string | null;
  authFailed: boolean;
}

/**
 * One request, no retry. Split out so the retry below is a plain sequential second
 * call — `ctx.replay` funnels into a single-slot mutex that self-deadlocks if it is
 * re-entered from inside itself.
 */
async function replayOrFetch(req: ReplayRequest, ctx?: AppToolContext): Promise<LoomAttempt> {
  if (ctx) {
    const capture = await ctx.replay(req);
    return { status: capture.status, body: capture.resBody, authFailed: isAuthFailure(capture) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOM_TIMEOUT_MS);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
    const body = await res.text();
    return { status: res.status, body, authFailed: isAuthFailure({ status: res.status, resBody: body }) };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a GraphQL attempt into its `data`, throwing on transport or GraphQL errors. */
function unwrapGraphql(attempt: LoomAttempt, operationName: string): Record<string, unknown> {
  if (attempt.authFailed) {
    throw new Error(`Loom session is expired — open https://www.loom.com in Chrome and sign in again (${operationName}).`);
  }
  if (attempt.status === null || attempt.status >= 400) {
    throw new Error(`Loom ${operationName}: HTTP ${attempt.status ?? 'error'}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(attempt.body ?? 'null');
  } catch {
    throw new Error(`Loom ${operationName}: response was not JSON.`);
  }
  const root = obj(json);
  if (!root) throw new Error(`Loom ${operationName}: unexpected response shape.`);
  const errors = arr(root.errors) ?? [];
  if (errors.length > 0 && root.data == null) {
    const message = str(obj(errors[0])?.message) ?? 'unknown error';
    throw new Error(`Loom ${operationName} failed: ${message}`);
  }
  return obj(root.data) ?? {};
}

/**
 * Issue a GraphQL op with the browser session cookie. On an auth failure it
 * re-reads the cookie ONCE and retries — the session may have rotated mid-workflow
 * and the fresh cookie is sitting in Chrome's store, readable in a millisecond.
 * Nothing is cached: re-reading IS the mechanism.
 */
async function loomGraphql(
  op: GraphqlOp,
  cookieHeader: string,
  ctx?: AppToolContext,
): Promise<Record<string, unknown>> {
  const first = await replayOrFetch(buildGraphqlRequest(op, cookieHeader), ctx);
  if (!first.authFailed) return unwrapGraphql(first, op.operationName);

  let fresh: string;
  try {
    ({ cookieHeader: fresh } = readLoomCookieHeader());
  } catch {
    return unwrapGraphql(first, op.operationName); // report the original auth failure
  }
  if (fresh === cookieHeader) return unwrapGraphql(first, op.operationName);

  const second = await replayOrFetch(buildGraphqlRequest(op, fresh), ctx);
  return unwrapGraphql(second, op.operationName);
}

/** GET a signed cdn.loom.com file (the transcript VTT). No cookie — the URL is signed. */
async function loomFetchText(url: string, ctx?: AppToolContext): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': CHROME_UA,
    Accept: 'text/vtt,text/plain,*/*',
    Referer: 'https://www.loom.com/',
  };
  const attempt = await replayOrFetch({ method: 'GET', url, headers }, ctx);
  if (attempt.status === null || attempt.status >= 400) {
    throw new Error(`Loom transcript file: HTTP ${attempt.status ?? 'error'}.`);
  }
  return attempt.body ?? '';
}

// ── Small helpers ────────────────────────────────────────────────────────────────

function readCookie(): string {
  return readLoomCookieHeader().cookieHeader; // throws with a clear, sign-in-in-Chrome message
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = num(v);
  if (n === undefined) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function requireVideoId(args: Record<string, unknown>): string {
  const id = str(args.videoId)?.trim();
  if (!id) throw new Error('loom tool: `videoId` is required (the 32-char id from a share URL).');
  return id;
}

const shareUrl = (id: string): string => LOOM_SHARE_BASE + id;

// ── Tool implementations ─────────────────────────────────────────────────────────

async function listVideos(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const limit = clampInt(args.limit, 12, 1, 50);
  const cursor = str(args.cursor) || null;
  const data = await loomGraphql(libraryOp(limit, cursor), readCookie(), ctx);

  const videosConn = obj(obj(data.getLooms)?.videos);
  const edges = videosConn ? (arr(videosConn.edges) ?? []) : [];
  const videos = edges
    .map((e) => {
      const node = obj(obj(e)?.node) ?? {};
      const id = str(node.id) ?? '';
      return {
        id,
        name: str(node.name),
        visibility: str(node.visibility),
        createdAt: str(node.createdAt),
        shareUrl: id ? shareUrl(id) : undefined,
      };
    })
    .filter((v) => v.id.length > 0);

  const pageInfo = videosConn ? obj(videosConn.pageInfo) : undefined;
  return {
    count: videos.length,
    videos,
    nextCursor: pageInfo ? (str(pageInfo.endCursor) ?? null) : null,
    hasNextPage: pageInfo ? pageInfo.hasNextPage === true : false,
  };
}

async function getVideo(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const videoId = requireVideoId(args);
  const data = await loomGraphql(getVideoOp(videoId), readCookie(), ctx);
  const v = obj(data.video);
  if (!v) throw new Error(`No Loom video "${videoId}" — not found, or not accessible with this session.`);

  const owner = obj(v.owner);
  const ownerName = owner ? [str(owner.first_name), str(owner.last_name)].filter(Boolean).join(' ') : '';
  const thumbnails = obj(v.thumbnails);
  return {
    id: str(v.id) ?? videoId,
    name: str(v.name),
    description: str(v.description) || undefined,
    createdAt: str(v.createdAt),
    privacy: str(v.privacy),
    visibility: str(v.visibility),
    complete: v.complete === true,
    archived: v.archived === true,
    views: num(obj(v.views)?.total),
    comments: num(v.totalComments),
    reactions: num(v.totalReactions),
    watchedByYou: v.currentUserHasWatched === true,
    owner: ownerName || undefined,
    thumbnailUrl: thumbnails ? str(thumbnails.default) : undefined,
    shareUrl: shareUrl(str(v.id) ?? videoId),
  };
}

async function listNotifications(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const first = clampInt(args.limit, 20, 1, 50);
  const cookie = readCookie();

  const data = await loomGraphql(notificationsOp(first, null), cookie, ctx);
  const conn = obj(obj(obj(data.currentUser)?.notification)?.notificationConnection);
  const edges = conn ? (arr(conn.edges) ?? []) : [];
  const notifications = edges
    .map((e) => {
      const node = obj(obj(e)?.node) ?? {};
      const enhanced = obj(obj(node.video)?.enhancedVideo);
      const vid = enhanced ? str(enhanced.id) : undefined;
      return {
        id: str(node.id),
        type: str(node.notificationType),
        status: str(node.status),
        content: str(node.content) || undefined,
        url: str(node.url) || undefined,
        createdAt: str(node.createdAt),
        videoId: vid,
        videoName: enhanced ? str(enhanced.name) : undefined,
        videoShareUrl: vid ? shareUrl(vid) : undefined,
      };
    })
    .filter((n) => Boolean(n.id));

  // The unseen count is a nice-to-have; a failure here must not sink the list.
  let unseenCount: number | undefined;
  try {
    const countData = await loomGraphql(unseenNotificationsOp(), cookie, ctx);
    const c = obj(obj(obj(countData.currentUser)?.notification)?.unseenNotificationsCount);
    unseenCount = c ? num(c.count) : undefined;
  } catch {
    unseenCount = undefined;
  }

  return { unseenCount, count: notifications.length, notifications };
}

async function getTranscript(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const videoId = requireVideoId(args);
  const language = str(args.language) || null;

  const data = await loomGraphql(transcriptOp(videoId, language), readCookie(), ctx);
  const t = obj(data.fetchVideoTranscript);
  if (!t) throw new Error(`Loom returned no transcript payload for "${videoId}".`);

  const typename = str(t.__typename);
  if (typename === 'InvalidRequestWarning' || typename === 'GenericError') {
    throw new Error(`Loom transcript unavailable for "${videoId}": ${str(t.message) ?? typename}.`);
  }

  const captionsUrl = str(t.captions_source_url);
  if (!captionsUrl) {
    const processing = t.captionsTranslationInProgress === true;
    throw new Error(
      `Loom has no transcript URL for "${videoId}"${processing ? ' — captions are still processing.' : ' — it may still be transcribing, or has no transcript.'}`,
    );
  }

  const vtt = await loomFetchText(captionsUrl, ctx);
  const transcript = parseVtt(vtt);
  if (transcript.segments.length === 0) {
    throw new Error(`Loom transcript for "${videoId}" was fetched but parsed to zero segments.`);
  }

  return {
    videoId,
    language: str(t.language) ?? str(t.captionsTranslatedLanguage) ?? undefined,
    shareUrl: shareUrl(videoId),
    segmentCount: transcript.segments.length,
    text: transcript.text,
    segments: transcript.segments,
  };
}

// ── MCP tools ──────────────────────────────────────────────────────────────────────

const loomMcpTools: AppMcpTool[] = [
  {
    name: 'loom_list_videos',
    description:
      "List the signed-in Loom user's own videos, newest first (id, name, visibility, createdAt, shareUrl). Cursor-paged: pass the returned nextCursor to page. Uses the local Chrome session cookie.",
    inputSchema: {
      limit: z.number().int().positive().max(50).optional(),
      cursor: z.string().optional(),
    },
    run: (args, ctx) => listVideos(args, ctx),
  },
  {
    name: 'loom_get_video',
    description:
      'Fetch one Loom video by its id (name, owner, privacy, view/comment/reaction counts, thumbnail, shareUrl). The id is the 32-char token in a share URL (loom.com/share/<id>).',
    inputSchema: { videoId: z.string() },
    run: (args, ctx) => getVideo(args, ctx),
  },
  {
    name: 'loom_list_notifications',
    description:
      "List the signed-in Loom user's notifications (type, status, content, linked video) and the unseen count. Uses the local Chrome session cookie.",
    inputSchema: { limit: z.number().int().positive().max(50).optional() },
    run: (args, ctx) => listNotifications(args, ctx),
  },
  {
    name: 'loom_get_transcript',
    description:
      "Fetch a Loom video's transcript as timed segments and joined prose. Give the 32-char video id (from loom.com/share/<id>); optional `language` requests translated captions. Resolves the signed captions URL via GraphQL, then downloads and parses the WebVTT. Uses the local Chrome session cookie.",
    inputSchema: {
      videoId: z.string(),
      language: z.string().optional(),
    },
    run: (args, ctx) => getTranscript(args, ctx),
  },
];

// ── The app ──────────────────────────────────────────────────────────────────────

/** The one installed Loom app: adapter + credential provider + MCP tools. */
export const loomApp: App = {
  ...loomAdapter,
  credentials: loomCredentials,
  mcpTools() {
    return loomMcpTools;
  },
};

// ── Named re-exports (adapter alias + raw pieces for callers/tests) ─────────────
export {
  loomAdapter,
  parseLoomCapture,
  classifyLoomCapture,
  graphqlOperationOf,
  matchesLoom,
  ADAPTER_ID,
} from './loom-adapter.js';
export { parseVtt } from './transcript.js';
export type { Transcript, TranscriptSegment } from './transcript.js';
export { readLoomCookieHeader } from './chrome-cookies.js';
export type { LoomCookieHeader } from './chrome-cookies.js';
