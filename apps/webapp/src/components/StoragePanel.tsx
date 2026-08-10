// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The storage + data-management surface (v2).
 *
 * Two answers a local capture tool owes you and could not give from the UI
 * before: "what is on disk?" and "how do I clear it?". The first is a read
 * (/api/storage); the second is a set of WS operations whose progress shows in
 * the activity cards. The panel's job is to make the difference between cheap,
 * rebuildable DERIVED data and your-only-copy CAPTURES legible, so the safe
 * reclaim (rebuild derived tables) reads differently from the irreversible one
 * (delete captures / wipe).
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchStorage } from '../api.js';
import type { StorageInfo } from '../api.js';
import {
  sendDataDeleteCaptures,
  sendDataRematerialize,
  sendDataVacuum,
  sendDataWipe,
} from '../ws.js';
import { Button } from '../ui/button.js';
import { ConfirmDestructive } from './ConfirmDestructive.js';

function mb(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** A table is DERIVED (rebuildable) if it is adapter-prefixed or an FTS shadow. */
function isDerived(name: string, adapterIds: string[]): boolean {
  if (name.endsWith('_fts') || name.includes('_fts_')) return true;
  return adapterIds.some((id) => name.startsWith(`${id}_`));
}

type Pending =
  | { kind: 'noise'; count: number }
  | { kind: 'wipe' }
  | null;

export function StoragePanel() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);

  const refresh = useCallback(() => {
    fetchStorage()
      .then(setInfo)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Refresh on mount and whenever this tab regains focus — an op that finished in
  // the activity cards changed the numbers under us.
  useEffect(() => {
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  if (error !== null) return <p className="p-4 text-[12px] text-danger">Could not read storage — {error}</p>;
  if (info === null) return <p className="p-4 text-[12px] text-fg-mute">Reading storage…</p>;

  const derivedBytes = info.tables
    .filter((t) => isDerived(t.name, info.adapterIds))
    .reduce((n, t) => n + t.bytes, 0);
  const capturesTable = info.tables.find((t) => t.name === 'captures');
  const captureBytes = capturesTable?.bytes ?? 0;
  const otherBytes = Math.max(0, info.totalBytes - derivedBytes - captureBytes - info.freeBytes);

  return (
    <div className="flex flex-col gap-4 p-3">
      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold text-fg">On disk — {mb(info.totalBytes)}</h2>
          <button type="button" onClick={refresh} className="text-[11px] text-fg-mute hover:text-fg">
            refresh
          </button>
        </div>
        {/* One stacked bar: derived (safe to drop) / captures (evidence) / other / free. */}
        <div className="mt-2 flex h-3 w-full overflow-hidden rounded bg-bg-3 text-[0]">
          <Seg bytes={derivedBytes} total={info.totalBytes} className="bg-accent" title={`derived ${mb(derivedBytes)}`} />
          <Seg bytes={captureBytes} total={info.totalBytes} className="bg-ok" title={`captures ${mb(captureBytes)}`} />
          <Seg bytes={otherBytes} total={info.totalBytes} className="bg-fg-mute" title={`other ${mb(otherBytes)}`} />
          <Seg bytes={info.freeBytes} total={info.totalBytes} className="bg-bg-3" title={`free ${mb(info.freeBytes)}`} />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-fg-mute">
          <Legend className="bg-accent" label={`derived ${mb(derivedBytes)}`} />
          <Legend className="bg-ok" label={`captures ${mb(captureBytes)}`} />
          <Legend className="bg-fg-mute" label={`other ${mb(otherBytes)}`} />
          <span>{info.captures.total} captures ({info.captures.unattributed} unattributed)</span>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-semibold text-fg">Reclaim (safe — rebuilds from captures)</h3>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => sendDataRematerialize()}>
            Rebuild derived tables ({mb(derivedBytes)})
          </Button>
          <Button onClick={() => sendDataVacuum()}>
            Reclaim free space ({mb(info.freeBytes)})
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-semibold text-fg">Delete (irreversible — your only copy)</h3>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={info.captures.unattributed === 0}
            onClick={() => setPending({ kind: 'noise', count: info.captures.unattributed })}
          >
            Delete {info.captures.unattributed} unattributed
          </Button>
          <Button variant="danger" onClick={() => setPending({ kind: 'wipe' })}>
            Wipe everything
          </Button>
        </div>
      </section>

      <details className="text-[11px] text-fg-mute">
        <summary className="cursor-pointer">Per-table breakdown</summary>
        <table className="mt-2 w-full">
          <tbody>
            {info.tables.map((t) => (
              <tr key={t.name} className="border-b border-border/50">
                <td className="py-0.5 pr-2 font-mono">{t.name}</td>
                <td className="py-0.5 pr-2 text-right tabular-nums">{t.rows}</td>
                <td className="py-0.5 text-right tabular-nums">{mb(t.bytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <ConfirmDestructive
        open={pending?.kind === 'noise'}
        title="Delete unattributed captures"
        irreversible
        confirmLabel="Delete"
        body={
          <>
            Removes{' '}
            <strong>{pending?.kind === 'noise' ? pending.count : 0}</strong> captures no adapter
            claimed — the pre-scoping noise (ChatGPT, telemetry, CDNs). No app data is touched.
          </>
        }
        onConfirm={() => sendDataDeleteCaptures({ unattributed: true, vacuum: true })}
        onCancel={() => setPending(null)}
      />
      <ConfirmDestructive
        open={pending?.kind === 'wipe'}
        title="Wipe all data"
        irreversible
        requirePhrase="wipe"
        confirmLabel="Wipe everything"
        body={
          <>
            Removes <strong>all {info.captures.total} captures</strong> and every derived table.
            The dashboard empties. Sessions and the CA are not touched.
          </>
        }
        onConfirm={() => sendDataWipe('wipe')}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function Seg({ bytes, total, className, title }: { bytes: number; total: number; className: string; title: string }) {
  if (bytes <= 0 || total <= 0) return null;
  return <span className={className} style={{ width: `${(bytes / total) * 100}%` }} title={title} />;
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded-sm ${className}`} />
      {label}
    </span>
  );
}
