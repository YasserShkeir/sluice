// SPDX-License-Identifier: AGPL-3.0-or-later
/** A KPI tile: one big number over a small label, shared by the overview and an app's page. */

interface KpiProps {
  value: string;
  label: string;
  hint?: string;
  sev?: 'ok' | 'warn' | 'err';
}

export function Kpi({ value, label, hint, sev }: KpiProps) {
  const sevCls =
    sev === 'ok' ? 'text-ok' : sev === 'warn' ? 'text-warn' : sev === 'err' ? 'text-err' : 'text-fg';
  return (
    <div className="min-w-0 rounded-md border border-border bg-bg-1 px-2.5 py-2">
      <div className={`truncate text-[20px] font-semibold leading-tight tabular-nums ${sevCls}`}>{value}</div>
      <div className="mt-0.5 truncate text-[10.5px] uppercase tracking-wide text-fg-dim">
        {label}
        {hint ? <span className="normal-case tracking-normal text-fg-mute"> · {hint}</span> : null}
      </div>
    </div>
  );
}
