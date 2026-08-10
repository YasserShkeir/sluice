// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The LinkedIn Adapter.
 *
 * Auth contract: LinkedIn's web Voyager API (`https://www.linkedin.com/voyager/…`)
 * is authorized by the BROWSER SESSION COOKIE plus a matching `csrf-token`
 * header derived from `JSESSIONID`. There is no OAuth bearer in the SPA path.
 * `buildReplayRequest` therefore sets `Cookie` from the session's
 * `credentials.values.cookieHeader` and `csrf-token` from
 * `credentials.values.csrfToken` (or derives it from the cookie).
 *
 * Two facts about LinkedIn shape everything below:
 *
 *   1. `matchRequest` is HOST-only for linkedin.com, so the SPA shell, static
 *      assets, and ads hosts under the same eTLD+1 still hit parse(). Labelling
 *      non-Voyager paths `asset` in `classify` is the non-breaking fix.
 *
 *   2. Voyager mixes classic REST (`/voyager/api/me`) with GraphQL queryId URLs
 *      (`/voyager/api/graphql?queryId=…` and family-specific GraphQL paths).
 *      Parsing walks `data` + `included` and recognises job postings, mini
 *      profiles, messaging conversations, and messages by URN shape.
 *
 * Parsing is deliberately defensive — LinkedIn payloads are large and change
 * often — so unknown shapes yield an empty ParseResult rather than throwing.
 */
import type {
  Adapter,
  Actor,
  Capture,
  CaptureClass,
  Container,
  CredentialHint,
  CursorSeed,
  Item,
  ParseContext,
  ParseResult,
  ReplayAction,
  ReplayRequest,
  Session,
  Workspace,
} from '@sluice/core';
import { operationName } from '@sluice/core';
import { arr, num, obj, safeJson, str } from '@sluice/adapter-sdk';
import { csrfTokenFromCookieHeader } from './chrome-cookies.js';

export const ADAPTER_ID = 'linkedin';
export const WORKSPACE_ID = 'linkedin';
export const WORKSPACE_NAME = 'LinkedIn';

/** Stable container every job posting item lands in. */
export const JOBS_CONTAINER_ID = 'linkedin:jobs';
/** Stable container for feed/other items that are not jobs or DMs. */
export const FEED_CONTAINER_ID = 'linkedin:feed';

/** A real Chrome macOS User-Agent — Voyager rejects non-browser agents. */
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

// ── Matching ─────────────────────────────────────────────────────────────────────

export function matchesLinkedIn(host: string): boolean {
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

// ── Path helpers ─────────────────────────────────────────────────────────────────

const P = {
  voyagerApi: /^\/voyager\/api(\/|$)/,
  me: /^\/voyager\/api\/me$/,
  graphql: /\/graphql(\/|$)/i,
  jobCards: /JobCards|jobCards|JobsDash|jobPosting|JobPosting/i,
  messaging: /[Mm]essaging|messenger/i,
  identity: /[Ii]dentity|[Pp]rofile|normalizedProfiles/i,
  realtime: /^\/realtime\//,
  assety: /\.(js|css|png|jpe?g|gif|webp|svg|woff2?|map)(\?|$)/i,
  notApi: /^(?!\/voyager\/)/,
} as const;

export function pathOf(capture: Capture): string {
  return str(capture.path) ?? '';
}

export function queryIdOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.searchParams.get('queryId') ?? undefined;
  } catch {
    const m = /[?&]queryId=([^&]+)/.exec(url);
    return m?.[1] ? decodeURIComponent(m[1]) : undefined;
  }
}

// ── Coercion / walk helpers ──────────────────────────────────────────────────────

/** Pull a display string out of LinkedIn's many text wrappers. */
export function textOf(v: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  const s = str(v);
  if (s !== undefined) {
    const t = s.trim();
    return t.length > 0 ? t : undefined;
  }
  const o = obj(v);
  if (!o) return undefined;
  for (const key of ['text', 'value', 'title', 'accessibilityText', 'plainText']) {
    const inner = textOf(o[key], depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

function epochOf(v: unknown): number | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  // LinkedIn uses ms epochs; reject absurdly small numbers.
  if (n > 1_000_000_000_000) return Math.floor(n);
  if (n > 1_000_000_000) return Math.floor(n * 1000);
  return undefined;
}

function companyNameOf(raw: Record<string, unknown>): string | undefined {
  const cd = obj(raw.companyDetails) ?? obj(raw.company);
  if (cd) {
    const name = textOf(cd.name) ?? str(cd.name);
    if (name) return name;
    const jc = obj(cd.jobCompany);
    if (jc) {
      const rawName = str(jc.rawCompanyName);
      if (rawName) return rawName;
    }
  }
  // Stitched from JobPostingCard.primaryDescription — not secondary (location).
  return textOf(raw.companyName) ?? str(raw.companyName) ?? textOf(raw.primaryDescription);
}

/** Card-level company/location keyed by numeric job posting id. */
type JobCardMeta = { company?: string; location?: string; title?: string };

function jobPostingIdFromRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const m =
    /jobPosting:(\d+)/i.exec(ref) ??
    /jobPostingCard:\((\d+)/i.exec(ref) ??
    /normalized_jobPosting:(\d+)/i.exec(ref);
  return m?.[1];
}

/**
 * Job search cards carry company (primaryDescription) and location
 * (secondaryDescription). Bare JobPosting entities often only have a title +
 * company URN — stitch card text onto postings by shared job id.
 */
function collectJobCardMeta(body: unknown): Map<string, JobCardMeta> {
  const out = new Map<string, JobCardMeta>();
  walkObjects(body, (o) => {
    const type = str(o.$type) ?? '';
    const eu = str(o.entityUrn) ?? '';
    const isCard =
      type.includes('JobPostingCard') ||
      /jobPostingCard/i.test(eu) ||
      (o.primaryDescription !== undefined &&
        (o['*jobPosting'] !== undefined || o.jobPostingUrn !== undefined));
    if (!isCard) return;

    const company = textOf(o.primaryDescription);
    const location = textOf(o.secondaryDescription) ?? textOf(o.tertiaryDescription);
    const title = textOf(o.title) ?? textOf(o.jobPostingTitle);
    if (!company && !location && !title) return;

    const refs = [
      str(o['*jobPosting']),
      str(o.jobPostingUrn),
      str(o.preDashNormalizedJobPostingUrn),
      eu,
    ];
    for (const ref of refs) {
      const id = jobPostingIdFromRef(ref);
      if (!id) continue;
      const prev = out.get(id) ?? {};
      out.set(id, {
        company: prev.company ?? company,
        location: prev.location ?? location,
        title: prev.title ?? title,
      });
    }
  });
  return out;
}

function isJobPostingUrn(urn: string): boolean {
  return /jobPosting/i.test(urn) && !/jobPostingCard/i.test(urn);
}

function isProfileUrn(urn: string): boolean {
  return (
    urn.includes('fs_miniProfile:') ||
    urn.includes('fsd_profile:') ||
    urn.includes('fs_profile:') ||
    /urn:li:member:\d+/.test(urn)
  );
}

function isConversationUrn(urn: string): boolean {
  return urn.includes('msg_conversation:') || urn.includes('messagingThread:');
}

function isMessageUrn(urn: string): boolean {
  return urn.includes('msg_message:') || urn.includes('messagingMessage:');
}

function profileIdFromUrn(urn: string): string {
  const m = /(?:fsd_profile|fs_miniProfile|fs_profile):([^,)\s]+)/.exec(urn);
  if (m?.[1]) return m[1];
  return urn;
}

function walkObjects(root: unknown, visit: (o: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 20) return;
  if (Array.isArray(root)) {
    for (const x of root) walkObjects(x, visit, depth + 1);
    return;
  }
  const o = obj(root);
  if (!o) return;
  visit(o);
  for (const v of Object.values(o)) walkObjects(v, visit, depth + 1);
}

// ── Entity builders ──────────────────────────────────────────────────────────────

function workspace(raw?: Record<string, unknown>): Workspace {
  return {
    id: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    name: WORKSPACE_NAME,
    domain: 'linkedin.com',
    raw,
  };
}

function jobsContainer(): Container {
  return {
    id: JOBS_CONTAINER_ID,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'other',
    name: 'Jobs',
  };
}

function feedContainer(): Container {
  return {
    id: FEED_CONTAINER_ID,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'other',
    name: 'Feed',
  };
}

function actorFromProfile(raw: Record<string, unknown>): Actor | undefined {
  const entityUrn = str(raw.entityUrn) ?? str(raw.dashEntityUrn) ?? str(raw.objectUrn);
  if (!entityUrn) return undefined;
  if (!isProfileUrn(entityUrn) && !str(raw.firstName) && !str(raw.publicIdentifier)) {
    return undefined;
  }
  const id = profileIdFromUrn(entityUrn);
  if (!id) return undefined;

  const first = textOf(raw.firstName) ?? str(raw.firstName) ?? '';
  const last = textOf(raw.lastName) ?? str(raw.lastName) ?? '';
  const displayName = [first, last].filter(Boolean).join(' ').trim() || undefined;
  const handle =
    str(raw.publicIdentifier) ??
    (displayName ? displayName.toLowerCase().replace(/\s+/g, '-') : undefined) ??
    id;
  const occupation = textOf(raw.occupation) ?? str(raw.occupation);

  return {
    id,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    handle,
    displayName: displayName ?? occupation,
    raw,
  };
}

function jobToItem(
  raw: Record<string, unknown>,
  captureId: string,
  cardMeta?: JobCardMeta,
): Item | undefined {
  const entityUrn = str(raw.entityUrn);
  if (!entityUrn || !isJobPostingUrn(entityUrn)) return undefined;
  const title = textOf(raw.title) ?? str(raw.title) ?? cardMeta?.title;
  if (!title) return undefined;

  const company = companyNameOf(raw) ?? cardMeta?.company;
  const location =
    textOf(raw.formattedLocation) ??
    textOf(raw.location) ??
    textOf(raw['*location']) ??
    str(raw.formattedLocation) ??
    cardMeta?.location;

  const bits = [title, company, location].filter(Boolean);
  const ts =
    epochOf(raw.listedAt) ??
    epochOf(raw.originalListedAt) ??
    epochOf(raw.createdAt) ??
    epochOf(raw.expireAt) ??
    0;

  const idMatch = /jobPosting:(\d+)/i.exec(entityUrn);
  const id = idMatch?.[1] ? `job:${idMatch[1]}` : entityUrn;

  const enrichedRaw =
    company || location
      ? {
          ...raw,
          ...(company ? { companyName: company } : {}),
          ...(location && !str(raw.formattedLocation) ? { formattedLocation: location } : {}),
        }
      : raw;

  return {
    id,
    containerId: JOBS_CONTAINER_ID,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'other',
    ts,
    text: bits.join(' · '),
    sourceCaptureIds: [captureId],
    raw: enrichedRaw,
  };
}

function conversationToContainer(raw: Record<string, unknown>): Container | undefined {
  const entityUrn = str(raw.entityUrn);
  const backendUrn = str(raw.backendUrn);
  // Prefer backendUrn (messagingThread:…) — messages reference it as
  // backendConversationUrn, so the container id must match for listMessages.
  const id = backendUrn && isConversationUrn(backendUrn)
    ? backendUrn
    : entityUrn && isConversationUrn(entityUrn)
      ? entityUrn
      : undefined;
  if (!id) return undefined;

  const parts = arr(raw.conversationParticipants) ?? [];
  const names: string[] = [];
  for (const p of parts) {
    const po = obj(p);
    if (!po) continue;
    const pt = obj(po.participantType);
    const member = pt ? obj(pt.member) : undefined;
    if (member) {
      const first = textOf(member.firstName) ?? '';
      const last = textOf(member.lastName) ?? '';
      const n = [first, last].filter(Boolean).join(' ').trim();
      if (n) names.push(n);
    }
  }

  const title =
    textOf(raw.title) ??
    textOf(raw.shortHeadlineText) ??
    (names.length > 0 ? names.join(', ') : undefined) ??
    'Conversation';

  return {
    id,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'thread',
    name: title,
    unreadCount: num(raw.unreadCount),
    memberCount: parts.length || undefined,
    raw,
  };
}

function messageToItem(raw: Record<string, unknown>, captureId: string): Item | undefined {
  const entityUrn = str(raw.entityUrn) ?? str(raw.backendUrn);
  if (!entityUrn || !isMessageUrn(entityUrn)) return undefined;

  const body = obj(raw.body);
  const text =
    textOf(raw.body) ??
    textOf(raw.renderContentFallbackText) ??
    textOf(raw.subject) ??
    (body ? textOf(body) : undefined) ??
    '';

  const conv =
    str(raw.backendConversationUrn) ??
    str(raw.conversation) ??
    (obj(raw.conversation) ? str(obj(raw.conversation)!.entityUrn) : undefined);

  let containerId = FEED_CONTAINER_ID;
  if (conv && isConversationUrn(conv)) containerId = conv;
  else if (typeof raw.conversation === 'string' && isConversationUrn(raw.conversation)) {
    containerId = raw.conversation;
  }

  const sender = obj(raw.sender) ?? obj(raw.actor);
  let authorId: string | undefined;
  if (sender) {
    const host = str(sender.hostIdentityUrn) ?? str(sender.entityUrn);
    if (host) authorId = profileIdFromUrn(host);
  }

  return {
    id: entityUrn,
    containerId,
    workspaceId: WORKSPACE_ID,
    adapterId: ADAPTER_ID,
    kind: 'message',
    authorId,
    ts: epochOf(raw.deliveredAt) ?? epochOf(raw.createdAt) ?? 0,
    text,
    sourceCaptureIds: [captureId],
    raw,
  };
}

// ── Parser ───────────────────────────────────────────────────────────────────────

/**
 * Turn one LinkedIn capture into normalized entities.
 * Never throws — unknown/malformed bodies yield `{}`.
 */
export function parseLinkedInCapture(capture: Capture): ParseResult {
  try {
    if (!matchesLinkedIn(capture.host)) return {};
    const path = pathOf(capture);
    if (!P.voyagerApi.test(path) && !path.includes('/voyager/')) return {};
    if (!capture.resBody) return {};

    const body = safeJson(capture.resBody);
    if (body === undefined) return {};

    const jobCardMeta = collectJobCardMeta(body);

    const actors: Actor[] = [];
    const containers: Container[] = [];
    const items: Item[] = [];
    const seenActors = new Set<string>();
    const seenContainers = new Set<string>();
    const seenItems = new Set<string>();
    let sawJob = false;
    let sawMe = false;
    let meSummary: Record<string, unknown> | undefined;

    const pushActor = (a: Actor | undefined): void => {
      if (!a || seenActors.has(a.id)) return;
      seenActors.add(a.id);
      actors.push(a);
    };
    const pushContainer = (c: Container | undefined): void => {
      if (!c || seenContainers.has(c.id)) return;
      seenContainers.add(c.id);
      containers.push(c);
    };
    const pushItem = (i: Item | undefined): void => {
      if (!i || seenItems.has(i.id)) return;
      seenItems.add(i.id);
      items.push(i);
    };

    if (P.me.test(path)) {
      sawMe = true;
      const root = obj(body);
      const included = root ? arr(root.included) : undefined;
      if (included) {
        for (const row of included) {
          const o = obj(row);
          if (!o) continue;
          if (o.firstName !== undefined || o.lastName !== undefined || o.publicIdentifier) {
            const a = actorFromProfile(o);
            pushActor(a);
            if (a && !meSummary) {
              meSummary = {
                handle: a.handle,
                displayName: a.displayName,
                publicIdentifier: str(o.publicIdentifier) ?? a.handle,
                occupation: str(o.occupation) ?? textOf(o.occupation),
                memberId: str(o.objectUrn) ?? undefined,
                plainId: root && obj(root.data) ? num(obj(root.data)!.plainId) : undefined,
                entityUrn: str(o.entityUrn),
                dashEntityUrn: str(o.dashEntityUrn),
              };
            }
          }
        }
      }
      const data = root ? obj(root.data) : undefined;
      if (data && actors.length === 0) {
        const mini = str(data['*miniProfile']);
        if (mini) {
          pushActor({
            id: profileIdFromUrn(mini),
            workspaceId: WORKSPACE_ID,
            adapterId: ADAPTER_ID,
            handle: profileIdFromUrn(mini),
            raw: data,
          });
          meSummary = {
            handle: profileIdFromUrn(mini),
            plainId: num(data.plainId),
            entityUrn: mini,
          };
        }
      }
    }

    walkObjects(body, (o) => {
      const eu = str(o.entityUrn);
      const type = str(o.$type) ?? str(o._type) ?? '';

      if (
        (eu &&
          isProfileUrn(eu) &&
          (o.firstName !== undefined || o.lastName !== undefined || o.publicIdentifier)) ||
        type.includes('MiniProfile') ||
        type.includes('miniProfile')
      ) {
        pushActor(actorFromProfile(o));
      }

      if (
        eu &&
        isJobPostingUrn(eu) &&
        (o.title !== undefined || type.toLowerCase().includes('jobposting'))
      ) {
        const idMatch = /jobPosting:(\d+)/i.exec(eu);
        const meta = idMatch?.[1] ? jobCardMeta.get(idMatch[1]) : undefined;
        const item = jobToItem(o, capture.id, meta);
        if (item) {
          sawJob = true;
          pushItem(item);
        }
      }

      if (
        eu &&
        isConversationUrn(eu) &&
        (o.conversationParticipants !== undefined || o.lastActivityAt !== undefined)
      ) {
        pushContainer(conversationToContainer(o));
        for (const p of arr(o.conversationParticipants) ?? []) {
          const po = obj(p);
          if (!po) continue;
          const pt = obj(po.participantType);
          const member = pt ? obj(pt.member) : undefined;
          if (member) {
            const host = str(po.hostIdentityUrn);
            pushActor(
              actorFromProfile({
                ...member,
                entityUrn: host ?? str(po.entityUrn),
                firstName: member.firstName,
                lastName: member.lastName,
              }),
            );
          }
        }
      }

      if (
        eu &&
        isMessageUrn(eu) &&
        (o.body !== undefined || o.deliveredAt !== undefined || o.renderContent !== undefined)
      ) {
        pushItem(messageToItem(o, capture.id));
      }
    });

    if (sawJob) pushContainer(jobsContainer());
    if (items.some((i) => i.containerId === FEED_CONTAINER_ID)) pushContainer(feedContainer());

    const result: ParseResult = {};
    if (sawMe || actors.length || containers.length || items.length) {
      result.workspaces = [workspace(meSummary)];
    }
    if (actors.length) result.actors = actors;
    if (containers.length) result.containers = containers;
    if (items.length) result.items = items;
    return result;
  } catch {
    return {};
  }
}

// ── Classify ─────────────────────────────────────────────────────────────────────

function operationOf(capture: Capture): string {
  const qid = queryIdOf(capture.url);
  if (qid) {
    // queryId is like "voyagerJobsDashJobCards.abc123" — keep the family name.
    const base = qid.split('.')[0] ?? qid;
    return base.length > 80 ? base.slice(0, 80) : base;
  }
  return operationName(pathOf(capture));
}

export function classifyLinkedInCapture(capture: Capture): {
  class: CaptureClass;
  operation?: string;
} {
  try {
    if (!matchesLinkedIn(capture.host)) return { class: 'unknown' };
    const path = pathOf(capture);
    const operation = operationOf(capture);
    const status = capture.status;
    if (typeof status === 'number' && status >= 400) return { class: 'error', operation };

    if (P.realtime.test(path)) return { class: 'unknown', operation };
    if (P.assety.test(path) || path.includes('/li/track') || path.includes('/checkpoint/')) {
      return { class: 'asset', operation: 'asset' };
    }
    if (!P.voyagerApi.test(path)) {
      if (P.notApi.test(path) && !path.includes('/voyager/')) {
        return { class: 'asset', operation: 'asset' };
      }
      return { class: 'unknown', operation };
    }
    if (P.me.test(path)) return { class: 'auth', operation: 'voyager/api/me' };
    if (P.identity.test(path)) return { class: 'structure', operation };
    if (P.jobCards.test(path) || /JobPosting|jobsDash|JobsDash/i.test(path)) {
      return { class: 'messages', operation };
    }
    if (P.messaging.test(path)) return { class: 'messages', operation };
    if (P.graphql.test(path)) {
      const qid = queryIdOf(capture.url) ?? '';
      if (/profile|identity|Me\b|miniProfile/i.test(qid)) return { class: 'structure', operation };
      if (/job|Job|message|Message|messenger|conversation/i.test(qid)) {
        return { class: 'messages', operation };
      }
      return { class: 'unknown', operation };
    }
    return { class: 'unknown', operation };
  } catch {
    return { class: 'unknown' };
  }
}

// ── Cursors ──────────────────────────────────────────────────────────────────────

export function linkedInNextCursors(_capture: Capture, _ctx?: ParseContext): CursorSeed[] {
  return [];
}

// ── Replay ───────────────────────────────────────────────────────────────────────

const LINKEDIN_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'linkedin.me',
    adapterId: ADAPTER_ID,
    label: 'Current member (me)',
    method: 'GET',
    urlTemplate: 'https://www.linkedin.com/voyager/api/me',
    params: [],
  },
  {
    id: 'linkedin.jobs.search',
    adapterId: ADAPTER_ID,
    label: 'Job search (keywords)',
    method: 'GET',
    // Browser-shaped JobCards collection — same path live LinkedIn search uses.
    urlTemplate:
      'https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220&count=25&q=jobSearch&start=0',
    params: [
      {
        name: 'keywords',
        label: 'Search keywords (e.g. django)',
        kind: 'string',
        required: true,
      },
      {
        name: 'start',
        label: 'Pagination start offset',
        kind: 'string',
        default: '0',
      },
      {
        name: 'count',
        label: 'Page size (max ~25)',
        kind: 'string',
        default: '25',
      },
    ],
  },
  {
    id: 'linkedin.graphql',
    adapterId: ADAPTER_ID,
    label: 'Voyager GraphQL by queryId',
    method: 'GET',
    urlTemplate: 'https://www.linkedin.com/voyager/api/graphql',
    params: [
      {
        name: 'queryId',
        label: 'queryId (e.g. voyagerJobsDashJobCards.…)',
        kind: 'string',
        required: true,
      },
      {
        name: 'variables',
        label: 'GraphQL variables (optional, raw)',
        kind: 'string',
      },
    ],
  },
];

/**
 * Build a Voyager request with Cookie + csrf-token and browser-like headers.
 *
 * LinkedIn rejects requests missing `csrf-token` even when Cookie is valid.
 * csrf is taken from session credentials or derived from JSESSIONID.
 */
export function buildLinkedInReplayRequest(
  action: ReplayAction,
  params: Record<string, string>,
  session: Session,
): ReplayRequest {
  const cookieHeader = session.credentials.values.cookieHeader ?? '';
  const csrf =
    session.credentials.values.csrfToken ?? csrfTokenFromCookieHeader(cookieHeader) ?? '';

  const headers: Record<string, string> = {
    'User-Agent': CHROME_UA,
    Accept: 'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    Referer: `${LINKEDIN_ORIGIN}/`,
    Origin: LINKEDIN_ORIGIN,
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (csrf) headers['csrf-token'] = csrf;

  if (action.id === 'linkedin.me') {
    return { method: 'GET', url: action.urlTemplate, headers };
  }

  if (action.id === 'linkedin.jobs.search') {
    const keywords = (params.keywords ?? '').trim();
    if (!keywords) {
      throw new Error('LinkedIn replay action "linkedin.jobs.search" needs keywords.');
    }
    // Rest.li jobSearch query — keep colons/parens unescaped like the SPA.
    const start = params.start ?? '0';
    const count = params.count ?? '25';
    const query = `(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:${keywords},spellCorrectionEnabled:true)`;
    const url =
      'https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards' +
      '?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220' +
      `&count=${encodeURIComponent(count)}` +
      '&q=jobSearch' +
      `&query=${query}` +
      `&start=${encodeURIComponent(start)}`;
    return {
      method: 'GET',
      url,
      headers: {
        ...headers,
        Referer: `${LINKEDIN_ORIGIN}/jobs/search/?keywords=${encodeURIComponent(keywords)}`,
      },
    };
  }

  if (action.id === 'linkedin.graphql') {
    const queryId = params.queryId ?? action.params.find((p) => p.name === 'queryId')?.default;
    if (!queryId) {
      throw new Error('LinkedIn replay action "linkedin.graphql" needs a queryId.');
    }
    const u = new URL(action.urlTemplate);
    u.searchParams.set('queryId', queryId);
    const variables = params.variables;
    if (variables) u.searchParams.set('variables', variables);
    return { method: 'GET', url: u.toString(), headers };
  }

  const u = new URL(action.urlTemplate);
  for (const p of action.params) {
    const v = params[p.name] ?? p.default;
    if (v !== undefined && v !== '') u.searchParams.set(p.name, v);
  }
  return { method: action.method, url: u.toString(), headers };
}

// ── Credential hints from live captures ──────────────────────────────────────────

function previewSecret(value: string): string {
  if (value.length <= 12) return '«present»';
  return `${value.slice(0, 6)}…（${value.length - 6} more）`;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want && typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Surface Cookie / csrf presence. On redacted captures (normal path) values are
 * already masked — report presence only. Never emit a full secret.
 */
export function extractLinkedInCredentialHints(capture: Capture): CredentialHint[] {
  try {
    if (!matchesLinkedIn(capture.host)) return [];
    const hints: CredentialHint[] = [];
    const cookie = headerOf(capture.reqHeaders, 'cookie');
    if (cookie !== undefined) {
      const redacted = cookie.includes('«redacted»') || cookie === '«redacted»';
      hints.push({
        adapterId: ADAPTER_ID,
        location: 'cookie',
        name: 'cookie',
        valuePreview: redacted ? '«present»' : previewSecret(cookie),
        confidence: redacted ? 0.6 : 0.9,
        role: 'session-cookie',
      });
    }
    const csrf = headerOf(capture.reqHeaders, 'csrf-token');
    if (csrf !== undefined) {
      const redacted = csrf.includes('«redacted»') || csrf === '«redacted»';
      hints.push({
        adapterId: ADAPTER_ID,
        location: 'header',
        name: 'csrf-token',
        valuePreview: redacted ? '«present»' : previewSecret(csrf),
        confidence: redacted ? 0.6 : 0.85,
        role: 'csrf',
      });
    }
    return hints;
  } catch {
    return [];
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────────

export const linkedinAdapter: Adapter = {
  id: ADAPTER_ID,
  displayName: 'LinkedIn',
  // Parent domain only: tlsInterceptList derives *.linkedin.com from it.
  hosts: ['linkedin.com'],
  matchRequest(input) {
    return matchesLinkedIn(input.host);
  },
  parse(capture) {
    return parseLinkedInCapture(capture);
  },
  classify(capture) {
    return classifyLinkedInCapture(capture);
  },
  nextCursors(capture, ctx) {
    return linkedInNextCursors(capture, ctx);
  },
  listReplayActions() {
    return LINKEDIN_REPLAY_ACTIONS;
  },
  buildReplayRequest(action, params, session) {
    return buildLinkedInReplayRequest(action, params, session);
  },
  extractCredentialHints(capture) {
    return extractLinkedInCredentialHints(capture);
  },
};
