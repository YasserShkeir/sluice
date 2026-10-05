// SPDX-License-Identifier: Apache-2.0
/**
 * Reading a replay action's params inside `buildReplayRequest`: the caller's
 * value, else the action's declared default.
 */
import type { ReplayAction } from '@sluice/core';

/**
 * The caller's value for `name`, else the action's declared default. An empty
 * string the caller passed is KEPT, not defaulted. Only own keys count, so a
 * param named `constructor` never reads `Object.prototype`.
 */
export function actionParam(
  action: ReplayAction,
  params: Record<string, string>,
  name: string,
): string | undefined {
  if (Object.hasOwn(params, name)) return params[name];
  return action.params.find((p) => p.name === name)?.default;
}

/**
 * {@link actionParam}, but a missing or empty value THROWS by name rather than
 * sending `undefined` or `''`. `hint` is appended to the message verbatim, e.g.
 * `' — it is a required body field, not an optional one'`.
 *
 * @example
 * const videoId = requireActionParam(action, params, 'videoId');
 */
export function requireActionParam(
  action: ReplayAction,
  params: Record<string, string>,
  name: string,
  hint = '',
): string {
  const value = actionParam(action, params, name);
  if (value === undefined || value === '') {
    throw new Error(`Replay action "${action.id}" needs a value for "${name}"${hint}.`);
  }
  return value;
}

/** `{boardId}` in a urlTemplate. Module-private: an exported `/g` regex carries `lastIndex` state. */
const PATH_PARAM = /\{(\w+)\}/g;

/**
 * Substitute `{name}` path params into `action.urlTemplate`, percent-encoded,
 * and report which names were path params so the caller keeps them out of the
 * query string. `resolve` defaults to {@link actionParam}.
 *
 * Substituted BEFORE the URL is constructed: `new URL('…/boards/{boardId}/cards')`
 * percent-encodes the braces into a literal `/boards/%7BboardId%7D/cards`, which
 * 404s. A missing path param throws, naming it, instead of building
 * `…/boards//cards`. The runner's `onReplayRun` passes the UI's params with no
 * `required` check, so this is the only layer that can report it. `.` and `..`
 * throw too: a URL parser resolves dot segments, which climb out of the
 * template's path. Most builders want {@link actionUrl}, which adds the query.
 */
export function fillPathParams(
  action: ReplayAction,
  params: Record<string, string>,
  resolve: (name: string) => string | undefined = (name) => actionParam(action, params, name),
): { url: string; pathParams: Set<string> } {
  const pathParams = new Set<string>();
  const url = action.urlTemplate.replace(PATH_PARAM, (_match, name: string) => {
    pathParams.add(name);
    const value = resolve(name);
    if (value === undefined || value === '') {
      throw new Error(
        `Replay action "${action.id}" needs a value for "${name}" — it is a path segment, not a query param.`,
      );
    }
    // encodeURIComponent leaves these intact and the URL parser then resolves
    // them: `{storeId}='..'` would turn /api/stores/../items into /api/items.
    if (value === '.' || value === '..') {
      throw new Error(
        `Replay action "${action.id}" needs a real value for "${name}" — "." and ".." are not path segments.`,
      );
    }
    return encodeURIComponent(value);
  });
  return { url, pathParams };
}

/**
 * The replay URL: path params substituted by {@link fillPathParams}, then every
 * other DECLARED param with a non-empty value (via {@link actionParam}) set in
 * the query. A caller's undeclared keys are dropped.
 *
 * @example
 * return { method: action.method, url: actionUrl(action, params), headers };
 */
export function actionUrl(action: ReplayAction, params: Record<string, string>): string {
  const { url, pathParams } = fillPathParams(action, params);
  const u = new URL(url);
  for (const p of action.params) {
    if (pathParams.has(p.name)) continue;
    const v = actionParam(action, params, p.name);
    if (v !== undefined && v !== '') u.searchParams.set(p.name, v);
  }
  return u.toString();
}
