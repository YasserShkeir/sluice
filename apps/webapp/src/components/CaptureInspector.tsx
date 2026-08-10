// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useState } from 'react';
import type { Capture, Item } from '@sluice/core';
import { formatClock, formatDuration, humanizeBytes, prettyJson, statusClass, toCurl } from '../format.js';
import { fetchCaptureBody, fetchCaptureEntities } from '../api.js';
import { diffLines, diffStat } from '../diff.js';
import { setPin, usePin } from '../pin.js';
import { JsonTree } from './JsonTree.js';

interface Props {
  capture: Capture;
  onClose: () => void;
}

type Tab = 'response' | 'request' | 'timing' | 'entities' | 'curl' | 'diff';

/** Copy-to-clipboard button with a brief "copied" acknowledgement. */
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-mute hover:bg-bg-3 hover:text-fg"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {},
        );
      }}
    >
      {done ? 'copied' : label}
    </button>
  );
}

/** JSON when it parses (as a virtualized tree), otherwise the raw text. */
function Body({ text }: { text: string | null }) {
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => {
    if (text === null || text === '') return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }, [text]);

  if (text === null || text === '') return <div className="p-2 text-[12px] text-fg-mute">empty</div>;
  const isJson = parsed !== undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-fg-mute">{humanizeBytes(text)}</span>
        {isJson ? (
          <button type="button" className="text-[11px] text-fg-mute hover:text-fg" onClick={() => setRaw((v) => !v)}>
            {raw ? 'tree' : 'raw'}
          </button>
        ) : null}
        <span className="ml-auto">
          <CopyButton text={isJson ? prettyJson(text) : text} />
        </span>
      </div>
      {isJson && !raw ? (
        <JsonTree value={parsed} />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto rounded bg-bg-0/40 p-2 font-mono text-[12px] leading-5">
          {isJson ? prettyJson(text) : text}
        </pre>
      )}
    </div>
  );
}

function Headers({ headers }: { headers: Record<string, string> }) {
  if (Object.keys(headers).length === 0) return <div className="text-[12px] text-fg-mute">none</div>;
  return (
    <table className="w-full">
      <tbody>
        {Object.entries(headers).map(([k, v]) => (
          <tr key={k} className="align-top">
            <td className="py-0.5 pr-3 font-mono text-[11.5px] text-fg-dim">{k}</td>
            <td className="py-0.5 font-mono text-[11.5px] text-fg break-all">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CaptureInspector({ capture, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('response');
  // Bodies are not shipped over the WS backfill (they can be 5 MB each), so the
  // inspector fetches them on demand and merges over whatever the capture row
  // already carries. Headers come back on the same request.
  const [fetched, setFetched] = useState<{
    reqBody: string | null;
    resBody: string | null;
    reqHeaders: Record<string, string>;
    resHeaders: Record<string, string>;
  } | null>(null);
  const [entities, setEntities] = useState<Item[] | null>(null);
  const pinned = usePin();

  useEffect(() => {
    setFetched(null);
    setEntities(null);
    let live = true;
    fetchCaptureBody(capture.id)
      .then((b) => {
        if (live) setFetched(b);
      })
      .catch(() => {
        /* fall back to the inline fields below */
      });
    return () => {
      live = false;
    };
  }, [capture.id]);

  // Lazy: only hit the entities endpoint when that tab is first opened.
  useEffect(() => {
    if (tab !== 'entities' || entities !== null) return;
    let live = true;
    fetchCaptureEntities(capture.id)
      .then((r) => {
        if (live) setEntities(r.items);
      })
      .catch(() => {
        if (live) setEntities([]);
      });
    return () => {
      live = false;
    };
  }, [tab, capture.id, entities]);

  const reqHeaders = fetched?.reqHeaders ?? capture.reqHeaders;
  const resHeaders = fetched?.resHeaders ?? capture.resHeaders;
  const reqBody = fetched?.reqBody ?? capture.reqBody;
  const resBody = fetched?.resBody ?? capture.resBody;

  const curl = useMemo(() => toCurl({ method: capture.method, url: capture.url, reqHeaders, reqBody }), [capture.method, capture.url, reqHeaders, reqBody]);
  const isPinnedSelf = pinned?.id === capture.id;

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'response', label: 'Response' },
    { id: 'request', label: 'Request' },
    { id: 'timing', label: 'Timing' },
    { id: 'entities', label: 'Entities' },
    { id: 'curl', label: 'cURL' },
  ];
  // The Diff tab appears only once something else is pinned to compare against.
  if (pinned && !isPinnedSelf) TABS.push({ id: 'diff', label: 'Diff' });

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border bg-bg-1">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-mute">Inspector</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-fg-mute">{capture.adapterId ?? 'unclassified'}</span>
          <button
            type="button"
            className="rounded px-1.5 text-fg-mute hover:bg-bg-3 hover:text-fg"
            onClick={onClose}
            aria-label="Close inspector"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="font-mono text-[12px] text-fg break-all">
          {capture.method} {capture.path}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
          <span className={`status-badge ${statusClass(capture.status)}`}>{capture.status ?? '—'}</span>
          <span className="text-fg-mute">{formatDuration(capture.durationMs)}</span>
          <span className="text-fg-mute">{capture.source}</span>
          <span className="text-fg-mute break-all">{capture.host}</span>
        </div>
      </div>

      <div className="flex shrink-0 gap-0.5 border-b border-border px-2 pt-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={[
              'rounded-t px-2.5 py-1 text-[12px]',
              tab === t.id ? 'bg-bg-3 text-fg' : 'text-fg-dim hover:text-fg',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
        {tab === 'response' || tab === 'request' ? (
          <>
            {/* Headers collapse by default so the body — the thing you opened the
                inspector to read — is what fills the pane. */}
            <details className="shrink-0">
              <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-fg-mute">
                Headers ({Object.keys(tab === 'response' ? resHeaders : reqHeaders).length})
              </summary>
              <div className="mt-1 max-h-[30vh] overflow-auto">
                <Headers headers={tab === 'response' ? resHeaders : reqHeaders} />
              </div>
            </details>
            <div className="flex shrink-0 items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-mute">Body</span>
              {tab === 'response' && resBody ? (
                <button
                  type="button"
                  className="text-[11px] text-fg-mute hover:text-fg"
                  onClick={() =>
                    isPinnedSelf
                      ? setPin(null)
                      : setPin({ id: capture.id, label: `${capture.method} ${capture.path}`, body: prettyJson(resBody) })
                  }
                >
                  {isPinnedSelf ? 'unpin' : 'pin for diff'}
                </button>
              ) : null}
            </div>
            <Body text={tab === 'response' ? resBody : reqBody} />
          </>
        ) : null}

        {tab === 'timing' ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <Timing capture={capture} reqBody={reqBody} resBody={resBody} />
          </div>
        ) : null}

        {tab === 'entities' ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <Entities items={entities} parsedAt={capture.parsedAt ?? null} />
          </div>
        ) : null}

        {tab === 'curl' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex shrink-0 items-center justify-between gap-2">
              <span className="text-[11px] text-fg-mute">
                Reproduces what was captured — auth headers are redacted, so substitute your own.
              </span>
              <CopyButton text={curl} label="Copy cURL" />
            </div>
            <pre className="min-h-0 flex-1 overflow-auto rounded bg-bg-0/40 p-2 font-mono text-[12px] leading-5">
              {curl}
            </pre>
          </div>
        ) : null}

        {tab === 'diff' && pinned ? <Diff pinnedLabel={pinned.label} left={pinned.body} right={prettyJson(resBody)} /> : null}
      </div>
    </aside>
  );
}

function Timing({ capture, reqBody, resBody }: { capture: Capture; reqBody: string | null; resBody: string | null }) {
  const rows: Array<[string, string]> = [
    ['Observed', `${new Date(capture.ts).toLocaleDateString()} ${formatClock(capture.ts)}`],
    ['Duration', formatDuration(capture.durationMs)],
    ['Status', capture.status === null ? '—' : String(capture.status)],
    ['Source', capture.source],
    ['Host', capture.host],
    ['Operation', capture.classification ?? '—'],
    ['Request size', humanizeBytes(reqBody)],
    ['Response size', humanizeBytes(resBody)],
  ];
  // A single duration bar — we capture one round-trip number, not per-phase
  // timings, so this shows what is real rather than inventing DNS/TLS splits.
  const d = capture.durationMs ?? 0;
  const pct = Math.min(100, (d / 2000) * 100);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 text-[11px] text-fg-mute">round-trip · {formatDuration(capture.durationMs)}</div>
        <div className="h-2 w-full overflow-hidden rounded bg-bg-3">
          <div className={`h-full ${d >= 1000 ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
      </div>
      <table className="w-full">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="py-0.5 pr-3 text-[12px] text-fg-mute">{k}</td>
              <td className="py-0.5 font-mono text-[12px] text-fg break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Entities({ items, parsedAt }: { items: Item[] | null; parsedAt: number | null }) {
  if (items === null) return <div className="text-[12px] text-fg-mute">Loading…</div>;
  if (items.length === 0) {
    return (
      <div className="text-[12px] text-fg-mute">
        {parsedAt === null
          ? 'This exchange has not been parsed into entities.'
          : 'No entities were extracted from this exchange.'}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-fg-mute">{items.length} item(s) derived from this exchange</div>
      <ul className="flex flex-col gap-1.5">
        {items.map((it) => (
          <li key={it.id} className="rounded border border-border/60 p-2">
            <div className="flex items-center gap-2 text-[11px] text-fg-mute">
              <span className="rounded bg-bg-3 px-1.5 py-0.5">{it.kind}</span>
              {it.authorId ? <span>by {it.authorId}</span> : null}
              <span className="ml-auto">{new Date(it.ts).toLocaleString()}</span>
            </div>
            {it.text ? <div className="mt-1 text-[12px] text-fg line-clamp-3">{it.text}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Diff({ pinnedLabel, left, right }: { pinnedLabel: string; left: string; right: string }) {
  const lines = useMemo(() => diffLines(left, right), [left, right]);
  const stat = useMemo(() => diffStat(lines), [lines]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="shrink-0 text-[11px] text-fg-mute">
        vs pinned <span className="text-fg-dim">{pinnedLabel}</span> ·{' '}
        <span className="text-ok">+{stat.added}</span> <span className="text-danger">−{stat.removed}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded bg-bg-0/40 font-mono text-[12px] leading-5">
        {lines.map((l) => (
          <div
            key={l.id}
            className={[
              'whitespace-pre px-2',
              l.type === 'add' ? 'bg-ok/10 text-ok' : l.type === 'del' ? 'bg-danger/10 text-danger' : 'text-fg-dim',
            ].join(' ')}
          >
            <span className="select-none text-fg-mute">{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}</span>
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
