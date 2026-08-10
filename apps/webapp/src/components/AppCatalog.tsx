// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AppCatalogEntry } from '@sluice/core';
import { useLink } from '../router.js';

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
    <div className="catalog">
      <div className="catalog-head">
        <h1>Apps &amp; sites</h1>
        <p>
          Each card shows how far an app has been taken locally — from a capture adapter, to
          captured data, to a materialized DB, to MCP tools. Open one to see its MCP tools, replay
          actions and the hosts it intercepts.
        </p>
      </div>
      {/* As a panel this rendered nothing until the first catalog broadcast
          landed. As a page, nothing is indistinguishable from a broken page. */}
      {apps.length === 0 ? (
        <p className="muted">Waiting for the app catalog…</p>
      ) : (
        <div className="catalog-grid">
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
      <div className="app-card-top">
        <span className="app-name">{app.displayName}</span>
        {app.capturing ? (
          <span className="badge badge-live">● capturing</span>
        ) : built ? (
          <span className="badge badge-idle">idle</span>
        ) : (
          <span className="badge badge-planned">planned</span>
        )}
      </div>

      <div className="app-stats">
        {built
          ? `${app.stats.endpoints} endpoints · ${app.stats.containers} channels · ${app.stats.actors} users · ${app.stats.items} messages`
          : 'adapter not built yet'}
      </div>

      <ul className="build-checklist">
        <ChecklistItem on={app.build.adapter} label="Adapter" />
        <ChecklistItem on={app.build.data} label="Captured data" />
        <ChecklistItem on={app.build.db} label="Local DB" />
        <ChecklistItem on={app.build.mcp} label={`MCP tools${app.mcpTools.length > 0 ? ` (${app.mcpTools.length})` : ''}`} />
      </ul>
    </>
  );

  return (
    <div className={`app-card${built ? '' : ' app-card--planned'}${filtered ? ' app-card--selected' : ''}`}>
      {built ? (
        <a className="app-card-link" {...link({ name: 'app', id: app.id })}>
          {body}
        </a>
      ) : (
        <div className="app-card-link">{body}</div>
      )}
      {built ? (
        <div className="app-card-actions">
          <button
            type="button"
            className="app-card-filter"
            aria-pressed={filtered}
            onClick={() => onFilter(app.id)}
            title={filtered ? 'Clear the traffic filter' : 'Scope the traffic table to this app'}
          >
            {filtered ? '✓ filtering traffic' : 'Filter traffic'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChecklistItem({ on, label }: { on: boolean; label: string }) {
  return (
    <li className={on ? 'on' : 'off'}>
      <span className="tick">{on ? '✓' : '○'}</span> {label}
    </li>
  );
}
