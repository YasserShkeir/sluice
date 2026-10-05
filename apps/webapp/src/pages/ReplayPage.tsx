// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-issuing a captured call, from the browser.
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
 * The budget is a token bucket in the RUNNER process, shared by this page, flows
 * and sync in that process (sluice-mcp and each CLI run have their own). A meter
 * counting this page's own clicks would under-report every time anything else
 * replayed, and would read as "plenty left" right up to the refusal.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import type { AppCatalogEntry, AppCatalogReplayAction, RedactedSession } from '@sluice/core';
import { groupBy } from '../collections.js';
import { navigate, useLink } from '../router.js';
import { sendFlowRun, sendReplayRun } from '../ws.js';
import type { ReplayRecord, StoreState } from '../ws.js';
import { fetchFlowTemplates, type FlowTemplateSummary } from '../api.js';
import { useAsync } from '../use-async.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Badge } from '../ui/badge.js';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable.js';

interface Props {
  /** From the URL, so a prepared call is a link someone can send to themselves. */
  actionId?: string;
  apps: AppCatalogEntry[];
  /** Every session the runner announced; each form offers its own app's. */
  sessions: RedactedSession[];
  replays: ReplayRecord[];
  budget: StoreState['replayBudget'];
}

/** One action, with the app it came from — the catalog splits them apart. */
interface Entry {
  app: AppCatalogEntry;
  action: AppCatalogReplayAction;
}

export function ReplayPage({ actionId, apps, sessions, replays, budget }: Props) {
  const entries = useMemo<Entry[]>(
    () => apps.flatMap((app) => app.replayActions.map((action) => ({ app, action }))),
    [apps],
  );
  const selected = useMemo(
    () => entries.find((e) => e.action.id === actionId),
    [entries, actionId],
  );
  const [selectedFlow, setSelectedFlow] = useState<FlowTemplateSummary | undefined>();

  return (
    <ResizablePanelGroup orientation="horizontal">
      <ResizablePanel defaultSize="22" minSize="14">
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            <ActionList entries={entries} selectedId={actionId} onPickAction={() => setSelectedFlow(undefined)} />
          </div>
          <div className="max-h-[40%] shrink-0 overflow-auto border-t border-border">
            <FlowTemplatesPanel
              selectedId={selectedFlow?.id}
              onSelect={(t) => {
                setSelectedFlow(t);
                if (actionId) navigate({ name: 'replay' });
              }}
            />
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle orientation="horizontal" />
      <ResizablePanel defaultSize="40" minSize="24">
        {selectedFlow !== undefined ? (
          <FlowRunForm key={selectedFlow.id} tmpl={selectedFlow} sessions={sessions} budget={budget} />
        ) : selected === undefined ? (
          <Empty>
            {entries.length === 0
              ? 'No app exposes a replay action. Adapters declare them with listReplayActions().'
              : 'Pick an action on the left, or a learned multi-step flow below.'}
          </Empty>
        ) : (
          <ActionForm key={selected.action.id} entry={selected} sessions={sessions} budget={budget} />
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

function ActionList({
  entries,
  selectedId,
  onPickAction,
}: {
  entries: Entry[];
  selectedId?: string;
  onPickAction: () => void;
}) {
  const link = useLink();
  const byApp = useMemo(() => [...groupBy(entries, (e) => e.app.id).values()], [entries]);

  return (
    <div>
      {byApp.map((group) => {
        const app = group[0]?.app;
        if (app === undefined) return null;
        return (
          <section key={app.id}>
            <h2 className="sticky top-0 bg-bg-1 px-2.5 py-1.5 text-[12px] font-medium text-fg">
              {app.displayName}
            </h2>
            {group.map(({ action }) => {
              const nav = link({ name: 'replay', actionId: action.id });
              return (
                <a
                  key={action.id}
                  href={nav.href}
                  aria-current={action.id === selectedId ? 'page' : undefined}
                  // The router's handler first: it only prevents the default for
                  // an in-app navigation, so a cmd/ctrl/shift/middle click opens
                  // a new tab and leaves the selected flow alone.
                  onClick={(e) => {
                    nav.onClick(e);
                    if (e.defaultPrevented) onPickAction();
                  }}
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
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

// ── The generated form ───────────────────────────────────────────────────────────

/** A field's starting value: the adapter's own default, or empty. */
export function initialValues(action: AppCatalogReplayAction): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of action.params) out[p.name] = p.default ?? '';
  return out;
}

/** Required params left blank, by their display name. Checked here too because the
 *  adapter's failure is an opaque service 404 (e.g. a blank path segment). */
export function missingRequired(
  params: ReadonlyArray<{ name: string; required?: boolean; label?: string }>,
  values: Record<string, string>,
): string[] {
  return params.filter((p) => p.required && (values[p.name] ?? '').trim() === '').map((p) => p.label ?? p.name);
}

/**
 * The params to send. Blank optional params are DROPPED rather than sent empty:
 * an adapter reading `?cursor=` is not the same as one reading no cursor at all,
 * and the protocol caps the map at 64 keys.
 */
export function nonBlankParams(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v.trim() !== '') out[k] = v;
  return out;
}

/**
 * Which session a run acts as. With one session for the app it is that one;
 * with several the user must pick, because the runner will not guess — a guess
 * is a request sent as the wrong account. A pick that is no longer offered (the
 * socket reconnected without it) counts as no pick. With none, nothing is sent
 * and the runner answers for itself (a credential-free app, or "sign in first").
 */
export function sessionChoice(
  sessions: ReadonlyArray<RedactedSession>,
  adapterId: string,
  picked: string,
): { options: RedactedSession[]; sessionId: string | undefined } {
  const options = sessions.filter((s) => s.adapterId === adapterId);
  if (options.length === 1) return { options, sessionId: options[0]?.id };
  return { options, sessionId: options.some((s) => s.id === picked) ? picked : undefined };
}

/** The session picker, and the pieces of a run that depend on it. */
function useSessionChoice(sessions: RedactedSession[], adapterId: string) {
  const [picked, setPicked] = useState('');
  const { options, sessionId } = sessionChoice(sessions, adapterId, picked);
  const several = options.length > 1;
  return {
    options,
    sessionId,
    picked,
    setPicked,
    /** Blocks Run until an account is chosen among several. */
    unpicked: several && sessionId === undefined,
    /** Appended to the worklist label, so two accounts' runs can be told apart. */
    suffix: several ? ` · as ${options.find((s) => s.id === sessionId)?.label ?? '?'}` : '',
  };
}

function ActionForm({
  entry,
  sessions,
  budget,
}: {
  entry: Entry;
  sessions: RedactedSession[];
  budget: StoreState['replayBudget'];
}) {
  const { app, action } = entry;
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(action));
  const account = useSessionChoice(sessions, app.id);

  const missing = [...(account.unpicked ? ['an account'] : []), ...missingRequired(action.params, values)];
  const exhausted = budget !== undefined && budget.tokens < 1;

  return (
    <div className="flex h-full flex-col">
      <FormHeader title={action.label} badges={<Badge>{action.method}</Badge>} budget={budget} />

      <form
        className="flex-1 overflow-auto p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length > 0 || exhausted) return;
          sendReplayRun(action.id, `${app.displayName} · ${action.label}${account.suffix}`, nonBlankParams(values), account.sessionId);
        }}
      >
        <SessionField id={`session-${action.id}`} account={account} />
        {action.params.length === 0 ? (
          <p className="text-[12px] text-fg-mute">
            This action takes no parameters — it is one of the “structure” calls the global Sync
            button issues.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {action.params.map((p) => (
              // label is for a person, name for a URL; `number` gets a numeric field, other
              // kinds are free text (ids/cursors come from prior responses).
              <ParamField
                key={p.name}
                id={`param-${action.id}-${p.name}`}
                label={p.label ?? p.name}
                required={p.required}
                hint={p.kind}
                value={values[p.name] ?? ''}
                type={p.kind === 'number' ? 'number' : 'text'}
                placeholder={p.kind === 'containerId' ? 'a container id from Explore' : ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
              />
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
          Replays are meant for reads. Below this page the runner refuses mutating verbs, a
          best-effort denylist of write/admin operations and hosts outside the app, and applies a
          rate budget. These rails are heuristics, not a proof a request cannot change anything —
          and it goes out as your real session, so it is a real call to the service.
        </p>
      </form>
    </div>
  );
}

/** A labelled text field: explicit htmlFor/id (the field is a component, so wrapping would not
 *  associate them); `required` only draws the asterisk, since native required would change submit. */
function ParamField({
  id,
  label,
  required,
  hint,
  ...inputProps
}: Omit<ComponentProps<typeof Input>, 'required' | 'id'> & {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-[12px] text-fg-dim">
        {label}
        {required ? <span className="text-danger">*</span> : null}
        {hint ? <span className="text-[10.5px] text-fg-mute">{hint}</span> : null}
      </label>
      <Input id={id} {...inputProps} />
    </div>
  );
}

/** Which account to act as — shown only when the app has more than one. */
function SessionField({ id, account }: { id: string; account: ReturnType<typeof useSessionChoice> }) {
  const { options, picked, setPicked } = account;
  if (options.length < 2) return null;
  return (
    <div className="mb-3 flex flex-col gap-1">
      <label htmlFor={id} className="flex items-baseline gap-1.5 text-[12px] text-fg-dim">
        Account
        <span className="text-danger">*</span>
        <span className="text-[10.5px] text-fg-mute">{options.length} signed-in sessions</span>
      </label>
      <select
        id={id}
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className="h-7 w-full rounded border border-border-2 bg-bg px-2 font-mono text-[12.5px] text-fg outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        <option value="">choose which account to act as…</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
            {s.workspaceId ? ` · ${s.workspaceId}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function FormHeader({
  title,
  badges,
  budget,
}: {
  title: string;
  badges: ReactNode;
  budget: StoreState['replayBudget'];
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-1 px-2.5 py-1.5">
      <span className="text-[12.5px] font-medium text-fg">{title}</span>
      {badges}
      <span className="ml-auto">
        <RateMeter budget={budget} />
      </span>
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
            {r.kind === 'flow' ? <Badge className="shrink-0">flow</Badge> : null}
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
            <p className="mt-1 whitespace-pre-wrap wrap-break-word text-[11.5px] text-danger">
              {r.error}
            </p>
          ) : null}
          {r.state === 'ok' && r.kind !== 'flow' ? (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-mute">
              <span>HTTP {r.status ?? '—'}</span>
              <span>
                {r.entities ?? 0} {r.entities === 1 ? 'entity' : 'entities'}
              </span>
              <TrafficLink />
            </div>
          ) : null}
          {r.flowSteps && r.flowSteps.length > 0 ? (
            <ol className="mt-1.5 space-y-0.5 border-l border-border pl-2 text-[10.5px] text-fg-mute">
              {r.flowSteps.map((s) => (
                <li key={s.seq} className="flex flex-wrap gap-x-1.5">
                  <span className="tabular-nums text-fg-dim">[{s.seq}]</span>
                  <span
                    className={
                      s.status === 'ok'
                        ? 'text-ok'
                        : s.status === 'skipped' || s.status === 'soft_fail'
                          ? 'text-fg-mute'
                          : 'text-danger'
                    }
                  >
                    {s.status}
                  </span>
                  <span className="font-mono">
                    {s.method} {s.path}
                  </span>
                  {s.httpStatus != null ? <span>→ {s.httpStatus}</span> : null}
                  {s.detail ? <span className="text-fg-mute">— {s.detail}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
          {r.state === 'ok' && r.kind === 'flow' ? (
            <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-mute">
              {r.flowId ? <span className="font-mono text-[10px]">flow {r.flowId}</span> : null}
              <TrafficLink />
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
  // role=img so aria-label is announced (it is ignored on a generic span).
  return (
    <span
      role="img"
      aria-label={state}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${colour}`}
    />
  );
}

function TrafficLink() {
  return (
    <button
      type="button"
      onClick={() => navigate({ name: 'traffic' })}
      className="text-fg-dim underline-offset-2 hover:text-accent hover:underline"
    >
      see it in Traffic
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="p-4 text-[12px] text-fg-mute">{children}</p>;
}

// ── Learned multi-step templates ─────────────────────────────────────────────────

function FlowTemplatesPanel({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (t: FlowTemplateSummary) => void;
}) {
  const { data, error } = useAsync(() => fetchFlowTemplates({ limit: 50 }), []);
  const templates = data?.templates ?? [];

  return (
    <section>
      <h2 className="sticky top-0 bg-bg-1 px-2.5 py-1.5 text-[12px] font-medium text-fg">
        Learned flows
      </h2>
      {error ? (
        <p className="px-2.5 py-1 text-[11px] text-fg-mute">{error}</p>
      ) : templates.length === 0 ? (
        <p className="px-2.5 py-1.5 text-[11px] text-fg-mute">
          None yet. Capture traffic, run <code className="font-mono">sluice learn-flows</code>, or
          open Traffic → Group flows.
        </p>
      ) : (
        <ul className="overflow-auto">
          {templates.map((t) => {
            const selected = t.id === selectedId;
            return (
              <li key={t.id} className="border-t border-border/60">
                <button
                  type="button"
                  onClick={() => onSelect(t)}
                  aria-current={selected ? 'true' : undefined}
                  className={[
                    'w-full px-2.5 py-1.5 text-left text-[11px] transition-colors',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    selected ? 'bg-accent-dim text-fg' : 'text-fg-dim hover:bg-bg-3 hover:text-fg',
                  ].join(' ')}
                  title={`id=${t.id}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-fg">{t.primaryKey}</span>
                    <Badge className="ml-auto shrink-0">{t.adapterId}</Badge>
                  </div>
                  <div className="text-fg-mute">
                    {t.stepCount} steps · {t.sampleCount} sample
                    {t.sampleCount === 1 ? '' : 's'}
                    {t.flowParams.length > 0
                      ? ` · params ${t.flowParams.map((p) => p.name + (p.required ? '*' : '')).join(', ')}`
                      : ''}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Form + run for one learned flow template. The template is the one the
 * panel already holds; a template re-learned under a new id since is refused by
 * the runner with a `flow.error`, which the worklist shows.
 */
function FlowRunForm({
  tmpl,
  sessions,
  budget,
}: {
  tmpl: FlowTemplateSummary;
  sessions: RedactedSession[];
  budget: StoreState['replayBudget'];
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(tmpl.flowParams.map((p) => [p.name, ''])),
  );
  const account = useSessionChoice(sessions, tmpl.adapterId);

  const missing = [...(account.unpicked ? ['an account'] : []), ...missingRequired(tmpl.flowParams, values)];
  const exhausted = budget !== undefined && budget.tokens < 1;
  const shortBudget = budget !== undefined && budget.tokens < Math.min(tmpl.stepCount, budget.capacity);

  return (
    <div className="flex h-full flex-col">
      <FormHeader
        title={tmpl.primaryKey}
        badges={
          <>
            <Badge>flow</Badge>
            <Badge>{tmpl.adapterId}</Badge>
          </>
        }
        budget={budget}
      />

      <form
        className="flex-1 overflow-auto p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (missing.length > 0 || exhausted) return;
          sendFlowRun(tmpl.id, `Flow · ${tmpl.primaryKey}${account.suffix}`, nonBlankParams(values), account.sessionId);
        }}
      >
        <p className="mb-3 text-[12px] text-fg-mute">
          {tmpl.stepCount} learned step{tmpl.stepCount === 1 ? '' : 's'} · {tmpl.sampleCount} sample
          {tmpl.sampleCount === 1 ? '' : 's'}. Each step pays the same replay rails (method, write
          denylist, host) and rate budget as a single replay.
        </p>
        <SessionField id={`session-flow-${tmpl.id}`} account={account} />
        {tmpl.flowParams.length === 0 ? (
          <p className="text-[12px] text-fg-mute">No flow parameters — run as observed.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {tmpl.flowParams.map((p) => (
              <ParamField
                key={p.name}
                id={`flow-${tmpl.id}-${p.name}`}
                label={p.name}
                required={p.required}
                value={values[p.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                autoComplete="off"
                spellCheck={false}
              />
            ))}
          </div>
        )}
        {missing.length > 0 ? (
          <p className="mt-3 text-[11.5px] text-danger">Required: {missing.join(', ')}</p>
        ) : null}
        {shortBudget && !exhausted ? (
          <p className="mt-3 text-[11.5px] text-fg-mute">
            Budget is low for a {tmpl.stepCount}-step flow — some soft companions may be denied mid-run.
          </p>
        ) : null}
        <div className="mt-4 flex items-center gap-2">
          <Button type="submit" disabled={missing.length > 0 || exhausted}>
            Run flow
          </Button>
          {exhausted ? (
            <span className="text-[11.5px] text-danger">Rate budget exhausted</span>
          ) : null}
        </div>
        <p className="mt-3 font-mono text-[10px] text-fg-mute">
          CLI: sluice replay --flow {tmpl.id}
        </p>
      </form>
    </div>
  );
}
