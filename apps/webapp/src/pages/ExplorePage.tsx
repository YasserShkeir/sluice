// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The captured data, read as data rather than as traffic.
 *
 * The traffic table answers "what did this app call?"; this answers "what is in
 * my account?" — the same captures, normalized into workspaces, containers and
 * items, which until now the runner streamed and the client threw away.
 *
 * Three panes, left to right: the tree, one container's items, one item's text.
 * Resizable, because which pane matters depends entirely on what you are doing —
 * scanning a label list, scanning a thread list, or reading one message.
 *
 * ## Where the data comes from, and why it is split
 *
 * Workspaces and containers are fetched whole. There are tens to hundreds of
 * them, they are what the tree renders, and a tree that pages is a tree nobody
 * can navigate.
 *
 * Items are paged, always. Gmail's Inbox reported 14,061 conversations in the
 * recording this was built against — pulling that into a browser to render fifty
 * rows is how a local tool starts feeling like a remote one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Container, Item, Workspace } from '@sluice/core';
import { fetchContainers, fetchItems, fetchWorkspaces } from '../api.js';
import type { ItemPage } from '../api.js';
import { navigate } from '../router.js';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '../ui/resizable.js';

/** How many items one page pulls. Comfortably more than a screen holds. */
const PAGE = 100;

/**
 * How many messages one thread will show. A ceiling, not a page: a conversation
 * is a unit a reader wants whole. The longest in the Gmail recording is 12.
 */
const MAX_THREAD = 500;

/** Row height for the virtualized lists, in px. Must match the row's own class. */
const TREE_ROW = 26;
const ITEM_ROW = 52;

interface Props {
  /** From the URL, so a container view is a real link rather than a mode. */
  containerId?: string;
}

export function ExplorePage({ containerId }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([fetchWorkspaces(), fetchContainers()])
      .then(([w, c]) => {
        if (!live) return;
        setWorkspaces(w.workspaces);
        setContainers(c.containers);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  // The container the URL names, or nothing. Resolved against what was loaded
  // rather than trusted: a stale link, or one typed by hand, names a container
  // that may not exist in this store.
  const selected = useMemo(
    () => containers.find((c) => c.id === containerId),
    [containers, containerId],
  );

  // Selecting a different container invalidates the open item — it belonged to
  // the previous one, and leaving it on screen reads as an item of this one.
  useEffect(() => setSelectedItem(null), [containerId]);

  const rows = useMemo(
    () => treeRows(workspaces, containers, collapsed),
    [workspaces, containers, collapsed],
  );

  const toggle = useCallback((workspaceId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(workspaceId)) next.add(workspaceId);
      return next;
    });
  }, []);

  if (error !== null) {
    return <p className="p-4 text-sm text-danger">Could not read the store — {error}</p>;
  }

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="26" minSize="14">
        <Tree rows={rows} selectedId={containerId} onToggle={toggle} />
      </ResizablePanel>
      <ResizableHandle orientation="horizontal" />
      <ResizablePanel defaultSize="37" minSize="20">
        <ItemList container={selected} selected={selectedItem} onSelect={setSelectedItem} />
      </ResizablePanel>
      <ResizableHandle orientation="horizontal" />
      <ResizablePanel defaultSize="37" minSize="18">
        <Reader item={selectedItem} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// ── The tree ─────────────────────────────────────────────────────────────────────

export type TreeRow =
  | { kind: 'workspace'; id: string; label: string; detail: string; collapsed: boolean }
  | { kind: 'container'; id: string; label: string; detail: string };

/**
 * The tree, flattened.
 *
 * A flat array rather than nested JSX because it is virtualized, and a
 * virtualizer needs a row COUNT before it can render anything. Collapsing is
 * therefore filtering: a collapsed workspace's containers are simply not in the
 * array, which is also what makes the arrow-key walk over it correct for free.
 */
export function treeRows(
  workspaces: Workspace[],
  containers: Container[],
  collapsed: Set<string>,
): TreeRow[] {
  const byWorkspace = new Map<string, Container[]>();
  for (const c of containers) {
    byWorkspace.set(c.workspaceId, [...(byWorkspace.get(c.workspaceId) ?? []), c]);
  }
  const rows: TreeRow[] = [];
  for (const w of workspaces) {
    const own = byWorkspace.get(w.id) ?? [];
    // Threads are not places. There is one per conversation, so listing them
    // here buries the structure: the recorded mailbox had 24 labels among 94
    // threads, interleaved alphabetically. They are reached by opening the label
    // that holds them, which is how they are reached in the app they came from.
    const places = own.filter((c) => c.kind !== 'thread');
    const isCollapsed = collapsed.has(w.id);
    rows.push({
      kind: 'workspace',
      id: w.id,
      label: w.name,
      detail: `${places.length}`,
      collapsed: isCollapsed,
    });
    if (isCollapsed) continue;
    for (const c of places) {
      rows.push({ kind: 'container', id: c.id, label: c.name, detail: coverage(c) });
    }
  }
  return rows;
}

/**
 * What the SERVICE says this container holds, against nothing.
 *
 * Deliberately not "captured / total" — the captured number is a store query per
 * row and this renders hundreds of rows. The service's own count is the number
 * that is not otherwise anywhere on screen, and the item list shows the captured
 * count for the one container actually open.
 */
export function coverage(c: Container): string {
  if (c.itemCount === undefined) return '';
  return c.unreadCount ? `${c.unreadCount} / ${c.itemCount}` : String(c.itemCount);
}

function Tree({
  rows,
  selectedId,
  onToggle,
}: {
  rows: TreeRow[];
  selectedId?: string;
  onToggle: (workspaceId: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => TREE_ROW,
    overscan: 12,
  });

  if (rows.length === 0) {
    return (
      <Empty>
        Nothing normalized yet. Capture some traffic from an app with an adapter, or run{' '}
        <code>sluice sync</code>.
      </Empty>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      {/* Divs with tree roles rather than a list: a virtualizer positions rows
          absolutely, which list layout will not tolerate. The same trade the
          traffic table makes for `role="grid"`. */}
      <div
        role="tree"
        aria-label="Captured workspaces and containers"
        style={{ height: virt.getTotalSize(), position: 'relative' }}
      >
        {virt.getVirtualItems().map((v) => {
          const row = rows[v.index];
          if (row === undefined) return null;
          const selected = row.kind === 'container' && row.id === selectedId;
          return (
            <div
              key={row.id}
              role="treeitem"
              aria-selected={selected}
              aria-level={row.kind === 'workspace' ? 1 : 2}
              aria-expanded={row.kind === 'workspace' ? !row.collapsed : undefined}
              tabIndex={-1}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: v.size,
                transform: `translateY(${v.start}px)`,
              }}
            >
              <button
                type="button"
                onClick={() =>
                  row.kind === 'workspace'
                    ? onToggle(row.id)
                    : navigate({ name: 'explore', containerId: row.id })
                }
                title={row.label}
                className={[
                  'flex h-full w-full items-center gap-1.5 px-2 text-left text-[12px]',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                  row.kind === 'workspace'
                    ? 'font-medium text-fg hover:bg-bg-3'
                    : 'pl-6 text-fg-dim hover:bg-bg-3 hover:text-fg',
                  selected ? 'bg-accent-dim text-fg' : '',
                ].join(' ')}
              >
                {row.kind === 'workspace' ? (
                  <span className="w-3 shrink-0 text-fg-mute">{row.collapsed ? '▸' : '▾'}</span>
                ) : null}
                <span className="truncate">{row.label}</span>
                {row.detail ? (
                  <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-fg-mute">
                    {row.detail}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── The item list ────────────────────────────────────────────────────────────────

function ItemList({
  container,
  selected,
  onSelect,
}: {
  container?: Container;
  selected: Item | null;
  onSelect: (item: Item) => void;
}) {
  const [page, setPage] = useState<ItemPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = container?.id;

  useEffect(() => {
    if (id === undefined) {
      setPage(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    fetchItems(id, PAGE, 0)
      .then((p) => live && setPage(p))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id]);

  const more = useCallback(() => {
    if (id === undefined || page === null || loading) return;
    setLoading(true);
    fetchItems(id, PAGE, page.items.length)
      .then((next) =>
        // Appended, and the offset comes from what is HELD rather than from a
        // page counter. A capture landing between two pages shifts every row
        // down by one, and a counter would then skip exactly that many.
        setPage((cur) => (cur === null ? next : { ...next, items: [...cur.items, ...next.items] })),
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id, page, loading]);

  const parentRef = useRef<HTMLDivElement>(null);
  const items = page?.items ?? [];
  const virt = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ITEM_ROW,
    overscan: 8,
  });

  if (container === undefined) return <Empty>Pick a container on the left.</Empty>;
  if (error !== null) return <Empty tone="danger">Could not read items — {error}</Empty>;

  return (
    <div className="flex h-full flex-col">
      <Header
        title={container.name}
        detail={
          page === null
            ? '…'
            : // Held against reported, side by side and never conflated. A store
              // is always a sample, and "50 messages" reads as a complete
              // container until the number it is a sample OF is next to it.
              `${page.total} captured${
                container.itemCount === undefined ? '' : ` of ${container.itemCount} reported`
              }`
        }
      />
      {items.length === 0 && !loading ? (
        <Empty>No items captured for this container yet.</Empty>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-auto">
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((v) => {
              const item = items[v.index];
              if (item === undefined) return null;
              return (
                <div
                  key={`${item.containerId} ${item.id}`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: v.size,
                    transform: `translateY(${v.start}px)`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(item)}
                    className={[
                      'flex h-full w-full flex-col justify-center gap-0.5 border-b border-border px-2.5 text-left',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                      selected?.id === item.id && selected.containerId === item.containerId
                        ? 'bg-accent-dim'
                        : 'hover:bg-bg-3',
                    ].join(' ')}
                  >
                    <span className="truncate text-[12px] text-fg">{firstLine(item.text) || item.id}</span>
                    <span className="truncate text-[11px] text-fg-mute">
                      {item.ts > 0 ? new Date(item.ts).toLocaleString() : 'no timestamp'}
                      {item.authorId ? ` · ${bareHandle(item.authorId)}` : ''}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {page !== null && items.length < page.total ? (
        <button
          type="button"
          onClick={more}
          disabled={loading}
          className="shrink-0 border-t border-border px-2 py-1.5 text-[12px] text-fg-dim hover:bg-bg-3 hover:text-fg disabled:opacity-50"
        >
          {loading ? 'Loading…' : `Load ${Math.min(PAGE, page.total - items.length)} more`}
        </button>
      ) : null}
    </div>
  );
}

// ── The reader ───────────────────────────────────────────────────────────────────

/**
 * One item, and the conversation behind it when there is one.
 *
 * A thread-list row and a message are both Items, and they are not the same
 * thing: a row from a label view carries a snippet and IS a whole conversation,
 * while a row from a message fetch carries a body and is one message in one. The
 * link between them is that a thread row's `id` is the id of the CONTAINER its
 * messages were filed under — so a row with no `threadId` of its own is a thread
 * head, and its messages are one fetch away.
 *
 * Without this the two halves of a mailbox never meet: the labels list threads
 * that have no bodies, and the bodies sit in containers the tree deliberately
 * does not show.
 */
function Reader({ item }: { item: Item | null }) {
  const [raw, setRaw] = useState(false);
  const [thread, setThread] = useState<Item[] | null>(null);
  // A thread head, not a message: `threadId` is set on messages and only on
  // messages, by every adapter that threads at all.
  const headId = item !== null && item.threadId === undefined ? item.id : undefined;

  useEffect(() => {
    if (headId === undefined) {
      setThread(null);
      return;
    }
    let live = true;
    fetchItems(headId, MAX_THREAD, 0)
      .then((p) => live && setThread(p.items))
      // A thread nobody fetched is the common case, not an error — the reader
      // falls back to the snippet the list row already carries.
      .catch(() => live && setThread(null));
    return () => {
      live = false;
    };
  }, [headId]);

  if (item === null) return <Empty>Pick an item to read it.</Empty>;

  // Oldest first: a conversation reads in the order it happened, which is the
  // reverse of the newest-first order every list uses.
  const messages = thread !== null && thread.length > 0 ? [...thread].reverse() : [item];

  return (
    <div className="flex h-full flex-col">
      <Header
        title={firstLine(item.text) || item.id}
        detail={
          messages.length > 1
            ? `${messages.length} messages`
            : item.ts > 0
              ? new Date(item.ts).toLocaleString()
              : ''
        }
        action={
          <button
            type="button"
            onClick={() => setRaw((r) => !r)}
            className="rounded px-1.5 py-0.5 text-[11px] text-fg-dim hover:bg-bg-3 hover:text-fg"
          >
            {raw ? 'Text' : 'Raw'}
          </button>
        }
      />
      <div className="flex-1 overflow-auto p-3">
        {messages.map((m, i) => (
          <article key={`${m.containerId} ${m.id}`} className={i > 0 ? 'mt-4 border-t border-border pt-4' : ''}>
            {messages.length > 1 ? (
              <div className="mb-1.5 flex items-baseline gap-2 text-[11px] text-fg-mute">
                <span className="text-fg-dim">{m.authorId ? bareHandle(m.authorId) : 'unknown sender'}</span>
                <span>{m.ts > 0 ? new Date(m.ts).toLocaleString() : ''}</span>
              </div>
            ) : null}
            {/* Plain text, never HTML. These bodies come off the wire from a
                service that did not have this page in mind, and an item's text
                is exactly the kind of attacker-reachable string that must not be
                interpreted — the adapters already flatten HTML to text before it
                gets here. */}
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-fg-dim">
              {raw ? JSON.stringify(m.raw, null, 2) : m.text}
            </pre>
          </article>
        ))}
      </div>
    </div>
  );
}

// ── Small shared pieces ──────────────────────────────────────────────────────────

function Header({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-2.5 py-1.5">
      <span className="truncate text-[12.5px] font-medium text-fg" title={title}>
        {title}
      </span>
      {detail ? <span className="shrink-0 text-[11px] text-fg-mute">{detail}</span> : null}
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
    </div>
  );
}

function Empty({ children, tone }: { children: React.ReactNode; tone?: 'danger' }) {
  return (
    <p className={`p-4 text-[12px] ${tone === 'danger' ? 'text-danger' : 'text-fg-mute'}`}>{children}</p>
  );
}

/** The first non-empty line — an item's text is `subject\n\nbody` for mail. */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length > 0) return t.length > 160 ? `${t.slice(0, 160)}…` : t;
  }
  return '';
}

/**
 * An actor id read back as something a person recognises.
 *
 * Actor ids are scoped by workspace (`gmail:you@example.com/alice@example.com`),
 * which is right for a primary key and wrong for a byline. The scope is already
 * implied by the container being looked at.
 */
export function bareHandle(actorId: string): string {
  const slash = actorId.lastIndexOf('/');
  return slash === -1 ? actorId : actorId.slice(slash + 1);
}
