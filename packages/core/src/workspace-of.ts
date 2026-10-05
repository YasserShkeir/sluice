// SPDX-License-Identifier: Apache-2.0
/**
 * Whose account does a replay belong to? The workspace a request's own
 * arguments name, read off the store — so the runner and the MCP server pick
 * the session of THAT workspace instead of whichever one an extractor listed
 * first.
 */
import type { SqliteStore } from './store.js';
import type { ReplayAction, Session } from './types.js';

/** The workspace a stored container belongs to, if the store knows it. */
export function containerWorkspace(store: SqliteStore, containerId: string): string | undefined {
  const row = store.db.prepare('SELECT workspace_id AS w FROM containers WHERE id = ?').get(containerId) as
    | { w: string }
    | undefined;
  return row?.w;
}

/**
 * The workspace a replay's arguments already imply: a param of kind `containerId`
 * holds a container id, and a container row carries its workspace — exact, with
 * no heuristics on key names.
 */
export function workspaceOfParams(
  store: SqliteStore,
  action: Pick<ReplayAction, 'params'>,
  params: Record<string, string> | undefined,
): string | undefined {
  if (!params) return undefined;
  return workspaceOfValues(store, action.params.filter((p) => p.kind === 'containerId').map((p) => params[p.name] ?? ''));
}

/**
 * The workspace of the first value that is a known container id. For flow
 * templates, whose params declare no kinds; a container id is unique in the
 * store, so a hit is still exact.
 */
export function workspaceOfValues(store: SqliteStore, values: Iterable<string>): string | undefined {
  for (const v of values) {
    if (!v) continue;
    const owner = containerWorkspace(store, v);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

/**
 * Stand-in for apps with no credential provider (fast.com, OLX, Gmail). Empty
 * `values` by construction — never a Keychain prompt, never a secret on the
 * wire.
 */
export function anonymousSession(adapterId: string): Session {
  return {
    id: '',
    adapterId,
    label: adapterId,
    credentials: { kind: 'none', values: {}, injection: {} },
    discoveredAt: 0,
    source: 'manual',
  };
}
