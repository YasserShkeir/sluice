// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * LinkedIn MCP tools — mostly store-backed.
 *
 * These answer from what was CAPTURED. Network tools go through `ctx.replay`
 * so they pick up the real client's fingerprint and land in the store.
 *
 * Every tool is total against an empty store: returning nothing is an answer;
 * throwing is reserved for "host did not provide a store" / hard misconfig.
 *
 * Profile identity is carried on the LinkedIn workspace's `raw` (filled by
 * parse of `/voyager/api/me`). `ReadOnlyStore` has no actor list method.
 */
import { num, obj, str } from '@sluice/adapter-sdk';
import type { AppMcpTool, AppToolContext, Item, ReadOnlyStore, Workspace } from '@sluice/core';
import { z } from 'zod';
import { ADAPTER_ID, JOBS_CONTAINER_ID, WORKSPACE_ID } from './linkedin-adapter.js';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;
const SNIPPET_CHARS = 240;

const PAGE_SCHEMA = {
  limit: z.number().int().positive().max(MAX_PAGE).optional(),
  offset: z.number().int().min(0).optional(),
};

function requireStore(ctx?: AppToolContext): ReadOnlyStore {
  if (ctx?.store === undefined) {
    throw new Error(
      'This tool reads the Sluice capture store, and the host did not provide one. Run it through `sluice-mcp`.',
    );
  }
  return ctx.store;
}

function page(args: Record<string, unknown>): { limit: number; offset: number } {
  const limit = num(args.limit);
  const offset = num(args.offset);
  return {
    limit: limit !== undefined && limit > 0 ? Math.min(Math.floor(limit), MAX_PAGE) : DEFAULT_PAGE,
    offset: offset !== undefined && offset > 0 ? Math.floor(offset) : 0,
  };
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

function isoOf(ts: number | null | undefined): string | null {
  if (ts === null || ts === undefined) return null;
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function linkedInWorkspaces(store: ReadOnlyStore): Workspace[] {
  return store.listWorkspaces().filter((w) => w.adapterId === ADAPTER_ID);
}

function jobView(item: Item): {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  listedAt: string | null;
  text: string;
} {
  const raw = obj(item.raw) ?? {};
  const title =
    (typeof raw.title === 'string' ? raw.title : undefined) ??
    item.text.split(' · ')[0] ??
    item.text;
  const parts = item.text.split(' · ').map((p) => p.trim()).filter(Boolean);
  const stitchedCompany = str(raw.companyName);
  const cd = obj(raw.companyDetails);
  const company =
    stitchedCompany ||
    (cd && str(cd.name)) ||
    (parts.length >= 2 ? parts[1]! : null);
  const location =
    str(raw.formattedLocation) ||
    (parts.length >= 3 ? parts[2]! : null);
  return {
    id: item.id,
    title,
    company: company && !company.startsWith('urn:') ? company : null,
    location: location && !location.startsWith('urn:') ? location : null,
    listedAt: isoOf(item.ts > 0 ? item.ts : null),
    text: preview(item.text),
  };
}

async function syncStatus(_args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const store = requireStore(ctx);
  const workspaces = linkedInWorkspaces(store);
  const allContainers = store.listContainers().filter((c) => c.adapterId === ADAPTER_ID);
  const jobs = store.countItems({ adapterId: ADAPTER_ID, containerId: JOBS_CONTAINER_ID });
  const items = store.countItems({ adapterId: ADAPTER_ID });
  const threads = allContainers.filter((c) => c.kind === 'thread');
  const captures = store.countCaptures({ adapterId: ADAPTER_ID });
  const newest = store.newestCaptureTs({ adapterId: ADAPTER_ID });
  const meRaw = obj(workspaces[0]?.raw);

  // Messages: items whose kind is message — count via query when possible.
  const sample = store.queryItems({ adapterId: ADAPTER_ID, limit: 500, offset: 0 });
  const messageCount = sample.filter((i) => i.kind === 'message').length;

  return {
    adapterId: ADAPTER_ID,
    workspaceId: WORKSPACE_ID,
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, domain: w.domain })),
    me: meRaw
      ? {
          displayName: str(meRaw.displayName) ?? null,
          handle: str(meRaw.publicIdentifier) ?? str(meRaw.handle) ?? null,
          occupation: str(meRaw.occupation) ?? null,
        }
      : null,
    containers: allContainers.length,
    conversations: threads.length,
    jobs,
    messages: messageCount,
    items,
    captures,
    newestCaptureAt: isoOf(newest),
    complete: false,
    note:
      'Answers reflect only what Sluice has captured from LinkedIn Voyager traffic — not a full account export.',
  };
}

async function listJobs(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const store = requireStore(ctx);
  const { limit, offset } = page(args);
  const q = str(args.q)?.trim();

  let jobs: Item[];
  if (q) {
    jobs = store
      .searchItems(q, { adapterId: ADAPTER_ID, limit: offset + limit })
      .filter((i) => i.containerId === JOBS_CONTAINER_ID || i.id.startsWith('job:'));
  } else {
    jobs = store.queryItems({
      adapterId: ADAPTER_ID,
      containerId: JOBS_CONTAINER_ID,
      limit: offset + limit,
      offset: 0,
    });
    if (jobs.length === 0) {
      jobs = store
        .queryItems({ adapterId: ADAPTER_ID, limit: offset + limit + 200, offset: 0 })
        .filter((i) => i.id.startsWith('job:') || i.containerId === JOBS_CONTAINER_ID);
    }
  }

  const total = q
    ? jobs.length
    : store.countItems({ adapterId: ADAPTER_ID, containerId: JOBS_CONTAINER_ID });
  const slice = jobs.slice(offset, offset + limit);
  return {
    total: q ? jobs.length : total,
    offset,
    limit,
    jobs: slice.map(jobView),
  };
}

async function me(_args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const store = requireStore(ctx);
  const workspaces = linkedInWorkspaces(store);
  if (workspaces.length === 0) {
    return {
      me: null,
      note: 'No LinkedIn workspace in the store yet. Capture /voyager/api/me (open LinkedIn while Sluice is capturing) or run linkedin_fetch_me.',
    };
  }
  const w = workspaces[0]!;
  const raw = obj(w.raw) ?? {};
  const handle = str(raw.publicIdentifier) ?? str(raw.handle) ?? null;
  const displayName = str(raw.displayName) ?? null;
  return {
    me: {
      workspaceId: w.id,
      handle,
      displayName,
      occupation: str(raw.occupation) ?? null,
      publicIdentifier: handle,
      profileUrl: handle ? `https://www.linkedin.com/in/${handle}/` : null,
      memberId: str(raw.memberId) ?? num(raw.plainId) ?? null,
    },
  };
}

async function listConversations(
  args: Record<string, unknown>,
  ctx?: AppToolContext,
): Promise<unknown> {
  const store = requireStore(ctx);
  const { limit, offset } = page(args);
  const threads = store
    .listContainers()
    .filter((c) => c.adapterId === ADAPTER_ID && c.kind === 'thread');
  const slice = threads.slice(offset, offset + limit);
  return {
    total: threads.length,
    offset,
    limit,
    conversations: slice.map((c) => ({
      id: c.id,
      name: c.name,
      unreadCount: c.unreadCount ?? null,
      memberCount: c.memberCount ?? null,
    })),
  };
}

async function listMessages(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const store = requireStore(ctx);
  const { limit, offset } = page(args);
  const conversationId = str(args.conversationId);

  let messages = store.queryItems({
    adapterId: ADAPTER_ID,
    containerId: conversationId,
    limit: Math.min(offset + limit + 200, MAX_PAGE * 2),
    offset: 0,
  });
  messages = messages.filter((i) => i.kind === 'message');
  if (conversationId) {
    messages = messages.filter((i) => i.containerId === conversationId);
  }
  const slice = messages.slice(offset, offset + limit);
  return {
    total: messages.length,
    offset,
    limit,
    messages: slice.map((m) => ({
      id: m.id,
      conversationId: m.containerId,
      authorId: m.authorId ?? null,
      at: isoOf(m.ts > 0 ? m.ts : null),
      text: preview(m.text),
    })),
  };
}

async function search(args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  const store = requireStore(ctx);
  const q = str(args.q);
  if (!q || q.trim().length === 0) {
    throw new Error('linkedin_search requires a non-empty `q` string.');
  }
  const { limit, offset } = page(args);
  const items = store.searchItems(q, {
    adapterId: ADAPTER_ID,
    limit: offset + limit,
    offset: 0,
  });
  const slice = items.slice(offset, offset + limit);
  return {
    q,
    total: items.length,
    offset,
    limit,
    items: slice.map((i) => ({
      id: i.id,
      kind: i.kind,
      containerId: i.containerId,
      at: isoOf(i.ts > 0 ? i.ts : null),
      text: preview(i.text),
    })),
  };
}

async function fetchMeLive(_args: Record<string, unknown>, ctx?: AppToolContext): Promise<unknown> {
  if (!ctx?.replay) {
    throw new Error(
      'linkedin_fetch_me needs AppToolContext.replay — run it through `sluice-mcp` with a live session.',
    );
  }
  const capture = await ctx.replay({
    method: 'GET',
    url: 'https://www.linkedin.com/voyager/api/me',
    headers: {
      Accept: 'application/vnd.linkedin.normalized+json+2.1',
      'x-restli-protocol-version': '2.0.0',
      Referer: 'https://www.linkedin.com/',
    },
  });
  return {
    status: capture.status,
    captureId: capture.id,
    note: 'Capture stored and parsed by the host. Use linkedin_me to read the profile from the store.',
  };
}

export function linkedinMcpTools(): AppMcpTool[] {
  return [
    {
      name: 'linkedin_sync_status',
      description:
        'Summarise what LinkedIn data Sluice has already captured (profile, jobs, conversations, messages). Store-only; does not hit the network.',
      inputSchema: {},
      run: syncStatus,
    },
    {
      name: 'linkedin_me',
      description:
        'Return the signed-in LinkedIn member as captured (name, handle, occupation) from the local store.',
      inputSchema: {},
      run: me,
    },
    {
      name: 'linkedin_list_jobs',
      description:
        'List job postings captured from LinkedIn Voyager (title, company, location). Optional `q` filters by text. Store-only.',
      inputSchema: {
        ...PAGE_SCHEMA,
        q: z.string().optional(),
      },
      run: listJobs,
    },
    {
      name: 'linkedin_list_conversations',
      description:
        'List messaging conversations captured from LinkedIn (name, unread). Store-only.',
      inputSchema: { ...PAGE_SCHEMA },
      run: listConversations,
    },
    {
      name: 'linkedin_list_messages',
      description:
        'List messaging messages captured from LinkedIn. Optional `conversationId` scopes to one thread. Store-only.',
      inputSchema: {
        ...PAGE_SCHEMA,
        conversationId: z.string().optional(),
      },
      run: listMessages,
    },
    {
      name: 'linkedin_search',
      description: 'Full-text search over captured LinkedIn items (`q`). Store-only.',
      inputSchema: {
        q: z.string(),
        ...PAGE_SCHEMA,
      },
      run: search,
    },
    {
      name: 'linkedin_fetch_me',
      description:
        'Live GET /voyager/api/me through Sluice replay (uses the local session). Prefer linkedin_me for store reads.',
      inputSchema: {},
      run: fetchMeLive,
    },
  ];
}
