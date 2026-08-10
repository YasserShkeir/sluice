// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-issuing a captured call, from the browser.
 *
 * The whole path already existed and had no sender: the runner has handled
 * `replay.run` since the protocol was written, the safety rails below it refuse
 * writes and meter the rate, and `sluice replay` drives it from the CLI. The
 * page was the missing half, and `replay.error` was an explicit no-op in the
 * client — so a refusal, which is the interesting outcome, reached nobody.
 *
 * ## What the form is generated from
 *
 * `AppCatalogReplayAction`, off the `apps` frame. Nothing here knows what Slack
 * or Gmail is: a param has a name, a kind, a label, a default and a required
 * flag, and that is enough to render a field. An adapter that adds an action
 * gets a form for free, which is the point — a hand-written form per app would
 * be stale the first time an adapter changed.
 *
 * ## Why the rate meter is server-reported
 *
 * The budget is a token bucket in the RUNNER, shared with `sluice sync`, the MCP
 * tools and the CLI drainer. A meter counting this page's own clicks would
 * under-report every time anything else replayed, and would read as "plenty
 * left" right up to the refusal.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppCatalogEntry, AppCatalogReplayAction } from '@sluice/core';
import { navigate, useLink } from '../router.js';
import { sendReplayRun } from '../ws.js';
import type { ReplayRecord, StoreState } from '../ws.js';
import { fetchFlowTemplates, type FlowTemplateSummary } from '../api.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Badge } from '../ui/badge.js';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable.js';

interface Props {
  /** From the URL, so a prepared call is a link someone can send to themselves. */
  actionId?: string;
  apps: AppCatalogEntry[];
  replays: ReplayRecord[];
  budget: StoreState['replayBudget'];
}

/** One action, with the app it came from — the catalog splits them apart. */
interface Entry {
  app: AppCatalogEntry;
  action: AppCatalogReplayAction;
}

export function ReplayPage({ actionId, apps, replays, budget }: Props) {
  const entries = useMemo<Entry[]>(
    () => apps.flatMap((app) => app.replayActions.map((action) => ({ app, action }))),
    [apps],
  );
  const selected = useMemo(
    () => entries.find((e) => e.action.id === actionId),
    [entries, actionId],
  );

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="22" minSize="14">
        <ActionList entries={entries} selectedId={actionId} />
        <FlowTemplatesPanel />
      </ResizablePanel>
      <ResizableHandle orientation="horizontal" />
      <ResizablePanel defaultSize="40" minSize="24">
        {selected === undefined ? (
          <Empty>
            {entries.length === 0
              ? 'No app exposes a replay action. Adapters declare them with listReplayActions().'
              : 'Pick an action on the left. Multi-step templates list below — replay those via CLI (`sluice replay --flow`) or MCP `sluice_replay_flow`.'}
          </Empty>
        ) : (
          <ActionForm key={selected.action.id} entry={selected} budget={budget} />
        )}
      </ResizablePanel>
      <ResizableHandle orientation="horizontal" />
      <ResizablePanel defaultSize="38" minSize="20">
        <Worklist replays={replays} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

// ── The action list ──────────────────────────────────────────────────────────────

function ActionList({ entries, selectedId }: { entries: Entry[]; selectedId?: string }) {
  const link = useLink();
  const byApp = useMemo(() => {
    const out = new Map<string, Entry[]>();
    for (const e of entries) out.set(e.app.id, [...(out.get(e.app.id) ?? []), e]);
    return [...out.values()];
  }, [entries]);

  return (
    <div className="h-full overflow-auto">
      {byApp.map((group) => {
        const app = group[0]?.app;
        if (app === undefined) return null;
        return (
          <section key={app.id}>
            <h2 className="sticky top-0 bg-bg-1 px-2.5 py-1.5 text-[12px] font-medium text-fg">
              {app.displayName}
            </h2>
            {group.map(({ action }) => (
              <a
                key={action.id}
                {...link({ name: 'replay', actionId: action.id })}
                aria-current={action.id === selectedId ? 'page' : undefined}
                className={[
                  'flex items-center gap-2 px-2.5 py-1.5 pl-4 text-[12px] no-underline transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                  action.id === selectedId
                    ? 'bg-accent-dim text-fg'
                    : 'text-fg-dim hover:bg-bg-3 hover:text-fg',
                ].join(' ')}
              >
                <span className="truncate">{action.label}</span>
                <span className="ml-auto shrink-0 text-[10.5px] uppercase text-fg-mute">
                  {action.method}
                </span>
              </a>
            ))}
          </section>
        );
      })}
    </div>
  );
}

// ── The generated form ───────────────────────────────────────────────────────────

/**
 * A field's starting value: the adapter's own default, or empty.
 *
 * `default` used to be dropped by the catalog, which meant an action declaring
 * `limit=200` arrived with an empty box and a user guessing. It travels now, and
 * this is the only place it is read.
 */
export function initialValues(action: AppCatalogReplayAction): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of action.params) out[p.name] = p.default ?? '';
  return out;
}

function ActionForm({ entry, budget }: { entry: Entry; budget: StoreState['replayBudget'] }) {
  const { app, action } = entry;
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(action));

  // Required params with nothing in them. Checked here as well as in the
  // adapter because the adapter's failure is an opaque 404 from the service —
  // Gmail's request builder throws by name precisely because a blank path
  // segment produces `/sync/u//i/bv`, which nothing can diagnose from.
  const missing = action.params
    .filter((p) => p.required && (values[p.name] ?? '').trim() === '')
    .map((p) => p.label ?? p.name);

  const exhausted = budget !== undefined && budget.tokens < 1;

  const run = useCallback(() => {
    // Blank optional params are DROPPED rather than sent empty. An adapter
    // reading `?cursor=` is not the same as one reading no cursor at all, and
    // the protocol caps the map at 64 keys.
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim() !== '') params[k] = v;
    sendReplayRun(action.id, `${app.displayName} · ${action.label}`, params);
  }, [action.id, action.label, app.displayName, values]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-2.5 py-1.5">
        <span className="text-[12.5px] font-medium text-fg">{action.label}</span>
        <Badge>{action.method}</Badge>
        <span className="ml-auto">
          <RateMeter budget={budget} />
        </span>
      </div>

      <form
        className="flex-1 overflow-auto p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length === 0 && !exhausted) run();
        }}
      >
        {action.params.length === 0 ? (
          <p className="text-[12px] text-fg-mute">
            This action takes no parameters — it is one of the “structure” calls the global Sync
            button issues.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {action.params.map((p) => (
              // An explicit htmlFor/id pair rather than a wrapping <label>: the
              // field is a component, not a bare <input>, so wrapping associates
              // them for a sighted reader and for nothing else.
              <div key={p.name} className="flex flex-col gap-1">
                <label
                  htmlFor={`param-${action.id}-${p.name}`}
                  className="flex items-baseline gap-1.5 text-[12px] text-fg-dim"
                >
                  {/* The adapter's label when it gave one — it is written for a
                      person, and the param NAME is written for a URL. */}
                  {p.label ?? p.name}
                  {p.required ? <span className="text-danger">*</span> : null}
                  <span className="text-[10.5px] text-fg-mute">{p.kind}</span>
                </label>
                <Input
                  id={`param-${action.id}-${p.name}`}
                  value={values[p.name] ?? ''}
                  // `number` gets a numeric field; every other kind is free
                  // text. `containerId` and `cursor` are opaque strings that
                  // come from a previous response, and a picker built from the
                  // local store would offer only what happens to be captured.
                  type={p.kind === 'number' ? 'number' : 'text'}
                  placeholder={p.kind === 'containerId' ? 'a container id from Explore' : ''}
                  onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 flex items-center gap-2">
          <Button type="submit" disabled={missing.length > 0 || exhausted}>
            Run
          </Button>
          {missing.length > 0 ? (
            <span className="text-[11.5px] text-fg-mute">Needs {missing.join(', ')}</span>
          ) : null}
          {exhausted ? (
            <span className="text-[11.5px] text-fg-mute">Rate budget spent — see the meter.</span>
          ) : null}
        </div>

        <p className="mt-4 border-t border-border pt-3 text-[11.5px] leading-relaxed text-fg-mute">
          Replays are reads only. The runner refuses mutating verbs and a denylist of
          write/admin operations below this page, so a request built here cannot post, invite
          or delete — and it goes out as your real session, so it is a real call to the service.
        </p>
      </form>
    </div>
  );
}

// ── The rate meter ───────────────────────────────────────────────────────────────

/**
 * Tokens left, and a live countdown when there are none.
 *
 * The countdown is driven off `retryAfterMs` as a DURATION rather than a wall
 * time, because the page's clock is not the runner's; ticking locally from a
 * duration is right regardless of the skew between them.
 */
function RateMeter({ budget }: { budget: StoreState['replayBudget'] }) {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (budget === undefined || budget.retryAfterMs <= 0) {
      setRemaining(0);
      return;
    }
    setRemaining(budget.retryAfterMs);
    const started = Date.now();
    const id = setInterval(() => {
      setRemaining(Math.max(0, budget.retryAfterMs - (Date.now() - started)));
    }, 250);
    return () => clearInterval(id);
  }, [budget]);

  // Undefined is not zero. A runner too old to report a budget renders nothing
  // here; a budget of zero renders "spent", and those must not look alike.
  if (budget === undefined) return null;

  const share = budget.capacity > 0 ? budget.tokens / budget.capacity : 0;
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-fg-mute" title="Replay rate budget">
      <span className="relative block h-1.5 w-16 overflow-hidden rounded-full bg-bg-3">
        <span
          className={`absolute inset-y-0 left-0 ${share > 0.25 ? 'bg-accent' : 'bg-danger'}`}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </span>
      <span className="tabular-nums">
        {budget.tokens}/{budget.capacity}
      </span>
      {remaining > 0 ? (
        <span className="tabular-nums text-danger">retry in {Math.ceil(remaining / 1000)}s</span>
      ) : null}
    </span>
  );
}

// ── The worklist ─────────────────────────────────────────────────────────────────

/**
 * What this page has asked for, newest first.
 *
 * Every replay in the runner is serialized behind one promise chain — including
 * `sluice sync` and the MCP tools — so a click can sit pending behind work this
 * page did not start. Without a list that reads as a dead button.
 */
function Worklist({ replays }: { replays: ReplayRecord[] }) {
  if (replays.length === 0) {
    return <Empty>Nothing replayed from this page yet.</Empty>;
  }
  return (
    <div className="h-full overflow-auto">
      {replays.map((r) => (
        <article key={r.requestId} className="border-b border-border px-2.5 py-2">
          <div className="flex items-baseline gap-2">
            <StateDot state={r.state} />
            <span className="truncate text-[12px] text-fg">{r.label}</span>
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-fg-mute">
              {r.finishedAt === undefined
                ? 'running…'
                : `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s`}
            </span>
          </div>
          {Object.keys(r.params).length > 0 ? (
            <div className="mt-0.5 truncate text-[11px] text-fg-mute">
              {Object.entries(r.params)
                .map(([k, v]) => `${k}=${v}`)
                .join('  ')}
            </div>
          ) : null}
          {r.state === 'error' ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-[11.5px] text-danger">
              {r.error}
            </p>
          ) : null}
          {r.state === 'ok' ? (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-mute">
              <span>HTTP {r.status ?? '—'}</span>
              <span>
                {r.entities ?? 0} {r.entities === 1 ? 'entity' : 'entities'}
              </span>
              <button
                type="button"
                onClick={() => navigate({ name: 'traffic' })}
                className="text-fg-dim underline-offset-2 hover:text-accent hover:underline"
              >
                see it in Traffic
              </button>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function StateDot({ state }: { state: ReplayRecord['state'] }) {
  const colour =
    state === 'ok' ? 'bg-ok' : state === 'error' ? 'bg-danger' : 'bg-fg-mute animate-pulse';
  // `role="img"` so the label is actually announced. A bare <span> carrying
  // aria-label announces nothing — the attribute is ignored on a generic
  // element, which makes the dot's state invisible to a screen reader while
  // looking, in the source, as though it had been handled.
  return (
    <span
      role="img"
      aria-label={state}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${colour}`}
    />
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-4 text-[12px] text-fg-mute">{children}</p>;
}

// ── Learned multi-step templates (read-only picker) ──────────────────────────────

function FlowTemplatesPanel() {
  const [templates, setTemplates] = useState<FlowTemplateSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchFlowTemplates({ limit: 50 })
      .then((r) => {
        if (!cancelled) setTemplates(r.templates);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="border-t border-border">
      <h2 className="sticky top-0 bg-bg-1 px-2.5 py-1.5 text-[12px] font-medium text-fg">
        Learned flows
      </h2>
      {error ? (
        <p className="px-2.5 py-1 text-[11px] text-fg-mute">{error}</p>
      ) : templates.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[11px] text-fg-mute">
          None yet. Capture traffic, run <code className="font-mono">sluice learn-flows</code>, or open Traffic → Group flows.
        </p>
      ) : (
        <ul className="max-h-48 overflow-auto">
          {templates.map((t) => (
            <li
              key={t.id}
              className="border-t border-border/60 px-2.5 py-1.5 text-[11px] text-fg-dim"
              title={`id=${t.id}`}
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-fg">{t.primaryKey}</span>
                <Badge className="ml-auto shrink-0">{t.adapterId}</Badge>
              </div>
              <div className="text-fg-mute">
                {t.stepCount} steps · {t.sampleCount} sample{t.sampleCount === 1 ? '' : 's'}
                {t.flowParams.length > 0
                  ? ` · params ${t.flowParams.map((p) => p.name + (p.required ? '*' : '')).join(', ')}`
                  : ''}
              </div>
              <div className="mt-0.5 font-mono text-[10px] text-fg-mute">
                sluice replay --flow {t.id}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
