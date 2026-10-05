// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * All-traffic dashboard (Wireshark / Charles style): a toolbar over one dense,
 * monospace grid of every captured request.
 *
 * FILTERING is the `../filter.js` language; the menus only APPEND terms, so the
 * text box is the single source of truth. ROWS are virtualized in a `role="grid"`
 * of divs, not a `<table>`: virtualized rows need absolute positioning, which
 * table layout rejects. `body:` terms go to the SERVER: the client holds only a
 * bounded window, and answering them locally would silently answer a narrower
 * question.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { VirtualItem } from '@tanstack/react-virtual';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { Capture } from '@sluice/core';
import type { ConnectionState } from '../ws.js';
import { captureToggleAction, distinctValues, sendCaptureControl, sendSync } from '../ws.js';
import { appOf } from '../analytics.js';
import { fetchCaptureBody, fetchCapturesByIds, fetchFlows, searchCaptureBodies } from '../api.js';
import type { FlowSummary } from '../api.js';
import { toggled } from '../collections.js';
import { captureSize, errorMessage, formatClock, formatDuration, toCurl } from '../format.js';
import { Badge, statusTone } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { EMPTY_QUERY, matchesFilter, parseFilter, serverSideTerms } from '../filter.js';
import type { FilterQuery } from '../filter.js';
import { buildFlowGroupedRows, primaryMembership, indexFlowsByCapture } from '../flow-ui.js';
import type { CaptureFlowMembership, FlowDisplayRow } from '../flow-ui.js';

/** Cap the visible grid; the runner's SQLite store keeps the full history. */
const MAX_ROWS = 8000;

/** Row height in px. MUST match `--spacing-row` in styles.css — the virtualizer
 * positions rows by arithmetic, so a disagreement makes rows drift from their
 * own scroll offsets rather than merely looking wrong. */
const ROW_H = 26;

/**
 * A readable name for a tab: its origin plus a short id suffix, since several
 * tabs are often on the same origin (two Slack workspaces, say) and the raw CDP
 * target id is a 32-char hex string nobody can tell apart at a glance.
 */
function tabLabel(tabId: string, tabUrl: string | null | undefined): string {
  const short = tabId.slice(0, 6);
  if (!tabUrl) return `tab ${short}`;
  try {
    const u = new URL(tabUrl);
    return `${u.hostname}${u.pathname !== '/' ? u.pathname : ''} · ${short}`;
  } catch {
    return `${tabUrl.slice(0, 40)} · ${short}`;
  }
}

/** Column headers, named once so the header row and aria-colcount agree. */
const COLUMNS = [
  '#',
  'Time',
  'App',
  'Source',
  'Method',
  'Operation',
  'Host',
  'Path',
  'Status',
  'Size',
  'Duration',
] as const;

/** Column widths, in one place so the header and the rows cannot disagree. */
const GRID_COLS =
  '48px 92px 70px 60px 74px minmax(150px,1fr) minmax(120px,1fr) minmax(140px,2fr) 62px 72px 72px';

interface Props {
  /** oldest → newest, straight from the store */
  captures: Capture[];
  /** Only to disable Sync while the socket is down. */
  connection: ConnectionState;
  selectedId: string | null;
  onSelect: (c: Capture | null) => void;
  /** Whether the RUNNER is writing captures (server state, see ws.ts). */
  capturePaused: boolean;
  /** monotonic id of the last notice — bumps to clear the Sync button's "syncing…" */
  noticeId: number;
  /** Launcher app id, or '' for all. Applied by rewriting the query's `app:` term
   *  so the launcher and the filter box stay one source of truth. */
  appFilter?: string;
}

export function TrafficDashboard({
  captures,
  connection,
  selectedId,
  onSelect,
  noticeId,
  appFilter,
  capturePaused,
}: Props) {
  // Local ingest gate, separate from the server's. Pausing does both; this one
  // also freezes the visible list so the rows under your cursor stop moving.
  const [recording, setRecording] = useState(true);
  const [queryText, setQueryText] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [follow, setFollow] = useState(true);
  const [version, setVersion] = useState(0);
  /** Ids the user marked. Wireshark's oldest feature and still its most used:
   *  a place to put "this is the one" while you keep scrolling past it. */
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => new Set());
  const [multi, setMulti] = useState<ReadonlySet<string>>(() => new Set());
  /** Capture ids the server matched for the query's `body:` terms; null = no
   *  body term in play, which is different from "searched and found nothing". */
  const [bodyHits, setBodyHits] = useState<ReadonlySet<string> | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** Collapse companions under observed/pinned interaction flows. */
  const [groupByFlow, setGroupByFlow] = useState(false);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [flowsError, setFlowsError] = useState<string | null>(null);
  const [expandedFlows, setExpandedFlows] = useState<ReadonlySet<string>>(() => new Set());

  const listRef = useRef<Capture[]>([]);
  const indexRef = useRef<Map<string, number>>(new Map());
  const seqRef = useRef<Map<string, number>>(new Map());
  const seqCounter = useRef(0);
  /** Captures pulled for Group-flows that are not in the live ring. Kept off listRef
   *  so hydration invents no seqs and does not churn version / re-fetch flows. */
  const flowHydrateRef = useRef<Map<string, Capture>>(new Map());
  // Ids present at the last Clear — skipped so a Clear taken while recording doesn't
  // immediately re-ingest everything still in the store's live window.
  const ignoredRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Rows that arrived while the user was scrolled away — the ↓ N new pill. */
  const [unseen, setUnseen] = useState(0);
  const lastAnchor = useRef<string | null>(null);

  // Selecting an app in the launcher rewrites the `app:` term rather than
  // filtering separately, so the box always shows the whole truth.
  useEffect(() => {
    if (appFilter === undefined) return;
    setQueryText((text) => {
      const rest = text
        .split(/\s+/)
        .filter((t) => t.length > 0 && !/^-?app:/i.test(t))
        .join(' ');
      const next = appFilter ? `app:${appFilter}${rest ? ` ${rest}` : ''}` : rest;
      return next === text ? text : next;
    });
  }, [appFilter]);

  const query: FilterQuery = useMemo(() => (queryText ? parseFilter(queryText) : EMPTY_QUERY), [queryText]);

  // ── Ingest: append newly-arrived captures while recording (idempotent) ────────
  useLayoutEffect(() => {
    if (!recording) return;
    const list = listRef.current;
    const index = indexRef.current;
    const ignored = ignoredRef.current;
    let added = 0;
    let changed = false;

    for (const c of captures) {
      if (ignored.has(c.id)) continue;
      const idx = index.get(c.id);
      if (idx === undefined) {
        index.set(c.id, list.length);
        seqCounter.current += 1;
        seqRef.current.set(c.id, seqCounter.current);
        list.push(c);
        added += 1;
        changed = true;
      } else if (list[idx] !== c) {
        // Same request seen again with fresh data (e.g. response filled in).
        list[idx] = c;
        changed = true;
      }
    }

    if (!changed) return;

    const over = list.length - MAX_ROWS;
    if (over > 0) {
      const removed = list.splice(0, over);
      for (const r of removed) seqRef.current.delete(r.id);
      index.clear();
      for (let i = 0; i < list.length; i++) index.set(list[i]?.id ?? '', i);
    }
    if (added > 0 && !follow) setUnseen((n) => n + added);
    setVersion((v) => v + 1);
  }, [captures, recording, follow]);

  /** Drop every buffered row and the per-row state hanging off it. */
  function resetBuffers(): void {
    listRef.current = [];
    indexRef.current = new Map();
    seqRef.current = new Map();
    seqCounter.current = 0;
    flowHydrateRef.current.clear();
    setMarks(new Set());
    setMulti(new Set());
    setUnseen(0);
    setVersion((v) => v + 1);
    onSelect(null);
  }

  // Wipe (and any full server clear) empties the ws capture ring. listRef is a
  // separate live buffer — drop it too so the dashboard cannot keep deleted rows.
  useEffect(() => {
    if (captures.length > 0) return;
    if (listRef.current.length === 0) return;
    resetBuffers();
  }, [captures, onSelect]);

  // ── Body search: the one predicate the client cannot answer from its window ───
  const bodyQueries = useMemo(
    () => serverSideTerms(query).map((t) => t.value).join(' '),
    [query],
  );
  useEffect(() => {
    if (bodyQueries.length === 0) {
      setBodyHits(null);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    // Debounced: this is a keystroke-driven FTS query against SQLite, and firing
    // one per character would queue work the user has already typed past.
    const timer = setTimeout(() => {
      searchCaptureBodies(bodyQueries, { limit: MAX_ROWS })
        .then((r) => {
          if (cancelled) return;
          setBodyHits(new Set(r.captures.map((c) => c.id)));
          setSearchError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          // Surface it rather than falling back to a local scan: a local scan
          // would answer a narrower question and look like a complete answer.
          setSearchError(errorMessage(e));
          setBodyHits(new Set());
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bodyQueries]);

  // ── Flow index for F7 grouping (only while the toggle is on) ─────────────────
  useEffect(() => {
    if (!groupByFlow) {
      flowHydrateRef.current.clear();
      return;
    }
    let cancelled = false;
    const load = () => {
      fetchFlows({ limit: 200, app: appFilter || undefined })
        .then((r) => {
          if (cancelled) return;
          setFlows((prev) => (flowsListUnchanged(prev, r.flows) ? prev : r.flows));
          setFlowsError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setFlowsError(errorMessage(e));
          setFlows([]);
        });
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // Intentionally omit `version` — live ingest must not storm GET /api/flows.
  }, [groupByFlow, appFilter]);

  // Pull flow step captures that fell out of the live WS ring so Group flows
  // shows full bursts, not only members still in the client window.
  useEffect(() => {
    if (!groupByFlow || flows.length === 0) return;
    let cancelled = false;
    // indexRef's keys are exactly listRef's ids (kept together by ingest, trim,
    // clear and wipe), so it answers "already held?" without a scan.
    const missing: string[] = [];
    for (const f of flows) {
      for (const s of f.steps ?? []) {
        if (s.captureId && !indexRef.current.has(s.captureId) && !flowHydrateRef.current.has(s.captureId)) {
          missing.push(s.captureId);
        }
      }
    }
    const unique = [...new Set(missing)].slice(0, 500);
    if (unique.length === 0) return;
    fetchCapturesByIds(unique)
      .then((r) => {
        if (cancelled || r.captures.length === 0) return;
        let changed = false;
        for (const c of r.captures) {
          if (indexRef.current.has(c.id)) continue;
          if (flowHydrateRef.current.has(c.id)) continue;
          flowHydrateRef.current.set(c.id, c);
          changed = true;
        }
        // Recompute grouped rows without treating hydrate as live ingest.
        if (changed) setVersion((v) => v + 1);
      })
      .catch(() => {
        /* hydrate is best-effort; grouping still works with the live ring */
      });
    return () => {
      cancelled = true;
    };
    // Do not depend on `version` — that re-triggered hydrate on every ingest frame.
  }, [groupByFlow, flows]);

  // ── Filter-menu options: distinct values across everything ingested ───────────
  const options = useMemo(
    () => ({
      apps: distinctValues(listRef.current, appOf),
      sources: distinctValues(listRef.current, (c) => c.source),
      hosts: distinctValues(listRef.current, (c) => c.host),
      methods: distinctValues(listRef.current, (c) => c.method),
      ops: distinctValues(listRef.current, (c) => c.classification ?? ''),
      // Tabs only exist for CDP captures; the entry is absent for everything else,
      // so the menu simply doesn't appear when nothing is tab-attributed.
      tabs: (() => {
        const seen = new Map<string, string>();
        for (const c of listRef.current) {
          if (!c.tabId || seen.has(c.tabId)) continue;
          seen.set(c.tabId, tabLabel(c.tabId, c.tabUrl));
        }
        return seen;
      })(),
    }),
    [version],
  );

  // ── Derived rows: newest last, every term AND-combined ────────────────────────
  const filteredCaptures = useMemo(() => {
    const pool =
      groupByFlow && flowHydrateRef.current.size > 0
        ? mergeLiveAndHydrated(listRef.current, flowHydrateRef.current)
        : listRef.current;
    const out: Capture[] = [];
    const lq = localQuery(query);
    for (const c of pool) {
      // `body:` was answered by the server; skip it locally so a row the server
      // matched is not then rejected by a substring test over a body the client
      // may not even hold.
      if (bodyHits !== null && !bodyHits.has(c.id)) continue;
      if (!matchesFilter(c, lq)) continue;
      out.push(c);
    }
    return out;
  }, [version, query, bodyHits, groupByFlow]);

  const flowMembership = useMemo(() => indexFlowsByCapture(flows), [flows]);

  const displayRows: FlowDisplayRow[] | null = useMemo(() => {
    if (!groupByFlow) return null;
    return buildFlowGroupedRows(filteredCaptures, flows, expandedFlows);
  }, [groupByFlow, filteredCaptures, flows, expandedFlows]);

  /** Flat capture list used for selection / multi / follow when not grouping. */
  const rows = filteredCaptures;

  const virtualCount = displayRows ? displayRows.length : rows.length;

  const total = listRef.current.length;

  // ── Virtualizer ───────────────────────────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    getItemKey: (i) => {
      if (displayRows) {
        const r = displayRows[i];
        if (!r) return i;
        if (r.kind === 'flow') return `flow:${r.flow.id}`;
        if (r.kind === 'ungrouped-header') return 'ungrouped';
        const flowId = r.membership?.flow.id ?? (r.nested ? 'nested' : 'top');
        return `cap:${flowId}:${r.capture.id}`;
      }
      return rows[i]?.id ?? i;
    },
  });

  // Follow the tail. Re-run on row count so a burst keeps the newest row visible.
  useLayoutEffect(() => {
    if (!follow || virtualCount === 0) return;
    virtualizer.scrollToIndex(virtualCount - 1, { align: 'end' });
    setUnseen(0);
  }, [virtualCount, follow, virtualizer]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    // Scrolling up drops follow-mode; scrolling back to the bottom resumes it.
    // Doing it here rather than on a button keeps the pill honest: it counts
    // exactly the rows that arrived while you were not looking at the tail.
    setFollow((f) => {
      if (f === atBottom) return f;
      if (atBottom) setUnseen(0);
      return atBottom;
    });
  }, []);

  // ── Sync button: a notice (info/error) clears "syncing…"; 20s safety fallback ─
  useEffect(() => {
    setSyncing(false);
  }, [noticeId]);
  useEffect(() => {
    if (!syncing) return;
    const t = setTimeout(() => setSyncing(false), 20000);
    return () => clearTimeout(t);
  }, [syncing]);

  function clear(): void {
    ignoredRef.current = new Set(captures.map((c) => c.id));
    setFollow(true);
    resetBuffers();
  }

  function addTerm(term: string): void {
    setQueryText((t) => (t.includes(term) ? t : `${t ? `${t} ` : ''}${term}`));
  }

  function toggleMark(id: string): void {
    setMarks((m) => toggled(m, id));
  }

  /**
   * Click semantics, matching every list a developer already uses: plain click
   * selects one, cmd/ctrl toggles, shift extends from the last anchor.
   */
  function onRowClick(c: Capture, e: React.MouseEvent | React.KeyboardEvent): void {
    if (e.shiftKey && lastAnchor.current) {
      const from = rows.findIndex((r) => r.id === lastAnchor.current);
      const to = rows.findIndex((r) => r.id === c.id);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        const next = new Set(multi);
        for (let i = lo; i <= hi; i++) {
          const id = rows[i]?.id;
          if (id) next.add(id);
        }
        setMulti(next);
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setMulti(toggled(multi, c.id));
      lastAnchor.current = c.id;
      return;
    }
    setMulti(new Set([c.id]));
    lastAnchor.current = c.id;
    onSelect(c);
  }

  const copyCurl = useCallback(async (c: Capture) => {
    // Rows are previews: a request body over 64 KiB is cut, and copying it would
    // hand out a silently corrupted --data-raw. Fetch the stored one, or copy nothing.
    const cut = (c.bodyLengths?.req ?? 0) > (c.reqBody?.length ?? 0);
    const full = cut ? await fetchCaptureBody(c.id).catch(() => null) : null;
    if (cut && !full) return;
    await navigator.clipboard
      ?.writeText(toCurl(full ? { ...c, reqHeaders: full.reqHeaders, reqBody: full.reqBody } : c))
      .catch(() => {});
  }, []);

  const copySelection = useCallback(() => {
    const chosen = rows.filter((r) => multi.has(r.id));
    const text = chosen
      .map((c) => `${c.method}\t${c.status ?? ''}\t${c.host}${c.path}\t${c.durationMs ?? ''}ms`)
      .join('\n');
    void navigator.clipboard?.writeText(text);
  }, [rows, multi]);

  /** Keyed by the virtual item's key (unique per flow: a capture can render under two expanded flows). */
  const renderRow = (c: Capture, v: VirtualItem, nested?: boolean, membership?: CaptureFlowMembership) => (
    <Row
      key={v.key}
      capture={c}
      seq={seqRef.current.get(c.id) ?? 0}
      rowIndex={v.index}
      top={v.start}
      selected={c.id === selectedId}
      inSelection={multi.has(c.id)}
      marked={marks.has(c.id)}
      nested={nested}
      membership={membership ?? primaryMembership(flowMembership.get(c.id))}
      onClick={onRowClick}
      onToggleMark={toggleMark}
      onCopyCurl={copyCurl}
      onCopySelection={copySelection}
      onAddTerm={addTerm}
      selectionSize={multi.size}
    />
  );

  // What the button SHOWS is what it toggles (see captureToggleAction).
  const active = recording && !capturePaused;

  return (
    <section className="dashboard">
      <header className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 border-b border-border bg-bg-1 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className={
              active
                ? 'border-[#4a2020] bg-[#1d1416] text-[#f0a0a0] hover:border-err hover:bg-[#1d1416] hover:text-[#f0a0a0]'
                : 'border-[#2c4a30] bg-[#131a15] text-ok hover:border-ok hover:bg-[#131a15] hover:text-ok'
            }
            onClick={() => {
              const action = captureToggleAction(recording, capturePaused);
              setRecording(action === 'resume');
              // Tell the runner too: pausing only this view would leave the proxy
              // writing every request to disk — a privacy bug on a capture tool.
              sendCaptureControl(action);
            }}
            aria-pressed={active}
            title={
              capturePaused
                ? 'The runner is not writing captures — click to resume'
                : recording
                  ? 'Pause: stop writing captures on the runner too'
                  : 'Resume recording'
            }
          >
            {active ? '❚❚ Pause' : '● Record'}
          </Button>
          <Button size="sm" onClick={clear} title="Clear captured traffic">
            Clear
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setSyncing(true);
              sendSync();
            }}
            disabled={syncing || connection !== 'open'}
            title="Reconstruct structure for every known session"
          >
            {syncing ? 'syncing…' : '⟳ Sync'}
          </Button>
        </div>

        <div className="flex min-w-[220px] flex-1 flex-wrap items-center gap-2 basis-80">
          <Button
            size="sm"
            variant={groupByFlow ? 'primary' : 'default'}
            aria-pressed={groupByFlow}
            title="Group companions under observed/pinned interaction flows (run sluice learn-flows to populate)"
            onClick={() => setGroupByFlow((v) => !v)}
          >
            {groupByFlow ? '☰ Flows on' : '☰ Group flows'}
          </Button>
          <Input
            className="h-6 min-w-[120px] flex-1 basis-auto px-2 text-[11.5px]"
            placeholder={'status:429 op:conversations.* dur:>1500 body:"not_in_channel" -op:client.counts'}
            value={queryText}
            spellCheck={false}
            aria-label="Filter traffic"
            aria-invalid={query.errors.length > 0}
            onChange={(e) => setQueryText(e.target.value)}
          />
          <AddFilter label="App" prefix="app" options={options.apps} onPick={addTerm} />
          <AddFilter label="Op" prefix="op" options={options.ops} onPick={addTerm} />
          <AddFilter label="Host" prefix="host" options={options.hosts} onPick={addTerm} />
          <AddFilter label="Method" prefix="method" options={options.methods} onPick={addTerm} />
          <AddFilter label="Source" prefix="source" options={options.sources} onPick={addTerm} />
          <AddFilter label="Status" prefix="status" options={['2xx', '3xx', '4xx', '5xx', '429']} onPick={addTerm} />
          {options.tabs.size > 0 ? (
            <AddFilter
              label="Tab"
              prefix="tab"
              options={[...options.tabs.keys()]}
              labels={options.tabs}
              onPick={addTerm}
            />
          ) : null}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="tabnum text-fg-mute">
            {(displayRows ? filteredCaptures.length : rows.length).toLocaleString()} /{' '}
            {total.toLocaleString()} requests
            {groupByFlow
              ? ` · ${displayRows ? displayRows.filter((r) => r.kind === 'flow').length : 0}/${flows.length} flows in view`
              : ''}
            {multi.size > 1 ? ` · ${multi.size} selected` : ''}
            {marks.size > 0 ? ` · ${marks.size} marked` : ''}
          </span>
        </div>
      </header>

      {query.errors.length > 0 || searchError || flowsError ? (
        <div className="border-b border-border bg-warn/10 px-3 py-1 font-mono text-[11px] text-warn" role="status">
          {searchError
            ? `body search failed: ${searchError}`
            : flowsError
              ? `flows: ${flowsError}`
              : query.errors.join(' · ')}
        </div>
      ) : null}

      {/* One role=grid wraps the header AND the scroller: a role=row outside a grid
          is not a row (grid > rowgroup > row > gridcell). Divs, not <table> (see the
          header), which is why biome.json turns off useSemanticElements here. */}
      <div
        role="grid"
        aria-label="Captured traffic"
        aria-rowcount={virtualCount + 1}
        aria-colcount={COLUMNS.length}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <div role="rowgroup" className="shrink-0">
          <div
            role="row"
            aria-rowindex={1}
            tabIndex={-1}
            className="grid items-center border-b border-border bg-bg-2 px-2 text-[11px] font-medium tracking-wide text-fg-dim uppercase"
            style={{ gridTemplateColumns: GRID_COLS, height: ROW_H }}
          >
            {COLUMNS.map((h, i) => (
              <div key={h} role="columnheader" aria-colindex={i + 1} tabIndex={-1} className="truncate px-1">
                {h}
              </div>
            ))}
          </div>
        </div>

        <div className="traffic-scroll min-h-0 flex-1 overflow-auto" ref={scrollRef} onScroll={onScroll}>
          {total === 0 ? (
            <div className="empty">
              {active
                ? 'Recording… waiting for traffic. Start the proxy and generate requests.'
                : 'Paused. No traffic captured — press ● Record to start.'}
            </div>
          ) : virtualCount === 0 ? (
            <div className="empty">
              {!groupByFlow || (flows.length > 0 && filteredCaptures.length === 0)
                ? 'No requests match the current filter.'
                : flows.length === 0
                  ? 'No interaction flows in the store yet. Run: sluice learn-flows'
                  : 'Flows are loaded, but none of their captures are in this traffic window. Clear filters, press Sync, or capture a fresh burst and re-run learn-flows.'}
            </div>
          ) : (
            <div role="rowgroup" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => {
                if (displayRows) {
                  const r = displayRows[v.index];
                  if (!r) return null;
                  if (r.kind === 'flow') {
                    return (
                      <FlowGroupRow
                        key={v.key}
                        flow={r.flow}
                        members={r.members}
                        expanded={r.expanded}
                        top={v.start}
                        rowIndex={v.index}
                        onToggle={() => setExpandedFlows((prev) => toggled(prev, r.flow.id))}
                        onSelectPrimary={() => {
                          const primary =
                            r.members.find((c) => c.id === r.flow.primaryCaptureId) ?? r.members[0];
                          if (primary) onSelect(primary);
                        }}
                      />
                    );
                  }
                  if (r.kind === 'ungrouped-header') {
                    return (
                      <div
                        key={v.key}
                        role="row"
                        tabIndex={-1}
                        aria-rowindex={v.index + 2}
                        className="absolute inset-x-0 flex items-center border-b border-border/80 bg-bg-2/80 px-3 font-mono text-[11px] text-fg-mute"
                        style={{ height: ROW_H, transform: `translateY(${v.start}px)` }}
                      >
                        <div role="gridcell" aria-colindex={1} className="truncate" tabIndex={-1}>
                          Ungrouped · {r.count} request{r.count === 1 ? '' : 's'} not in a learned/pinned flow
                        </div>
                      </div>
                    );
                  }
                  return renderRow(r.capture, v, r.nested, r.membership);
                }
                const c = rows[v.index];
                if (!c) return null;
                return renderRow(c, v);
              })}
            </div>
          )}
        </div>

        {unseen > 0 ? (
          <button
            type="button"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-accent bg-accent-dim px-3 py-1 font-mono text-[11px] text-fg shadow-lg hover:bg-accent hover:text-bg"
            onClick={() => setFollow(true)}
          >
            ↓ {unseen.toLocaleString()} new
          </button>
        ) : null}
      </div>
    </section>
  );
}

/** The query minus its server-answered `body:` terms (see serverSideTerms). */
function localQuery(q: FilterQuery): FilterQuery {
  const server = serverSideTerms(q);
  if (server.length === 0) return q;
  return { terms: q.terms.filter((t) => !server.includes(t)), errors: q.errors };
}

/** Skip setFlows when id+endedAt fingerprint is unchanged (avoids hydrate thrash). */
function flowsListUnchanged(a: FlowSummary[], b: FlowSummary[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.endedAt === b[i]!.endedAt);
}

/** Live ring first, then side-map hydrates not already present. */
function mergeLiveAndHydrated(live: Capture[], hydrated: Map<string, Capture>): Capture[] {
  const have = new Set(live.map((c) => c.id));
  return live.concat([...hydrated.values()].filter((c) => !have.has(c.id)));
}

function FlowGroupRow({
  flow,
  members,
  expanded,
  top,
  rowIndex,
  onToggle,
  onSelectPrimary,
}: {
  flow: FlowSummary;
  members: Capture[];
  expanded: boolean;
  top: number;
  rowIndex: number;
  onToggle: () => void;
  onSelectPrimary: () => void;
}) {
  const label = flow.label || flow.primaryOp || flow.id;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      aria-expanded={expanded}
      tabIndex={0}
      className="absolute inset-x-0 grid cursor-pointer items-center border-b border-border bg-bg-2/90 px-2 font-mono text-[12px] text-fg hover:bg-bg-3"
      style={{ gridTemplateColumns: GRID_COLS, height: ROW_H, transform: `translateY(${top}px)` }}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <Cell col={1} className="text-fg-mute">{expanded ? '▼' : '▶'}</Cell>
      <Cell col={2} className="text-fg-dim" title={flow.id}>flow</Cell>
      <Cell col={3}>{flow.adapterId}</Cell>
      <Cell col={4} className="text-fg-dim">{flow.source}</Cell>
      <div
        role="gridcell"
        aria-colindex={5}
        className="truncate px-1 font-medium"
        style={{ gridColumn: '5 / 10' }}
        title={`${label} · ${members.length}/${flow.stepCount} in window`}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onSelectPrimary();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onSelectPrimary();
          }
        }}
      >
        {label}
        <span className="ml-2 font-normal text-fg-mute">
          {members.length}/{flow.stepCount} steps · {flow.endedAt - flow.startedAt}ms span
        </span>
      </div>
      <Cell col={10} className="text-fg-mute">—</Cell>
      <Cell col={11} className="text-fg-mute">—</Cell>
    </div>
  );
}

interface RowProps {
  capture: Capture;
  seq: number;
  rowIndex: number;
  top: number;
  selected: boolean;
  inSelection: boolean;
  marked: boolean;
  selectionSize: number;
  nested?: boolean;
  membership?: CaptureFlowMembership;
  onClick: (c: Capture, e: React.MouseEvent | React.KeyboardEvent) => void;
  onToggleMark: (id: string) => void;
  onCopyCurl: (c: Capture) => void;
  onCopySelection: () => void;
  onAddTerm: (term: string) => void;
}

function Row({
  capture: c,
  seq,
  rowIndex,
  top,
  selected,
  inSelection,
  marked,
  selectionSize,
  nested,
  membership,
  onClick,
  onToggleMark,
  onCopyCurl,
  onCopySelection,
  onAddTerm,
}: RowProps) {
  const app = appOf(c);
  const op = c.classification ?? '';
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {/* A real button would be correct for a single-action row, but this one
            carries click, cmd-click, shift-click and a context menu; role="row"
            + tabIndex keeps it reachable without pretending it is a button. */}
        <div
          role="row"
          aria-rowindex={rowIndex + 2}
          aria-selected={selected || inSelection}
          tabIndex={0}
          className={[
            'absolute inset-x-0 grid cursor-default items-center px-2 font-mono text-[12.5px]',
            'border-b border-border/60 hover:bg-bg-2',
            selected ? 'bg-accent-dim' : inSelection ? 'bg-bg-3' : '',
            marked ? 'shadow-[inset_3px_0_0_0_var(--color-warn)]' : '',
            c.source === 'replay' ? 'italic text-fg-dim' : '',
            nested ? 'pl-4' : '',
          ].join(' ')}
          style={{ gridTemplateColumns: GRID_COLS, height: ROW_H, transform: `translateY(${top}px)` }}
          onClick={(e) => onClick(c, e)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClick(c, e);
            }
            if (e.key === 'm' || e.key === 'M') onToggleMark(c.id);
          }}
        >
          <Cell col={1} className="tabnum text-fg-mute">{seq}</Cell>
          <Cell col={2} className="tabnum text-fg-dim">{formatClock(c.ts)}</Cell>
          <Cell col={3} title={app}>{app}</Cell>
          <Cell col={4} className="text-fg-dim">{c.source}</Cell>
          <Cell col={5}>
            {/* A WebSocket frame has no status or duration, so the direction
                arrow is the only thing that says which way it went. */}
            {c.direction ? (
              <span title={c.direction === 'sent' ? 'sent by the page' : 'received by the page'}>
                {c.method} {c.direction === 'sent' ? '↑' : '↓'}
              </span>
            ) : (
              c.method
            )}
          </Cell>
          <Cell
            col={6}
            title={
              membership
                ? `${op || '—'} · flow ${membership.flow.id} (${membership.step.role})`
                : op
            }
            className={op ? '' : 'text-fg-mute'}
          >
            {membership && nested ? (
              <span className="text-fg-mute">{membership.step.role === 'primary' ? '★ ' : '· '}</span>
            ) : null}
            {op || '—'}
          </Cell>
          <Cell col={7} title={c.host} className="text-fg-dim">
            {c.host}
          </Cell>
          <Cell col={8} title={c.path}>{c.path}</Cell>
          <Cell col={9}>
            <Badge tone={statusTone(c.status)}>{c.status ?? '—'}</Badge>
          </Cell>
          <Cell col={10} className="tabnum text-fg-dim">{captureSize(c)}</Cell>
          <Cell col={11} className="tabnum text-fg-dim">{formatDuration(c.durationMs)}</Cell>
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-52 rounded border border-border-2 bg-bg-2 p-1 font-sans text-[12.5px] text-fg shadow-xl">
          <MenuItem onSelect={() => onCopyCurl(c)}>
            Copy as cURL
            <span className="ml-2 text-[10px] text-fg-mute">(redacted headers)</span>
          </MenuItem>
          <MenuItem onSelect={() => void navigator.clipboard?.writeText(`${c.host}${c.path}`)}>Copy URL</MenuItem>
          {selectionSize > 1 ? (
            <MenuItem onSelect={onCopySelection}>Copy {selectionSize} selected rows</MenuItem>
          ) : null}
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <MenuItem onSelect={() => onToggleMark(c.id)}>{marked ? 'Unmark' : 'Mark'} row</MenuItem>
          {op ? (
            <>
              <MenuItem onSelect={() => onAddTerm(`op:${op}`)}>Filter to {op}</MenuItem>
              <MenuItem onSelect={() => onAddTerm(`-op:${op}`)}>Exclude {op}</MenuItem>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Cell({
  children,
  className,
  title,
  col,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  /** 1-based column, so a screen reader can say "Status, 429" rather than "429". */
  col: number;
}) {
  return (
    <div
      role="gridcell"
      aria-colindex={col}
      // Roving tabindex: the ROW is the tab stop, cells are reachable from it
      // with the arrow keys rather than being eleven tab stops per row.
      tabIndex={-1}
      className={`truncate px-1 ${className ?? ''}`}
      title={title}
    >
      {children}
    </div>
  );
}

function MenuItem({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className="cursor-default rounded-sm px-2 py-1 outline-none data-[highlighted]:bg-accent-dim"
    >
      {children}
    </ContextMenu.Item>
  );
}

interface AddFilterProps {
  label: string;
  prefix: string;
  options: string[];
  labels?: Map<string, string>;
  onPick: (term: string) => void;
}

/** A menu that APPENDS a term to the query; it holds no filter state of its own. */
function AddFilter({ label, prefix, options, labels, onPick }: AddFilterProps) {
  if (options.length === 0) return null;
  return (
    <select
      className="h-6 max-w-40 cursor-pointer rounded border border-border-2 bg-bg-2 px-1.5 font-mono text-[11.5px] text-fg outline-none focus:border-accent"
      value=""
      onChange={(e) => {
        if (e.target.value) onPick(`${prefix}:${e.target.value}`);
        e.currentTarget.value = '';
      }}
      title={`Add a ${label.toLowerCase()} filter`}
    >
      <option value="">+ {label}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.get(o) ?? o}
        </option>
      ))}
    </select>
  );
}
