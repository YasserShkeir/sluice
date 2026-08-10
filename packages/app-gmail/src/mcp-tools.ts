// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sluice's own Gmail MCP.
 *
 * Five tools that answer entirely from what was CAPTURED. None of them touches
 * the network — that is the whole point. This is not Google's connector wrapped,
 * it is the mailbox as Sluice recorded it, so the answers are exactly as complete
 * as the capture and no more, which is what `gmail_sync_status` exists to say out
 * loud.
 *
 * They lived in `packages/mcp/src/server.ts` until `AppToolContext` grew a
 * read-only store. `AppToolContext` used to carry nothing but `replay` — one live
 * network request — so a store-backed app tool could not be written at all, and
 * four Gmail tools were compiled into the MCP server's own spine instead. That
 * cost two things worth naming: `@sluice/apps` is meant to be the only module
 * that knows a concrete adapter id, and the app catalog computes its MCP flag
 * from `mcpTools()` — so the dashboard reported Gmail as contributing none while
 * `sluice-mcp` served four.
 *
 * Every tool is total against an empty store: a Sluice-backed MCP is queried
 * before anything has been captured, because on a fresh install that is the FIRST
 * thing that happens. Returning nothing is an answer; throwing is a bug report
 * the user cannot act on.
 *
 * A store can hold SEVERAL signed-in accounts — Gmail serves them as `/u/0`,
 * `/u/1` — and every tool that lists takes an optional `account` to stay inside
 * one. Unscoped, they answer across all of them, which is right for the common
 * one-account store and is why the parameter is optional rather than required.
 * `gmail_sync_status` is the tool that says which accounts exist at all;
 * `gmail_get_thread` needs no such parameter and says why above itself.
 */
import { num, str } from '@sluice/adapter-sdk';
import type { AppMcpTool, AppToolContext, Item, ReadOnlyStore, Workspace } from '@sluice/core';
import { z } from 'zod';
import type { AddressRef } from './gmail-adapter.js';
import {
  ADAPTER_ID,
  containerKind,
  gmailMessageView,
  gmailThreadView,
  labelContainerId,
  isProvisionalWorkspaceId,
  labelRef,
} from './gmail-adapter.js';

// ── Shared shapes ────────────────────────────────────────────────────────────────

const DEFAULT_PAGE = 50;
const MAX_PAGE = 500;

/**
 * How many messages one `gmail_get_thread` will read.
 *
 * A ceiling rather than a page: a thread is a unit a reader wants whole, and
 * paginating one would make "read this conversation" two calls for no benefit.
 * The longest thread in the Gmail recording holds 12 messages.
 */
const MAX_THREAD_MESSAGES = 500;

/** How much body text a list entry carries before it stops being a preview. */
const SNIPPET_CHARS = 240;

/**
 * The most rows one paged read will pull out of the store.
 *
 * The scan below doubles until enough rows have SURVIVED whatever the page is
 * really counting — distinct threads, or hits belonging to one account — and a
 * store where that never converges (one thread holding tens of thousands of
 * messages; a search whose every hit is the other account's) must not turn a page
 * request into a full table read.
 */
const MAX_ROW_SCAN = 20_000;

interface Page {
  limit: number;
  offset: number;
}

/**
 * The page an agent asked for.
 *
 * `offset` is what was missing: an agent facing thousands of threads used to get
 * the first N and had no way to walk on — the tool simply had no word for "the
 * next fifty".
 */
function page(args: Record<string, unknown>): Page {
  const limit = num(args.limit);
  const offset = num(args.offset);
  return {
    limit: limit !== undefined && limit > 0 ? Math.min(Math.floor(limit), MAX_PAGE) : DEFAULT_PAGE,
    offset: offset !== undefined && offset > 0 ? Math.floor(offset) : 0,
  };
}

const PAGE_SCHEMA = {
  limit: z.number().int().positive().max(MAX_PAGE).optional(),
  offset: z.number().int().min(0).optional(),
};

/**
 * Which signed-in Gmail account to answer for.
 *
 * Optional on every tool that has it, and omitting it means "all of them" — a
 * one-account mailbox, which is most of them, never has to say anything.
 */
const ACCOUNT_SCHEMA = { account: z.string().optional() };

/**
 * The store, or a refusal that names what is missing.
 *
 * `AppToolContext.store` is optional so that adding it broke no existing app or
 * host, which means a tool that needs it has to check. Throwing is right here:
 * the MCP server turns a thrown error into a tool error with a message, and "I
 * was not given a store" is something the operator can fix, unlike an empty list.
 */
function requireStore(ctx?: AppToolContext): ReadOnlyStore {
  if (ctx?.store === undefined) {
    throw new Error(
      'This tool reads the Sluice capture store, and the host did not provide one. Run it through `sluice-mcp`.',
    );
  }
  return ctx.store;
}

// ── Accounts ─────────────────────────────────────────────────────────────────────

/** Every signed-in Gmail account the store holds, in listing order. */
function gmailAccounts(store: ReadOnlyStore): Workspace[] {
  return store.listWorkspaces().filter((w) => w.adapterId === ADAPTER_ID);
}

/** `gmail:u0 (someone@example.test)`, for an error a caller can act on. */
function nameAccounts(store: ReadOnlyStore): string {
  const all = gmailAccounts(store);
  if (all.length === 0) return 'No Gmail accounts have been captured yet.';
  return `Captured accounts: ${all
    .map((w) => (w.domain === undefined ? w.id : `${w.id} (${w.domain})`))
    .join(', ')}.`;
}

/**
 * The workspace id an `account` argument names, or undefined when the caller
 * passed none and means the whole mailbox.
 *
 * Two spellings, because two are in circulation and a caller cannot be expected
 * to know which it holds: the workspace id `gmail:u0`, which every row carries
 * and every tool returns, and the ADDRESS, which is the only spelling a human
 * has — nobody knows their own account by its browser sign-in index.
 *
 * An unknown or ambiguous name throws rather than filtering to nothing. An empty
 * list reads as "this mailbox is empty"; it does not read as "you typed an
 * address that was never captured", and the difference decides whether the
 * caller retries or reports.
 */
function resolveAccount(store: ReadOnlyStore, account: string | undefined): string | undefined {
  if (account === undefined || account.length === 0) return undefined;
  const wanted = account.toLowerCase();
  const matches = gmailAccounts(store).filter(
    (w) => w.id.toLowerCase() === wanted || w.domain?.toLowerCase() === wanted,
  );
  const first = matches[0];
  if (first === undefined) {
    throw new Error(`No captured Gmail account matches "${account}". ${nameAccounts(store)}`);
  }
  // One address under two slot ids is what a re-login in a different order looks
  // like — see accountWorkspaceId. Answering for one of them silently would hide
  // exactly the mail the caller is missing.
  if (matches.length > 1) {
    throw new Error(
      `"${account}" matches more than one captured account (${matches
        .map((w) => w.id)
        .join(', ')}) — pass the workspace id to pick one.`,
    );
  }
  return first.id;
}

/**
 * The Container ids a `labelId` argument names.
 *
 * The friendly form is the BARE Gmail id: `^i` is what `gmail_list_labels`
 * documents, what Gmail's own request queries carry, and what a human types. A
 * Container id is scoped per account (`gmail:u0/^i`), so a bare label names one
 * view PER ACCOUNT — it fans out over the accounts in scope, while a scoped id
 * selects exactly the one it names. Both are accepted precisely so a caller never
 * has to know which one it is holding.
 *
 * Anything that is not a label id at all — the `gmail:u0/unknown` bucket, which
 * `gmail_list_threads` hands back as a `labelId` and must therefore take back —
 * is passed through as the container id it is.
 */
function labelContainers(
  store: ReadOnlyStore,
  labelId: string,
  workspaceId: string | undefined,
): string[] {
  const ref = labelRef(labelId);
  if (ref === undefined) return [labelId];
  if (ref.workspaceId !== undefined) {
    if (workspaceId !== undefined && ref.workspaceId !== workspaceId) {
      throw new Error(
        `labelId "${labelId}" belongs to ${ref.workspaceId}, but account resolves to ${workspaceId}.`,
      );
    }
    return [labelId];
  }
  const scope = workspaceId === undefined ? gmailAccounts(store).map((w) => w.id) : [workspaceId];
  // The bare id last: rows written before ids were scoped keep it forever, and
  // nothing re-parses a mailbox. The `workspaceId` filter on the query is what
  // keeps those rows inside the account that owns them.
  return [...scope.map((id) => labelContainerId(id, ref.labelId)), ref.labelId];
}

/**
 * The epoch alongside an ISO string, because deciding "is this stale?" from a
 * millisecond integer is arithmetic a model should not have to do — and
 * `new Date(NaN).toISOString()` THROWS, so the guard is not decoration.
 */
function isoOf(ts: number | null | undefined): string | null {
  if (ts === null || ts === undefined) return null;
  const at = new Date(ts);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** A one-line preview: whitespace collapsed, then clipped. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat;
}

/**
 * The body of a stored message item.
 *
 * `raw` is the message record and is the truth; `text` is the flattened
 * `subject\n\nbody` the FTS index and every generic reader see. Falling back to
 * `text` matters for an item written before the parser landed bodies — the store
 * is a persistent artifact, so old rows outlive the parser that made them.
 */
function messageParts(item: Item): { subject: string; body: string; from: AddressRef | null } {
  const view = gmailMessageView(item.raw);
  return {
    subject: view.subject,
    body: view.body.length > 0 ? view.body : item.text,
    from: view.from ?? null,
  };
}

// ── The thread list ──────────────────────────────────────────────────────────────

interface ThreadSummary {
  threadId: string;
  workspaceId: string;
  /** Epoch ms of the newest message in the thread. */
  ts: number;
  date: string | null;
  subject: string;
  from: AddressRef | null;
  snippet: string;
  /** How many messages Gmail says the thread holds. 0 when only Sluice's count is known. */
  messageCount: number;
  /** How many of them Sluice actually holds — `gmail_get_thread` returns these. */
  messagesHeld: number;
  /**
   * The label view that listed this thread, when it came from one — the scoped
   * Container id (`gmail:u0/^i`), which is what `gmail_list_threads` takes back.
   */
  labelId?: string;
}

/**
 * Fold one `bv` thread row into the accumulator.
 *
 * A `bv` row is the THREAD's own record: Gmail's subject for it, its snippet, and
 * how many messages it holds. It wins over anything derived from a message,
 * because a message only knows about itself — which is why these are folded
 * first and a second sighting only ever moves the timestamp forward.
 *
 * A thread listed by two label views is two rows carrying the same record, so a
 * repeat here is normal and must not become a duplicate entry.
 */
function foldThreadRow(into: Map<string, ThreadSummary>, item: Item): void {
  const existing = into.get(item.id);
  if (existing !== undefined) {
    if (item.ts > existing.ts) {
      existing.ts = item.ts;
      existing.date = isoOf(item.ts);
    }
    return;
  }
  const view = gmailThreadView(item.raw);
  into.set(item.id, {
    threadId: item.id,
    workspaceId: item.workspaceId,
    ts: item.ts,
    date: isoOf(item.ts),
    subject: view.subject,
    from: view.from ?? null,
    snippet: preview(item.text),
    messageCount: view.messageCount,
    messagesHeld: 0,
    labelId: item.containerId,
  });
}

/**
 * Fold one fetched MESSAGE into the accumulator, creating the thread if the
 * batch view never listed it.
 *
 * Both directions matter. A thread the batch view listed gains nothing but the
 * knowledge that its messages are readable. A thread that arrived through `fd`
 * alone — opened from a view Sluice never captured — exists ONLY as messages, and
 * without this it would be invisible to every list while being the one thing in
 * the store that actually has a body to read.
 *
 * Messages arrive newest-first, so the first sighting of a thread is its newest
 * message and later ones must not overwrite it.
 */
function foldMessage(into: Map<string, ThreadSummary>, item: Item): void {
  const threadId = item.threadId ?? item.containerId;
  const existing = into.get(threadId);
  if (existing !== undefined) {
    if (item.ts > existing.ts) {
      existing.ts = item.ts;
      existing.date = isoOf(item.ts);
    }
    return;
  }
  const parts = messageParts(item);
  into.set(threadId, {
    threadId,
    workspaceId: item.workspaceId,
    ts: item.ts,
    date: isoOf(item.ts),
    subject: parts.subject,
    from: parts.from,
    snippet: preview(parts.body),
    messageCount: 0,
    messagesHeld: 0,
  });
}

/**
 * Read down one newest-first stream of items until `wanted` rows SURVIVE — where
 * surviving is whatever the caller is really counting — or the stream runs out.
 *
 * A window of ROWS is not a window of what a page is made of, and the difference
 * is what makes a paged list hand back a row it has already given you. One thread
 * contributes a row per message it holds and a row per label view that listed it,
 * so the newest 5 rows may name only 3 threads — the two that were missed then
 * reappear when a later page reads further, and page 2 repeats a thread from page
 * 1. Measured on the Gmail recording before this loop existed: `limit 5` and
 * `limit 5, offset 5` shared one thread. Account-scoped search has the same shape
 * with a different survivor: the store's FTS query cannot filter by workspace, so
 * the other account's hits are read and dropped.
 *
 * Reading `wanted` survivors out of each stream is what makes the merge exact for
 * the whole page: a row in the true top-N has its highest-timestamped sighting at
 * rank ≤ N within its own stream, so no window that reaches N survivors can miss
 * it.
 */
function scanRows(
  read: (limit: number) => Item[],
  survivors: (rows: Item[]) => number,
  wanted: number,
): Item[] {
  let limit = Math.max(wanted, 1);
  for (;;) {
    const rows = read(limit);
    // Short of `wanted` only because the stream ended, or because the cap bit.
    if (survivors(rows) >= wanted || rows.length < limit || limit >= MAX_ROW_SCAN) return rows;
    limit = Math.min(limit * 2, MAX_ROW_SCAN);
  }
}

/** How many distinct threads a window of rows names. */
function distinctThreads(rows: Item[], threadOf: (item: Item) => string): number {
  return new Set(rows.map(threadOf)).size;
}

// ── The tools ────────────────────────────────────────────────────────────────────

const listLabels: AppMcpTool = {
  name: 'gmail_list_labels',
  description:
    "List the Gmail labels Sluice has captured. The ids are Gmail's internal ones — `^i` is the inbox, `^f` sent — and are what gmail_list_threads takes as its labelId. With more than one signed-in account each label appears once PER ACCOUNT: `id` is the bare Gmail id, `containerId` is that label inside one account, and `account` is whose mailbox it is. Pass account (an address, or a workspace id like `gmail:you@example.com`) to see one account's labels. `total` and `unread` are GMAIL's own counts for the label, not Sluice's — compare them against `held` to see how much of the label was actually captured. Reads the capture store; makes no network call.",
  inputSchema: { ...ACCOUNT_SCHEMA, ...PAGE_SCHEMA },
  run: async (args, ctx) => {
    const store = requireStore(ctx);
    const workspaceId = resolveAccount(store, str(args.account));
    const { limit, offset } = page(args);
    const addresses = new Map(gmailAccounts(store).map((w) => [w.id, w.domain ?? null]));
    const labels = store
      .listContainers(workspaceId)
      .flatMap((c) => {
        const ref = c.adapterId === ADAPTER_ID ? labelRef(c.id) : undefined;
        return ref === undefined ? [] : [{ container: c, labelId: ref.labelId }];
      });
    return {
      account: workspaceId ?? null,
      total: labels.length,
      offset,
      limit,
      labels: labels.slice(offset, offset + limit).map(({ container, labelId }) => ({
        id: labelId,
        containerId: container.id,
        name: container.name,
        workspaceId: container.workspaceId,
        account: addresses.get(container.workspaceId) ?? null,
        // Gmail's numbers and Sluice's, side by side and never conflated. A
        // local store is always a sample — the recorded Inbox reported 14,061
        // conversations against the 50 one thread-list response carried — so
        // `held` alone reads as a complete mailbox, and answering questions
        // about a mailbox from a fiftieth of it is the whole hazard here.
        total: container.itemCount ?? null,
        unread: container.unreadCount ?? null,
        held: store.listItems(container.id, { limit: MAX_ROW_SCAN }).length,
      })),
    };
  },
};

const listThreads: AppMcpTool = {
  name: 'gmail_list_threads',
  description:
    'List captured Gmail threads, newest first, with the subject and the sender of each. Pass labelId to scope to one label view — either the bare Gmail id (`^i`) or one account\'s view of it (`gmail:u0/^i`), both from gmail_list_labels; omit it to see every thread Sluice holds, including ones fetched directly. Pass account (a workspace id like `gmail:u0`, or the address) to stay inside one signed-in account. Walk further with offset. `messagesHeld` is how many messages Sluice actually has for the thread — call gmail_get_thread on a thread with at least one to read it. Reads the capture store; makes no network call.',
  inputSchema: { labelId: z.string().optional(), ...ACCOUNT_SCHEMA, ...PAGE_SCHEMA },
  run: async (args, ctx) => {
    const store = requireStore(ctx);
    const workspaceId = resolveAccount(store, str(args.account));
    const labelId = str(args.labelId);
    const { limit, offset } = page(args);
    // Both sources are read down to the end of the requested page rather than to
    // its start, since neither is sorted with respect to the other. One past it,
    // so "is there another page" is answerable without a second query.
    const wanted = offset + limit + 1;

    const threads = new Map<string, ThreadSummary>();
    // One stream per container, because a bare `^i` is a view in EVERY account and
    // the store filters by one container id at a time. `undefined` is the whole
    // mailbox, which is the no-label case and reads as one stream.
    const containerIds: Array<string | undefined> =
      labelId === undefined ? [undefined] : labelContainers(store, labelId, workspaceId);
    for (const containerId of containerIds) {
      for (const row of scanRows(
        (rowLimit) =>
          store.queryItems({
            adapterId: ADAPTER_ID,
            threaded: false,
            containerId,
            workspaceId,
            limit: rowLimit,
          }),
        (rows) => distinctThreads(rows, (item) => item.id),
        wanted,
      )) {
        foldThreadRow(threads, row);
      }
    }

    // Scoping to a label is scoping to what that label's VIEW listed, and only a
    // `bv` response records membership at thread grain. A directly-fetched
    // message carries its labels as `in-label` edges, one per message — folding
    // those in here would answer a different question with the same name.
    if (labelId === undefined) {
      for (const message of scanRows(
        (rowLimit) =>
          store.queryItems({ adapterId: ADAPTER_ID, threaded: true, workspaceId, limit: rowLimit }),
        (rows) => distinctThreads(rows, (item) => item.threadId ?? item.containerId),
        wanted,
      )) {
        foldMessage(threads, message);
      }
    }

    const ordered = [...threads.values()].sort((a, b) => b.ts - a.ts);
    const pageOf = ordered.slice(offset, offset + limit);
    // Counted only for the page, so the cost is bounded by `limit` however large
    // the mailbox is.
    for (const thread of pageOf) {
      thread.messagesHeld = store.countItems({
        adapterId: ADAPTER_ID,
        containerId: thread.threadId,
      });
      if (thread.messageCount === 0) thread.messageCount = thread.messagesHeld;
    }

    return {
      labelId: labelId ?? null,
      account: workspaceId ?? null,
      offset,
      limit,
      count: pageOf.length,
      // The scan read one thread past the page precisely so this is a fact rather
      // than an inference from a row count.
      hasMore: ordered.length > offset + limit,
      threads: pageOf,
    };
  },
};

/**
 * There is no `account` parameter here, unlike every other tool, and that is a
 * property of the id rather than an omission.
 *
 * A thread id is minted per mailbox — `thread-f:2942556809216331240` — and is
 * what BOTH parsers use as the container a message lives in, unscoped, because
 * two accounts never mint the same one. So `listItems(threadId)` already selects
 * exactly one account's conversation: an account filter could only ever be a
 * no-op or a way to get an empty answer for a thread that exists. The label ids
 * around it are the opposite case — `^i` is every account's inbox — which is why
 * those are scoped and this is not. The `workspaceId` in the answer says which
 * account it turned out to be.
 */
const getThread: AppMcpTool = {
  name: 'gmail_get_thread',
  description:
    'Read one Gmail thread in full: every message Sluice holds for it, oldest first, with from, to, cc, date, subject and body. This is what "read my email" needs — gmail_list_threads only previews. Pass a threadId from gmail_list_threads or gmail_search; a thread id names one account\'s conversation on its own, so there is no account to pass. Reads the capture store; makes no network call.',
  inputSchema: { threadId: z.string().min(1) },
  run: async (args, ctx) => {
    const store = requireStore(ctx);
    const threadId = str(args.threadId);
    if (threadId === undefined) throw new Error('gmail_get_thread needs a threadId.');

    // Oldest-first, which is how a conversation reads. `listItems` is newest-first
    // because that is what a feed wants.
    const held = store
      .listItems(threadId, { limit: MAX_THREAD_MESSAGES })
      .sort((a, b) => a.ts - b.ts);

    const messages = held.map((item) => {
      const view = gmailMessageView(item.raw);
      const parts = messageParts(item);
      return {
        id: item.id,
        ts: item.ts,
        date: isoOf(item.ts),
        subject: parts.subject,
        from: parts.from,
        to: view.to,
        cc: view.cc,
        body: parts.body,
        // In Gmail a label is a property of a MESSAGE, not a folder the thread
        // was moved into, so this is per-message and the edges table is the only
        // place it is recorded.
        labels: store
          .listEdges({ srcKind: 'item', srcId: item.id, rel: 'in-label' })
          .map((e) => e.dstId),
      };
    });

    // The thread row from a batch view, if one listed it. It is what makes an
    // unfetched thread answerable at all: without it the tool would say "no
    // messages" about a thread whose subject and snippet the store is holding.
    const listed = store.queryItems({
      adapterId: ADAPTER_ID,
      threaded: false,
      id: threadId,
      limit: 1,
    })[0];
    const listedView = listed === undefined ? undefined : gmailThreadView(listed.raw);

    const subject =
      messages.find((m) => m.subject.length > 0)?.subject ?? listedView?.subject ?? '';
    return {
      threadId,
      subject,
      messageCount: listedView?.messageCount ?? messages.length,
      messagesHeld: messages.length,
      // Which account this turned out to be. Not an input — see the note above
      // this tool — but with two mailboxes in one store a reader still has to be
      // told whose mail it is holding.
      workspaceId: held[0]?.workspaceId ?? listed?.workspaceId ?? null,
      snippet: listed === undefined ? null : preview(listed.text),
      note:
        messages.length === 0
          ? 'Sluice has not captured this thread\'s messages. Open the thread in Gmail with capture running, or replay the "gmail.threads.list" action, then call this again.'
          : undefined,
      messages,
    };
  },
};

const search: AppMcpTool = {
  name: 'gmail_search',
  description:
    'Full-text search the captured mailbox — message BODIES as well as thread snippets — newest first, returning the subject, the sender and a preview of each hit. Words are stemmed, so "run" matches "running", and a trailing * is a prefix match. Pass account (a workspace id like `gmail:u0`, or the address) to search one signed-in account rather than every captured mailbox at once. Walk further with offset; follow a hit with gmail_get_thread. Reads the capture store; makes no network call.',
  inputSchema: { query: z.string().min(1), ...ACCOUNT_SCHEMA, ...PAGE_SCHEMA },
  run: async (args, ctx) => {
    const store = requireStore(ctx);
    const workspaceId = resolveAccount(store, str(args.account));
    const query = str(args.query);
    if (query === undefined) throw new Error('gmail_search needs a query.');
    const { limit, offset } = page(args);

    // The FTS index, not a LIKE scan, and the adapter scope goes INTO the query so
    // the limit is spent on mail rather than on whatever else was captured.
    //
    // The ACCOUNT scope cannot go in with it: `ItemSearchQuery` has no workspace
    // field, because an FTS match is a rowid set the store then joins — so a
    // scoped search reads down the ranked hits and drops the other accounts',
    // exactly as the thread list reads down its two streams. Unscoped search
    // keeps the `limit`/`offset` the store can apply itself.
    // Fetch one extra row so hasMore matches gmail_list_threads (exact page
    // boundary, not "page looked full").
    const wanted = offset + limit + 1;
    const matched =
      workspaceId === undefined
        ? store.searchItems(query, { adapterId: ADAPTER_ID, limit: wanted, offset: 0 }).slice(offset)
        : scanRows(
            (rowLimit) => store.searchItems(query, { adapterId: ADAPTER_ID, limit: rowLimit }),
            (rows) => rows.filter((i) => i.workspaceId === workspaceId).length,
            wanted,
          )
            .filter((i) => i.workspaceId === workspaceId)
            .slice(offset);

    const hasMore = matched.length > limit;
    const pageRows = matched.slice(0, limit);

    const hits = pageRows.map((item) => {
      // A message sets `threadId` and a batch-view thread row does not — the
      // same distinction `gmail_sync_status` counts by. They are told apart
      // because their `raw` records have entirely different layouts.
      const isMessage = item.threadId !== undefined;
      const view = isMessage ? undefined : gmailThreadView(item.raw);
      const parts = isMessage ? messageParts(item) : undefined;
      return {
        id: item.id,
        kind: isMessage ? 'message' : 'thread',
        threadId: item.threadId ?? item.id,
        ts: item.ts,
        date: isoOf(item.ts),
        subject: parts?.subject ?? view?.subject ?? '',
        from: parts?.from ?? view?.from ?? null,
        snippet: preview(parts?.body ?? item.text),
      };
    });

    return {
      query,
      account: workspaceId ?? null,
      offset,
      limit,
      count: hits.length,
      hasMore,
      hits,
    };
  },
};

/**
 * How much of ONE account is in the store.
 *
 * The counts are per-workspace and not a share of a total, because with two
 * mailboxes captured the merged number answers a question nobody asked: "1,400
 * threads" across two accounts tells a caller nothing about whether the one it
 * cares about has been captured at all. It is also how a caller DISCOVERS which
 * accounts exist — there is no other tool that lists them.
 */
function accountCoverage(store: ReadOnlyStore, workspace: Workspace) {
  const containers = store
    .listContainers(workspace.id)
    .filter((c) => c.adapterId === ADAPTER_ID)
    .map((c) => containerKind(c.id));
  const messages = store.countItems({
    adapterId: ADAPTER_ID,
    workspaceId: workspace.id,
    threaded: true,
  });
  return {
    id: workspace.id,
    name: workspace.name,
    // The address IS the id for an identified mailbox, so this repeats it rather
    // than adding a second spelling that could disagree with the first.
    address: workspace.domain ?? null,
    // A row that names a `/u/N/` SLOT and not a mailbox. It holds real mail — the
    // thread lists that no message fetch was recorded near — and it is nobody's
    // account, so it must not be read as one. Reconciliation empties these; one
    // that survives means the capture straddled an account switch, or that the
    // session never opened a message.
    identified: !isProvisionalWorkspaceId(workspace.id),
    labels: containers.filter((k) => k === 'label').length,
    threads: store.countItems({
      adapterId: ADAPTER_ID,
      workspaceId: workspace.id,
      threaded: false,
    }),
    fetchedThreads: containers.filter((k) => k === 'thread').length,
    messages,
    bodiesPresent: messages > 0,
  };
}

const syncStatus: AppMcpTool = {
  name: 'gmail_sync_status',
  description:
    'Report the coverage of the captured mailbox: which Gmail accounts are in the store and, FOR EACH, its address and how many labels, threads and individual messages were captured — plus the totals and when the newest Gmail capture landed. Worth calling first — these tools answer from a snapshot, how old and how complete that snapshot is changes what an empty result means, and the `accounts` list is where the ids and addresses the other tools take as `account` come from.',
  inputSchema: {},
  run: async (_args, ctx) => {
    const store = requireStore(ctx);
    const kinds = store
      .listContainers()
      .filter((c) => c.adapterId === ADAPTER_ID)
      .map((c) => containerKind(c.id));
    // Threads and messages are both Items and are told apart by `threadId`: the
    // batch view emits one item per thread and sets none, the thread fetcher emits
    // one per message and sets the thread it is in. Counting them together reports
    // a mailbox with more conversations than it has.
    const threads = store.countItems({ adapterId: ADAPTER_ID, threaded: false });
    const messages = store.countItems({ adapterId: ADAPTER_ID, threaded: true });
    const newestCaptureTs = store.newestCaptureTs({ adapterId: ADAPTER_ID });
    return {
      adapterId: ADAPTER_ID,
      accounts: gmailAccounts(store).map((w) => accountCoverage(store, w)),
      // The totals stay alongside the per-account rows: "how much mail is in this
      // store" is still a question, and it is the one a single-account user is
      // actually asking.
      labels: kinds.filter((k) => k === 'label').length,
      threads,
      // Threads whose messages were fetched. Not a subset of `threads`: a thread
      // opened from a view Sluice never captured has messages and no batch-view
      // row, which is why the two numbers are reported rather than one. The
      // "label not recovered" bucket is neither, and is counted as neither.
      fetchedThreads: kinds.filter((k) => k === 'thread').length,
      messages,
      // A message item exists only because the thread fetcher parsed one, and that
      // is the only place a body comes from — so this tells a snippet-only store
      // (batch views alone) from a fully-parsed one without reading any mail.
      bodiesPresent: messages > 0,
      // Captures are NOT split per account. A capture is raw traffic and carries
      // no workspace — attribution happens in the parser — so the only way to
      // divide these would be to re-read every path, which is a different fact
      // (how many calls) than the per-account ones (how much mail).
      captures: store.countCaptures({ adapterId: ADAPTER_ID }),
      newestCaptureTs,
      newestCaptureAt: isoOf(newestCaptureTs),
    };
  },
};

/** Every MCP tool the Gmail app contributes, in the order a reader meets them. */
export const gmailMcpTools: AppMcpTool[] = [
  syncStatus,
  listLabels,
  listThreads,
  getThread,
  search,
];
