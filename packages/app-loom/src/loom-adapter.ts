// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Loom Adapter.
 *
 * Auth contract: Loom's web API is a single GraphQL endpoint
 * (`POST https://www.loom.com/graphql`) authorized by the BROWSER SESSION COOKIE
 * — the `Cookie:` request header. There is no token query param. Every operation
 * shares that one path and is distinguished by the `operationName` in the JSON
 * body, so `classify` reads the body (not the path) to name the operation, and
 * `buildReplayRequest` emits a POST whose body carries the chosen query.
 *
 * Two facts about Loom shape everything below:
 *
 *   1. `matchRequest` is HOST-only, so the entire SPA — the HTML shell,
 *      cdn.loom.com bundles, images, thumbnails — is attributed to `loom` and
 *      pushed through parse(). Labelling those `asset` in `classify` is the
 *      non-breaking fix; parse() returns {} for them.
 *
 *   2. Loom paginates its libraries with an opaque Relay cursor
 *      (`edges[].cursor` + `pageInfo.endCursor`), so the video list is
 *      genuinely cursor-paged (unlike Trello).
 *
 * Parsing is deliberately defensive — Loom payloads vary by operation and fields
 * routinely go missing — so unknown shapes yield an empty ParseResult rather than
 * throwing. `classify` runs in the same ingest funnel for every capture and is
 * held to the same rule: it must never throw.
 */
import type {
  Adapter,
  Capture,
  CaptureClass,
  CursorSeed,
  ParseContext,
  Container,
  Item,
  ParseResult,
  ReplayAction,
  ReplayRequest,
  Session,
  Workspace,
} from '@sluice/core';
import { arr, obj, safeJsonObject, str } from '@sluice/adapter-sdk';

export const ADAPTER_ID = 'loom';
const WORKSPACE_ID = 'loom';
const WORKSPACE_NAME = 'Loom';
/** The one container every parsed video lands in. */
const VIDEOS_CONTAINER_ID = 'loom:videos';

export const LOOM_GRAPHQL_URL = 'https://www.loom.com/graphql';
export const LOOM_SHARE_BASE = 'https://www.loom.com/share/';

/** A real Chrome macOS User-Agent — Loom's web API expects a browser agent. */
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// ── Matching ─────────────────────────────────────────────────────────────────────

export function matchesLoom(host: string): boolean {
  return host === 'loom.com' || host.endsWith('.loom.com');
}

// ── GraphQL operations (verbatim where captured, compact subsets where we own them) ─

/** One captured/authored GraphQL operation: its name, query text, and variables. */
export interface GraphqlOp {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
}

/**
 * The user's own video library, newest first (Relay-cursor paged). Node selection
 * is the exact one the web client uses — id / name / visibility.
 */
export function libraryOp(limit: number, cursor: string | null): GraphqlOp {
  return {
    operationName: 'GetLoomsForLibrary',
    query: `query GetLoomsForLibrary($limit: Int!, $cursor: String, $source: LoomsSource!, $sortType: LoomsSortType!, $sortOrder: LoomsSortOrder!, $filters: [[LoomsCollectionFilter!]!]) {
  getLooms {
    __typename
    ... on GetLoomsPayload {
      videos(first: $limit, after: $cursor, source: $source, sortType: $sortType, sortOrder: $sortOrder, filters: $filters) {
        edges { cursor node { id name visibility createdAt __typename } __typename }
        pageInfo { endCursor hasNextPage __typename }
        __typename
      }
      __typename
    }
  }
}`,
    variables: {
      limit,
      cursor,
      source: 'MINE',
      sortType: 'RECENT',
      sortOrder: 'DESC',
      filters: [[{ type: 'CREATED_BY_ME' }]],
    },
  };
}

/** One video's card details — a compact, proven subset of `getVideo`. */
export function getVideoOp(videoId: string): GraphqlOp {
  return {
    operationName: 'GetVideoCardDetails',
    query: `query GetVideoCardDetails($videoId: ID!) {
  video: getVideo(id: $videoId) {
    ... on RegularUserVideo {
      __typename
      id
      name
      description
      createdAt
      complete
      archived
      privacy
      visibility
      totalComments
      totalReactions
      currentUserHasWatched
      views { total __typename }
      owner { id first_name last_name __typename }
      thumbnails { default __typename }
    }
    __typename
  }
}`,
    variables: { videoId },
  };
}

/** The current user's notifications (compact subset of GetCurrentUserNotifications). */
export function notificationsOp(first: number, cursor: string | null): GraphqlOp {
  return {
    operationName: 'GetCurrentUserNotifications',
    query: `query GetCurrentUserNotifications($first: Int, $cursor: String, $notificationType: NotificationQueryType) {
  currentUser {
    ... on CurrentUserGlobal {
      notification {
        hasNotifications
        notificationConnection(notificationType: $notificationType, first: $first, after: $cursor) {
          edges {
            cursor
            node {
              id
              url
              content(withMentionMarkups: true)
              timestamp
              notificationType
              status
              createdAt
              video {
                enhancedVideo { ... on RegularUserVideo { id name __typename } __typename }
                __typename
              }
              __typename
            }
            __typename
          }
          pageInfo { endCursor hasNextPage __typename }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`,
    variables: { first, cursor, notificationType: 'all' },
  };
}

/** The count of unseen notifications. */
export function unseenNotificationsOp(): GraphqlOp {
  return {
    operationName: 'GetCurrentUserUnseenNotificationsCount',
    query: `query GetCurrentUserUnseenNotificationsCount {
  currentUser {
    ... on CurrentUserGlobal {
      notification { unseenNotificationsCount { count __typename } __typename }
      __typename
    }
    __typename
  }
}`,
    variables: {},
  };
}

/**
 * A video's transcript. Field selection matches the real web client, which
 * resolves to a signed `captions_source_url` (a WebVTT file on cdn.loom.com) —
 * the second hop the MCP tool fetches. `password` is null for videos the signed-in
 * user owns or can access.
 */
export function transcriptOp(videoId: string, language: string | null): GraphqlOp {
  return {
    operationName: 'FetchVideoTranscript',
    query: `query FetchVideoTranscript($videoId: ID!, $password: String, $captionsLanguageSelection: String) {
  fetchVideoTranscript(videoId: $videoId, password: $password, captionsLanguageSelection: $captionsLanguageSelection) {
    ... on VideoTranscriptDetails {
      language
      captions_url
      captions_source_url
      captionsInOriginalLanguage
      captionsTranslatedLanguage
      captionsTranslationInProgress
      __typename
    }
    ... on InvalidRequestWarning { message __typename }
    ... on GenericError { message __typename }
    __typename
  }
}`,
    variables: { videoId, password: null, captionsLanguageSelection: language },
  };
}

// ── Request building ───────────────────────────────────────────────────────────────

/** Browser-like headers Loom's GraphQL endpoint expects, plus the auth cookie. */
export function loomHeaders(cookieHeader: string | undefined, operationName: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': CHROME_UA,
    Origin: 'https://www.loom.com',
    Referer: 'https://www.loom.com/looms/videos',
    'apollographql-client-name': 'web',
    'x-loom-request-source': 'loom_web',
    'graphql-operation-name': operationName,
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

/** Turn a GraphQL op + cookie into a concrete POST /graphql request. */
export function buildGraphqlRequest(op: GraphqlOp, cookieHeader: string | undefined): ReplayRequest {
  return {
    method: 'POST',
    url: LOOM_GRAPHQL_URL,
    headers: loomHeaders(cookieHeader, op.operationName),
    body: JSON.stringify({ operationName: op.operationName, variables: op.variables, query: op.query }),
  };
}

/** The GraphQL `operationName` a capture's request body declares, if any. */
export function graphqlOperationOf(capture: Pick<Capture, 'path' | 'reqBody'>): string | undefined {
  if (!capture.path.startsWith('/graphql')) return undefined;
  const body = obj(safeJsonObject(capture.reqBody ?? ''));
  const op = body ? str(body.operationName) : undefined;
  return op || undefined;
}

// ── Classification ─────────────────────────────────────────────────────────────────

/** Operation-name → capture class. Video/notification content is `messages`; user/workspace shape is `structure`. */
const STRUCTURE_OP = /workspace|membership|organization|user|setting|billing|space|folder|feature|permission/i;
const MESSAGE_OP = /video|loom|notification|transcript|comment|reaction|chapter|feed|stream|meeting|insight/i;

export function classifyLoomCapture(capture: Capture): { class: CaptureClass; operation?: string } {
  // The SPA shell and its CDN assets are attributed to loom by host-only match.
  if (capture.host !== 'www.loom.com' || !capture.path.startsWith('/graphql')) {
    return { class: 'asset' };
  }
  const op = graphqlOperationOf(capture);
  if (capture.status !== null && capture.status >= 400) return { class: 'error', operation: op };
  if (!op) return { class: 'unknown' };
  // A 200 whose GraphQL body is all errors is still a failure.
  const body = obj(safeJsonObject(capture.resBody ?? ''));
  if (body && Array.isArray(body.errors) && body.errors.length > 0 && body.data == null) {
    return { class: 'error', operation: op };
  }
  if (MESSAGE_OP.test(op)) return { class: 'messages', operation: op };
  if (STRUCTURE_OP.test(op)) return { class: 'structure', operation: op };
  return { class: 'unknown', operation: op };
}

// ── Parsing ────────────────────────────────────────────────────────────────────────

function loomDate(v: unknown): number {
  const s = str(v);
  if (!s) return 0;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

/** Build the single Workspace + Videos container every parsed video hangs off. */
function baseEntities(): { workspace: Workspace; container: Container } {
  return {
    workspace: { id: WORKSPACE_ID, adapterId: ADAPTER_ID, name: WORKSPACE_NAME, domain: 'loom.com' },
    container: {
      id: VIDEOS_CONTAINER_ID,
      workspaceId: WORKSPACE_ID,
      adapterId: ADAPTER_ID,
      kind: 'other',
      name: 'Videos',
    },
  };
}

/** One RegularUserVideo node → an Item (kind 'other'), or undefined if it has no id. */
function videoToItem(node: Record<string, unknown>, captureId: string): Item | undefined {
  const id = str(node.id);
  if (!id) return undefined;
  const name = str(node.name) ?? '(untitled Loom)';
  return {
    id,
    containerId: VIDEOS_CONTAINER_ID,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'other',
    ts: loomDate(node.createdAt),
    text: name,
    sourceCaptureIds: [captureId],
    raw: node,
  };
}

/**
 * Collect video nodes from any of Loom's shapes:
 *   - getLooms.videos.edges[].node   (GetLoomsForLibrary)
 *   - recentUserVideos[]             (GetMostRecentVideoV2)
 *   - video / getVideo               (GetVideoCardDetails)
 */
function collectVideoNodes(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [];

  const getLooms = obj(data.getLooms);
  const videos = getLooms ? obj(getLooms.videos) : undefined;
  if (videos) {
    for (const edge of arr(videos.edges) ?? []) {
      const node = obj(obj(edge)?.node);
      if (node) nodes.push(node);
    }
  }

  for (const v of arr(data.recentUserVideos) ?? []) {
    const node = obj(v);
    if (node) nodes.push(node);
  }

  const single = obj(data.video) ?? obj(data.getVideo);
  if (single) nodes.push(single);

  return nodes;
}

export function parseLoomCapture(capture: Capture): ParseResult {
  if (capture.host !== 'www.loom.com' || !capture.path.startsWith('/graphql')) return {};
  if (!capture.resBody) return {};
  const root = obj(safeJsonObject(capture.resBody));
  const data = root ? obj(root.data) : undefined;
  if (!data) return {};

  const nodes = collectVideoNodes(data);
  const items: Item[] = [];
  for (const node of nodes) {
    const item = videoToItem(node, capture.id);
    if (item) items.push(item);
  }
  if (items.length === 0) return {};

  const { workspace, container } = baseEntities();
  return { workspaces: [workspace], containers: [container], items };
}

// ── Replay ───────────────────────────────────────────────────────────────────────────

/**
 * The parameterizable calls the webapp + `sluice_replay` can re-issue.
 *
 * APPEND-ONLY: reordering is free, but renaming an id silently produces work
 * nothing can run. Each id maps to a `GraphqlOp` builder in `opForAction` below.
 */
const LOOM_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'loom.videos.library',
    adapterId: ADAPTER_ID,
    label: 'My videos',
    method: 'POST',
    urlTemplate: LOOM_GRAPHQL_URL,
    params: [
      { name: 'limit', label: 'Limit', kind: 'number', default: '12' },
      { name: 'cursor', label: 'Cursor', kind: 'cursor' },
    ],
  },
  {
    id: 'loom.notifications.list',
    adapterId: ADAPTER_ID,
    label: 'My notifications',
    method: 'POST',
    urlTemplate: LOOM_GRAPHQL_URL,
    params: [
      { name: 'first', label: 'Count', kind: 'number', default: '20' },
      { name: 'cursor', label: 'Cursor', kind: 'cursor' },
    ],
  },
  {
    id: 'loom.video.get',
    adapterId: ADAPTER_ID,
    label: 'Video details',
    method: 'POST',
    urlTemplate: LOOM_GRAPHQL_URL,
    params: [{ name: 'videoId', label: 'Video id', kind: 'string', required: true }],
  },
  {
    id: 'loom.video.transcript',
    adapterId: ADAPTER_ID,
    label: 'Video transcript',
    method: 'POST',
    urlTemplate: LOOM_GRAPHQL_URL,
    params: [
      { name: 'videoId', label: 'Video id', kind: 'string', required: true },
      { name: 'language', label: 'Captions language', kind: 'string' },
    ],
  },
];

function requireParam(action: ReplayAction, params: Record<string, string>, name: string): string {
  const v = params[name] ?? action.params.find((p) => p.name === name)?.default;
  if (v === undefined || v === '') {
    throw new Error(`Loom replay action "${action.id}" needs a value for "${name}".`);
  }
  return v;
}

/** Map a replay action + params → the GraphQL op it issues. */
export function opForAction(action: ReplayAction, params: Record<string, string>): GraphqlOp {
  switch (action.id) {
    case 'loom.videos.library': {
      const limit = Number(params.limit ?? '12');
      return libraryOp(Number.isFinite(limit) && limit > 0 ? limit : 12, params.cursor || null);
    }
    case 'loom.notifications.list': {
      const first = Number(params.first ?? '20');
      return notificationsOp(Number.isFinite(first) && first > 0 ? first : 20, params.cursor || null);
    }
    case 'loom.video.get':
      return getVideoOp(requireParam(action, params, 'videoId'));
    case 'loom.video.transcript':
      return transcriptOp(requireParam(action, params, 'videoId'), params.language || null);
    default:
      throw new Error(`Unknown Loom replay action "${action.id}".`);
  }
}

function buildReplayRequest(
  action: ReplayAction,
  params: Record<string, string>,
  session: Session,
): ReplayRequest {
  return buildGraphqlRequest(opForAction(action, params), session.credentials.values.cookieHeader);
}

// ── The adapter ────────────────────────────────────────────────────────────────────


/**
 * Relay library / notifications pages → one more seed when hasNextPage.
 * Depth-bounded by the runner; we only emit the opaque endCursor.
 */
export function loomNextCursors(capture: Capture, _ctx?: ParseContext): CursorSeed[] {
  if (capture.host !== 'www.loom.com' || !capture.path.startsWith('/graphql')) return [];
  if (typeof capture.status === 'number' && capture.status >= 400) return [];
  if (!capture.resBody || !capture.reqBody) return [];
  const root = obj(safeJsonObject(capture.resBody));
  const data = root ? obj(root.data) : undefined;
  if (!data) return [];

  // Detect which op from the request body operationName / query prefix.
  const req = obj(safeJsonObject(capture.reqBody));
  const q = str(req?.query) ?? '';
  const opName = str(req?.operationName) ?? '';
  const isLibrary = opName.includes('LoomsForLibrary') || q.includes('GetLoomsForLibrary');
  const isNotif = opName.includes('Notifications') || q.includes('GetCurrentUserNotifications');
  if (!isLibrary && !isNotif) return [];

  // Walk for first pageInfo with hasNextPage
  function findPageInfo(node: unknown): { endCursor: string; hasNextPage: boolean } | undefined {
    const o = obj(node);
    if (!o) return undefined;
    const pi = obj(o.pageInfo);
    if (pi && pi.hasNextPage === true) {
      const end = str(pi.endCursor);
      if (end) return { endCursor: end, hasNextPage: true };
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') {
        const hit = findPageInfo(v);
        if (hit) return hit;
      }
    }
    return undefined;
  }
  const page = findPageInfo(data);
  if (!page) return [];

  if (isLibrary) {
    const vars = obj(req?.variables);
    const limit = str(vars?.limit) ?? '12';
    return [
      {
        adapterId: ADAPTER_ID,
        actionId: 'loom.videos.library',
        cursor: page.endCursor,
        params: { limit, cursor: page.endCursor },
        reason: 'cursor',
      },
    ];
  }
  const vars = obj(req?.variables);
  const first = str(vars?.first) ?? '20';
  return [
    {
      adapterId: ADAPTER_ID,
      actionId: 'loom.notifications.list',
      cursor: page.endCursor,
      params: { first, cursor: page.endCursor },
      reason: 'cursor',
    },
  ];
}

export const loomAdapter: Adapter = {
  id: ADAPTER_ID,
  displayName: 'Loom',
  hosts: ['loom.com'],
  matchRequest(input) {
    return matchesLoom(input.host);
  },
  parse(capture) {
    return parseLoomCapture(capture);
  },
  nextCursors(capture, ctx) {
    return loomNextCursors(capture, ctx);
  },
  classify(capture) {
    return classifyLoomCapture(capture);
  },
  listReplayActions() {
    return LOOM_REPLAY_ACTIONS;
  },
  buildReplayRequest,
};
