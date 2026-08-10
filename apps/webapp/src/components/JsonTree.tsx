// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A virtualized, collapsible JSON tree.
 *
 * Response bodies in this tool are not small — a `conversations.history` page or
 * a materialized 56k-row export is exactly the thing you want to inspect, and a
 * `<pre>` of 200k characters both janks the pane and hides the structure. So the
 * tree flattens to only its VISIBLE nodes (children of collapsed nodes cost
 * nothing) and renders that list through the same `@tanstack/react-virtual` the
 * traffic table uses, so a body of any size draws a constant number of rows.
 *
 * The flattening is the whole trick: expansion state is a Set of path strings,
 * and the visible-row list is recomputed from the parsed value + that Set. No
 * per-node React state, so toggling a deep node is O(visible), not O(tree).
 */
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

type Json = unknown;

interface Row {
  id: string; // the path — stable key and expansion identity
  depth: number;
  /** object key or array index label, or null at the root */
  label: string | null;
  value: Json;
  /** true for objects/arrays that have children */
  expandable: boolean;
  expanded: boolean;
  /** child count, for the collapsed summary */
  size: number;
}

const ROW_H = 20;
/** Cap children rendered per container so one giant array cannot flatten to millions of rows. */
const MAX_CHILDREN = 1000;

function kindOf(v: Json): 'object' | 'array' | 'primitive' {
  if (Array.isArray(v)) return 'array';
  if (v !== null && typeof v === 'object') return 'object';
  return 'primitive';
}

/** A one-line preview of a collapsed container, e.g. `{3 keys}` / `[128]`. */
function summary(v: Json): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  const n = Object.keys(v as object).length;
  return `{${n === 1 ? '1 key' : `${n} keys`}}`;
}

/** How a primitive is drawn, with a class for colouring. */
function primitive(v: Json): { text: string; cls: string } {
  if (v === null) return { text: 'null', cls: 'text-fg-mute' };
  switch (typeof v) {
    case 'string':
      return { text: JSON.stringify(v), cls: 'text-ok' };
    case 'number':
      return { text: String(v), cls: 'text-accent' };
    case 'boolean':
      return { text: String(v), cls: 'text-warn' };
    default:
      return { text: String(v), cls: 'text-fg' };
  }
}

/** Recompute the flat visible-row list from the value and the expanded set. */
function flatten(root: Json, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (value: Json, label: string | null, depth: number, path: string): void => {
    const kind = kindOf(value);
    const expandable = kind !== 'primitive';
    const isOpen = expandable && expanded.has(path);
    const size = expandable ? (Array.isArray(value) ? value.length : Object.keys(value as object).length) : 0;
    rows.push({ id: path, depth, label, value, expandable, expanded: isOpen, size });
    if (!isOpen) return;
    if (Array.isArray(value)) {
      const shown = Math.min(value.length, MAX_CHILDREN);
      for (let i = 0; i < shown; i++) walk(value[i], String(i), depth + 1, `${path}/${i}`);
      if (value.length > shown) {
        rows.push({ id: `${path}/…`, depth: depth + 1, label: `… ${value.length - shown} more`, value: undefined, expandable: false, expanded: false, size: 0 });
      }
    } else {
      const entries = Object.entries(value as Record<string, Json>);
      const shown = Math.min(entries.length, MAX_CHILDREN);
      for (let i = 0; i < shown; i++) {
        const [k, v] = entries[i] as [string, Json];
        walk(v, k, depth + 1, `${path}/${k}`);
      }
      if (entries.length > shown) {
        rows.push({ id: `${path}/…`, depth: depth + 1, label: `… ${entries.length - shown} more`, value: undefined, expandable: false, expanded: false, size: 0 });
      }
    }
  };
  walk(root, null, 0, '$');
  return rows;
}

/** Collect every container path, for expand-all. */
function allPaths(root: Json): Set<string> {
  const out = new Set<string>();
  const walk = (value: Json, path: string): void => {
    if (kindOf(value) === 'primitive') return;
    out.add(path);
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}/${i}`);
      });
    } else {
      for (const [k, v] of Object.entries(value as object)) walk(v, `${path}/${k}`);
    }
  };
  walk(root, '$');
  return out;
}

export function JsonTree({ value }: { value: Json }) {
  // Root plus its immediate children open by default — enough to see the shape
  // without paying to expand a whole large document.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>(['$']);
    if (kindOf(value) === 'object') for (const k of Object.keys(value as object)) s.add(`$/${k}`);
    return s;
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const rows = useMemo(() => flatten(value, expanded), [value, expanded]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
    getItemKey: (i) => rows[i]?.id ?? i,
  });

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex shrink-0 gap-2 text-[11px] text-fg-mute">
        <button type="button" className="hover:text-fg" onClick={() => setExpanded(allPaths(value))}>
          expand all
        </button>
        <button type="button" className="hover:text-fg" onClick={() => setExpanded(new Set(['$']))}>
          collapse all
        </button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto rounded bg-bg-0/40 font-mono text-[12px] leading-5">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            const prim = row.expandable ? null : row.value === undefined ? null : primitive(row.value);
            return (
              <div
                key={v.key}
                className="absolute left-0 top-0 flex w-full items-center whitespace-pre"
                style={{ height: ROW_H, transform: `translateY(${v.start}px)`, paddingLeft: `${row.depth * 14 + 8}px` }}
              >
                {row.expandable ? (
                  <button
                    type="button"
                    onClick={() => toggle(row.id)}
                    className="mr-1 w-3 shrink-0 text-fg-mute hover:text-fg"
                    aria-label={row.expanded ? 'collapse' : 'expand'}
                  >
                    {row.expanded ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="mr-1 w-3 shrink-0" />
                )}
                {row.label !== null ? <span className="text-fg-dim">{row.label}</span> : null}
                {row.label !== null && row.value !== undefined ? <span className="text-fg-mute">: </span> : null}
                {row.expandable ? (
                  <span className="text-fg-mute">{row.expanded ? (Array.isArray(row.value) ? '[' : '{') : summary(row.value)}</span>
                ) : prim ? (
                  <span className={prim.cls}>{prim.text}</span>
                ) : (
                  <span className="text-fg-mute italic">{row.label === null ? '' : ''}</span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
