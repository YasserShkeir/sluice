// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One keyboard registry, two surfaces.
 *
 * Every keyboard-reachable action is a {@link Command} in a single list. The ⌘K
 * palette runs any of them by name; the `?` cheatsheet lists them with their key
 * hints. Both read the SAME list, so a command can never appear in one and not
 * the other, and a new action is one entry rather than three edits (binding,
 * palette row, help row).
 *
 * Key syntax: `mod+k` (⌘ on mac, Ctrl elsewhere), a bare key like `?` or `/`,
 * or a two-step sequence like `g t` (press g, then t). Sequences are the vim-ish
 * idiom people expect from a cheatsheet; combos work even inside inputs, bare
 * keys and sequences do not (so typing in a filter box never triggers them).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { groupBy } from '../collections.js';
import { DialogShell, useEscapeKey } from '../ui/dialog.js';

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Key hints, e.g. ['mod+k'] or ['g t']. First is shown in the cheatsheet. */
  keys?: string[];
  run: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Pretty-print a key spec for display: `mod+k` → `⌘K` / `Ctrl+K`. */
export function prettyKeys(spec: string): string {
  if (spec.includes(' ')) return spec.split(' ').join(' then ');
  return spec
    .split('+')
    .map((p) => {
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return '⇧';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(isMac ? '' : '+');
}

function inEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

/** Does this keydown match a single (non-sequence) spec? */
function matchesCombo(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.split('+');
  const key = parts[parts.length - 1] ?? '';
  const wantMod = parts.includes('mod');
  const wantShift = parts.includes('shift');
  const gotMod = e.metaKey || e.ctrlKey;
  if (wantMod !== gotMod) return false;
  if (wantShift && !e.shiftKey) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

/**
 * Bind the registry globally, and expose the palette/cheatsheet open state.
 * `mod+k` opens the palette and `?` opens the cheatsheet regardless of what any
 * command declares.
 */
export function useGlobalHotkeys(commands: Command[]) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const cmdRef = useRef(commands);
  cmdRef.current = commands;
  const pending = useRef<{ key: string; at: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Combos first — they work everywhere, including inputs.
      if (matchesCombo(e, 'mod+k')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      for (const c of cmdRef.current) {
        for (const spec of c.keys ?? []) {
          if (!spec.includes(' ') && spec.includes('+') && matchesCombo(e, spec)) {
            e.preventDefault();
            c.run();
            return;
          }
        }
      }
      // Bare keys and sequences: never while typing.
      if (inEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        setCheatOpen((v) => !v);
        return;
      }
      // Two-step sequences (`g t`).
      const now = Date.now();
      const prev = pending.current;
      pending.current = null;
      for (const c of cmdRef.current) {
        for (const spec of c.keys ?? []) {
          if (!spec.includes(' ')) continue;
          const [a, b] = spec.split(' ');
          if (prev && now - prev.at < 900 && prev.key === a && e.key === b) {
            e.preventDefault();
            c.run();
            return;
          }
        }
      }
      // Remember a possible sequence prefix.
      const isPrefix = cmdRef.current.some((c) =>
        (c.keys ?? []).some((s) => s.includes(' ') && s.split(' ')[0] === e.key),
      );
      if (isPrefix) pending.current = { key: e.key, at: now };
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return { paletteOpen, setPaletteOpen, cheatOpen, setCheatOpen };
}

// ── ⌘K palette ─────────────────────────────────────────────────────────────────

export function CommandPalette({
  commands,
  open,
  onClose,
}: {
  commands: Command[];
  open: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (open) {
      setQ('');
      setSel(0);
      // Focus via effect rather than the autoFocus attribute (a11y lint, and it
      // also refocuses on a re-open, which the attribute would not).
      inputRef.current?.focus();
    }
  }, [open]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => `${c.label} ${c.group}`.toLowerCase().includes(needle));
  }, [q, commands]);

  if (!open) return null;

  const run = (c: Command | undefined): void => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <DialogShell label="Command palette" className="z-[70] items-start pt-[12vh]">
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-bg-1 shadow-2xl">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(filtered[sel]);
            }
          }}
          placeholder="Type a command…"
          aria-label="Type a command"
          className="w-full border-b border-border bg-transparent px-3 py-2.5 text-[13px] text-fg outline-none placeholder:text-fg-mute"
        />
        <ul className="max-h-[50vh] overflow-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-[12px] text-fg-mute">No matching command.</li>
          ) : (
            filtered.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                  className={[
                    'flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px]',
                    i === sel ? 'bg-accent-dim text-fg' : 'text-fg-dim hover:bg-bg-3',
                  ].join(' ')}
                >
                  <span>
                    <span className="text-fg-mute">{c.group} · </span>
                    {c.label}
                  </span>
                  {c.keys?.[0] ? <Kbd>{prettyKeys(c.keys[0])}</Kbd> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </DialogShell>
  );
}

// ── ? cheatsheet ────────────────────────────────────────────────────────────────

export function KeyCheatsheet({
  commands,
  open,
  onClose,
}: {
  commands: Command[];
  open: boolean;
  onClose: () => void;
}) {
  useEscapeKey(open, onClose);
  if (!open) return null;

  const groups = groupBy(commands, (c) => c.group);

  return (
    <DialogShell label="Keyboard shortcuts" className="z-[70] items-center">
      <div className="w-full max-w-xl rounded-lg border border-border bg-bg-1 p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-fg">Keyboard shortcuts</h2>
          <Kbd>{prettyKeys('mod+k')} for all</Kbd>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          {[...groups.entries()].map(([group, cmds]) => (
            <div key={group}>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-mute">{group}</div>
              <ul className="flex flex-col gap-1">
                {cmds.map((c) => (
                  <li key={c.id} className="flex items-center justify-between text-[12px]">
                    <span className="text-fg-dim">{c.label}</span>
                    {c.keys?.[0] ? (
                      <Kbd>{prettyKeys(c.keys[0])}</Kbd>
                    ) : (
                      <span className="text-[10px] text-fg-mute">{prettyKeys('mod+k')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </DialogShell>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded bg-bg-3 px-1.5 py-0.5 text-[10px] text-fg-mute">{children}</kbd>;
}
