// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A path router, hand-rolled, for the handful of routes this app has.
 *
 * PATH and not hash, and that is forced rather than chosen: the runner hands the
 * session token to the dev UI as `#k=<token>` (see ws.ts), which the app reads
 * once and strips. A hash router would own that slot and either eat the token or
 * be corrupted by it. The runner already falls back to index.html for unknown
 * paths, so real URLs deep-link correctly.
 *
 * Hand-rolled rather than react-router because there are six flat routes, no
 * nested layouts, no loaders, and no data fetching in the route layer — the
 * store is a live WebSocket subscription that outlives navigation. What a router
 * library would add here is 20 KB and an opinion about the hash we cannot afford.
 *
 * `useSyncExternalStore` rather than useState + an effect: navigation can happen
 * during render (a redirect), and this keeps every subscriber on one consistent
 * location per commit instead of tearing between them.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type Route =
  | { name: 'overview' }
  | { name: 'traffic' }
  | { name: 'apps' }
  | { name: 'app'; id: string }
  | { name: 'explore'; containerId?: string }
  | { name: 'replay'; actionId?: string }
  | { name: 'data' };

const listeners = new Set<() => void>();
let current = parse(pathname());

function pathname(): string {
  return typeof location === 'undefined' ? '/' : location.pathname;
}

/** Map a pathname to a route. Anything unrecognised lands on the overview. */
export function parse(path: string): Route {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const [head, second] = parts;
  if (head === undefined) return { name: 'overview' };
  if (head === 'traffic') return { name: 'traffic' };
  if (head === 'data') return { name: 'data' };
  // The container id is in the PATH so a view of one mailbox label is a real,
  // shareable URL — the explorer is the one screen where "look at this" means a
  // specific place rather than a mode.
  // The action id in the path, so a prepared call is a link someone can send to
  // themselves. Params stay OUT of the URL: they are arguments to a live call
  // against a real account, and a URL is the one place a value gets
  // shoulder-surfed, pasted into a chat, and kept in history.
  if (head === 'replay') {
    return second === undefined ? { name: 'replay' } : { name: 'replay', actionId: safeDecode(second) };
  }
  if (head === 'explore') {
    return second === undefined ? { name: 'explore' } : { name: 'explore', containerId: safeDecode(second) };
  }
  if (head === 'apps') {
    // decodeURIComponent so an adapter id with a character that needs escaping
    // still resolves; ids are ours, but the URL is the user's to type.
    return second === undefined ? { name: 'apps' } : { name: 'app', id: safeDecode(second) };
  }
  return { name: 'overview' };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a malformed escape is not worth a blank page
  }
}

/** The canonical path for a route — the single place URLs are constructed. */
export function href(route: Route): string {
  switch (route.name) {
    case 'overview':
      return '/';
    case 'traffic':
      return '/traffic';
    case 'apps':
      return '/apps';
    case 'app':
      return `/apps/${encodeURIComponent(route.id)}`;
    case 'explore':
      return route.containerId === undefined
        ? '/explore'
        : `/explore/${encodeURIComponent(route.containerId)}`;
    case 'replay':
      return route.actionId === undefined ? '/replay' : `/replay/${encodeURIComponent(route.actionId)}`;
    case 'data':
      return '/data';
  }
}

function emit(): void {
  for (const l of listeners) l();
}

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const path = href(route);
  if (path === pathname()) return;
  // Preserve the hash. The token lives there on first load and ws.ts strips it
  // itself; throwing it away here would log the dev UI out on the first click.
  const url = `${path}${location.search}${location.hash}`;
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  current = parse(path);
  emit();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    current = parse(pathname());
    emit();
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const snapshot = (): Route => current;

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Props for an anchor that navigates without a reload.
 *
 * A real `<a href>` rather than a click handler on a div, so middle-click,
 * cmd-click and "copy link address" all behave — the things people do without
 * thinking, and the things a click handler silently breaks.
 */
export function useLink(): (route: Route) => {
  href: string;
  onClick: (e: React.MouseEvent) => void;
} {
  return useCallback((route: Route) => {
    return {
      href: href(route),
      onClick: (e: React.MouseEvent) => {
        // Let the browser handle anything that means "open elsewhere".
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(route);
      },
    };
  }, []);
}
