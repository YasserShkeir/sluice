// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppCatalogEntry } from '@sluice/core';
import { useLink } from '../router.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { cn } from '../ui/cn.js';

/**
 * The launcher: every interceptable app + how far it's been "built" locally.
 *
 * A card is a LINK to that app's page, not a filter toggle. The card can only
 * ever show four ticks and a count; "what did Sluice collect for this app, and
 * what can I do with it" needs room, so it gets a page. Scoping the traffic
 * table is still one click, but it is now the card's secondary action rather
 * than its only one — a real `<a>` so middle-click and copy-link work.
 */
export function AppCatalog({
  apps,
  filteredId,
  onFilter,
}: {
  apps: AppCatalogEntry[];
  /** the app the traffic table is currently scoped to, or '' */
  filteredId?: string;
  onFilter: (id: string) => void;
}) {
  return (
    <div className="p-4">
      <div className="mb-4 max-w-2xl">
        <h1 className="m-0 text-[18px] font-semibold text-fg">Apps &amp; sites</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-dim">
          Each card shows how far an app has been taken locally — from a capture adapter, to
          captured data, to a materialized DB, to MCP tools. Open one to see its MCP tools, replay
          actions and the hosts it intercepts.
        </p>
      </div>
      {/* As a panel this rendered nothing until the first catalog broadcast
          landed. As a page, nothing is indistinguishable from a broken page. */}
      {apps.length === 0 ? (
        <p className="text-[12px] text-fg-mute">Waiting for the app catalog…</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {apps.map((a) => (
            <AppCard key={a.id} app={a} filtered={a.id === filteredId} onFilter={onFilter} />
          ))}
        </div>
      )}
    </div>
  );
}

function AppCard({
  app,
  filtered,
  onFilter,
}: {
  app: AppCatalogEntry;
  filtered: boolean;
  onFilter: (id: string) => void;
}) {
  const link = useLink();
  const built = app.build.adapter;
  const body = (
    <>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[13.5px] font-medium text-fg">{app.displayName}</span>
        {app.capturing ? (
          <Badge className="border-[#2c4a30] text-[#9ad0a0]">● capturing</Badge>
        ) : built ? (
          <Badge>idle</Badge>
        ) : (
          <Badge className="text-fg-mute">planned</Badge>
        )}
      </div>

      <div className="mb-2 text-[11.5px] text-fg-mute">
        {built
          ? `${app.stats.endpoints} endpoints · ${app.stats.containers} channels · ${app.stats.actors} users · ${app.stats.items} messages`
          : 'adapter not built yet'}
      </div>

      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[11.5px]">
        <ChecklistItem on={app.build.adapter} label="Adapter" />
        <ChecklistItem on={app.build.data} label="Captured data" />
        <ChecklistItem on={app.build.db} label="Local DB" />
        <ChecklistItem
          on={app.build.mcp}
          label={`MCP tools${app.mcpTools.length > 0 ? ` (${app.mcpTools.length})` : ''}`}
        />
      </ul>
    </>
  );

  return (
    <div
      className={cn(
        'flex flex-col rounded-lg border bg-bg-1 transition-colors',
        filtered ? 'border-accent' : 'border-border',
        built ? '' : 'opacity-80',
      )}
    >
      {built ? (
        <a
          className="block flex-1 p-3 text-inherit no-underline hover:bg-bg-2/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          {...link({ name: 'app', id: app.id })}
        >
          {body}
        </a>
      ) : (
        <div className="flex-1 p-3">{body}</div>
      )}
      {built ? (
        <div className="border-t border-border px-3 py-2">
          <Button
            variant={filtered ? 'primary' : 'ghost'}
            size="sm"
            aria-pressed={filtered}
            onClick={() => onFilter(app.id)}
            title={filtered ? 'Clear the traffic filter' : 'Scope the traffic table to this app'}
            className="w-full"
          >
            {filtered ? '✓ filtering traffic' : 'Filter traffic'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ChecklistItem({ on, label }: { on: boolean; label: string }) {
  return (
    <li className={cn('flex items-center gap-1.5', on ? 'text-fg' : 'text-fg-mute')}>
      <span className="w-3 text-center" aria-hidden="true">
        {on ? '✓' : '○'}
      </span>
      {label}
    </li>
  );
}
