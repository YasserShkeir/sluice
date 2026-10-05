// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Build ReplayRequests for flow template steps.
 *
 * Combines:
 *   - learned endpoint fingerprint (RequestTemplate / step.request)
 *   - flow params + cross-step binds
 *   - live session credential injection
 *
 * Does not touch the network. Pair with interceptor `runFlowReplay`.
 *
 * F4.4 conformance: refuses denied methods/ops, non-read requests outside the
 * adapter's replay actions, and hosts outside the declared adapter allowlist at
 * build time so a bad template never reaches `runReplay`. Runtime rails in
 * interceptor remain the final gate.
 */

import type {
  Adapter,
  FlowParamSource,
  FlowTemplate,
  FlowTemplateStep,
  ReplayAction,
  ReplayRequest,
  Session,
} from '@sluice/core';
import {
  isReplayMethodAllowed,
  looksLikeDeniedReplay,
  MASK,
  redactText,
  replayHostAllowed,
  replayRequestProbe,
  resolveJsonPath,
  splitUrl,
} from '@sluice/core';
import { makeFaithful } from './faithful.js';

/** Bump when learning rules change; a build refused on an older template says to re-learn. */
export const FLOW_TEMPLATE_VERSION = 2;

/** The part of a {@link ReplayAction} that says which request it sends. */
export type ReadAction = Pick<ReplayAction, 'method' | 'urlTemplate'>;

export interface FlowStepBuildContext {
  params: Record<string, string>;
  /** seq → parsed response body from earlier steps in this run */
  priorResponses: Map<number, unknown>;
  /**
   * Declared adapter hosts (F4.4). The built URL's host must match one of them
   * (exact, or a subdomain of a listed apex / `*.host` entry). Empty refuses
   * every step: there is no build without a host rail.
   */
  allowedHosts: readonly string[];
  /**
   * The owning adapter's replay actions — its vetted read surface. A step whose
   * method is not GET/HEAD is built only when its method and path match one of
   * them; omitted, every such step is refused. {@link flowStepBuilder} fills
   * this and `allowedHosts` from the adapter.
   */
  readActions?: readonly ReadAction[];
}

/** Methods that read by definition; anything else must be a vetted read action. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export class FlowBuildError extends Error {
  constructor(
    readonly code: 'method_not_allowed' | 'operation_not_allowed' | 'host_not_allowed' | 'path_unresolved',
    message: string,
  ) {
    super(message);
    this.name = 'FlowBuildError';
  }
}

/**
 * Build-time rails for one step request (F4.4). Throws {@link FlowBuildError}.
 * Safe to call from tests without opening a socket.
 *
 * Messages name the path only, never the query or body: a built GET carries the
 * live token and injected credentials in its query string, and the message is
 * copied into flow results that MCP and the CLI print.
 */
export function assertFlowStepAllowed(
  req: ReplayRequest,
  opts: { operation?: string; allowedHosts?: readonly string[]; readActions?: readonly ReadAction[] } = {},
): void {
  const method = (req.method || 'GET').toUpperCase();
  if (!isReplayMethodAllowed(method)) {
    throw new FlowBuildError(
      'method_not_allowed',
      `flow build refused: ${method} can only mutate; flow steps may use GET, HEAD or POST.`,
    );
  }

  const { host } = replayRequestProbe(req.url);
  if (!/^https:\/\//i.test(req.url)) {
    throw new FlowBuildError('host_not_allowed', 'flow build refused: flow steps are sent over https only.');
  }
  if (!replayHostAllowed(host, opts.allowedHosts ?? [])) {
    throw new FlowBuildError(
      'host_not_allowed',
      `flow build refused: host "${host}" is outside the adapter's declared hosts.`,
    );
  }

  const pathOnly = urlPathname(req.url);
  const op = opts.operation ?? '';
  if (looksLikeDeniedReplay({ ...req, method }, op)) {
    throw new FlowBuildError(
      'operation_not_allowed',
      redactText(`flow build refused: operation looks write-shaped (${op || pathOnly}).`),
    );
  }

  // The denylist cannot name every write, so a non-read method needs a positive
  // match: one of the adapter's own replay actions, which are reviewed reads.
  if (!isVettedRead({ method, url: req.url }, opts.readActions ?? [])) {
    throw new FlowBuildError(
      'operation_not_allowed',
      redactText(`flow build refused: ${method} ${pathOnly} is not one of the adapter's read actions.`),
    );
  }
}

/**
 * GET/HEAD, or the method of one of `actions` with a path its URL template
 * matches (`{param}` stands for one path segment or part of one). Hosts are left
 * to the host rail: a Slack action on `slack.com` still vouches for the same
 * path on `acme.slack.com`.
 */
export function isVettedRead(req: { method: string; url: string }, actions: readonly ReadAction[]): boolean {
  const method = req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return true;
  const path = urlPathname(req.url);
  return actions.some((a) => a.method.toUpperCase() === method && actionPathPattern(a.urlTemplate).test(path));
}

/** `https://h/1/boards/{boardId}/cards` → /^\/1\/boards\/[^/]+\/cards\/?$/ */
function actionPathPattern(urlTemplate: string): RegExp {
  const path = urlTemplate.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0] || '/';
  const source = path
    .split(/\{[A-Za-z_][A-Za-z0-9_]*\}/)
    .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  return new RegExp(`^${source}/?$`);
}

/** The pathname of an absolute URL, else the text before any query (never the query: it carries credentials). */
const urlPathname = (url: string): string => splitUrl(url).path.split('?')[0] ?? url;

/**
 * Build one step's ReplayRequest, or null when the step cannot be reproduced
 * from what we know (missing required flow param / bind / unreproducible).
 * Throws {@link FlowBuildError} when the built request fails F4.4 rails.
 */
export function buildFlowStepRequest(
  template: FlowTemplate,
  step: FlowTemplateStep,
  session: Session,
  ctx: FlowStepBuildContext,
): ReplayRequest | null {
  if (step.unreproducible) return null;

  // Resolve path placeholders before constructing the URL.
  const resolvedPath = resolveStepPath(step, ctx);
  if (resolvedPath === null) return null;

  const hostGuess = stepHost(step, template);
  const url = new URL(
    resolvedPath.startsWith('http')
      ? resolvedPath
      : `https://${hostGuess}${resolvedPath.startsWith('/') ? '' : '/'}${resolvedPath}`,
  );

  // Collect body/query params from the template + sources.
  const params: Record<string, string> = {};
  const pathParamNames = pathPlaceholderNames(step.path);

  // Learned stable body params first.
  for (const [k, v] of Object.entries(step.request?.bodyParams ?? {})) if (!v.includes(MASK)) params[k] = v;

  for (const [k, src] of Object.entries(step.params ?? {})) {
    // A flowParam path placeholder goes into the URL (resolveStepPath), not body/query.
    if (pathParamNames.has(k) && src.kind === 'flowParam') continue;
    const resolved = resolveParam(src, ctx);
    // A missing flowParam/bind cannot be built faithfully; anything else unresolved
    // (unreproducible, session, masked literal) is omitted.
    if (resolved === undefined && (src.kind === 'flowParam' || src.kind === 'bind')) return null;
    if (resolved !== undefined) params[k] = resolved;
  }

  // Caller flow params fill only keys this step declares and left empty (an
  // unreproducible or redacted value), never new ones such as `_method`, and
  // never pure path placeholders already consumed by resolveStepPath.
  for (const [k, v] of Object.entries(ctx.params)) {
    if (params[k] !== undefined || pathParamNames.has(k)) continue;
    if (step.params?.[k] !== undefined || step.request?.bodyParams[k] !== undefined) params[k] = v;
  }

  // Session injection (token form field, query, cookies, headers). Each map is
  // wire NAME → `values` KEY, and a key with no value sends nothing. Stricter
  // than @sluice/adapter-sdk's injectedHeaders/injectedQuery on purpose: those
  // fall back to the ref as a literal for adapter builders, but a learned
  // template must never put a caller-shaped literal where a credential goes.
  const inj = session.credentials.injection;
  const values = session.credentials.values;
  if (inj.tokenFormField) {
    const tok = sessionValue(values, 'token') ?? sessionValue(values, inj.tokenFormField);
    if (tok) params[inj.tokenFormField] = tok;
  }
  for (const [qName, v] of injected(inj.query, values)) url.searchParams.set(qName, v);

  // Apply non-token params: prefer form body for POST, query for GET.
  const method = (step.method || 'GET').toUpperCase();
  let body: string | undefined;
  const headers: Record<string, string> = {};

  if (method === 'GET' || method === 'HEAD') {
    for (const [k, v] of Object.entries(params)) {
      // Don't duplicate token if already placed via injection.query
      if (!url.searchParams.has(k)) url.searchParams.set(k, v);
    }
  } else {
    // Form body by default — matches Slack and most captured RPC clients.
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) form.set(k, v);
    body = form.toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }

  // Cookie + header injection from the session.
  const cookie = injected(inj.cookies, values).map(([n, v]) => `${n}=${v}`).join('; ');
  if (cookie) headers['cookie'] = cookie;
  for (const [hName, v] of injected(inj.headers, values)) headers[hName] = v;

  const built: ReplayRequest = { method, url: url.toString(), headers, body };
  // Overlay learned identity headers / stable fingerprint.
  const req = step.request ? makeFaithful(built, step.request) : built;

  // Guard: never send unsubstituted path placeholders. Path only in the
  // message — the query of a built GET carries the live credentials.
  if (pathStillHasPlaceholders(req.url)) {
    throw new FlowBuildError(
      'path_unresolved',
      redactText(`flow build refused: path still has unsubstituted placeholders (${urlPathname(req.url)}).`),
    );
  }

  // F4.4 — refuse before the network layer ever sees the request.
  assertFlowStepAllowed(req, {
    operation: step.operation,
    allowedHosts: ctx.allowedHosts,
    readActions: ctx.readActions,
  });

  return req;
}

/**
 * The `build` hook for interceptor `runFlowReplay`, with both of the adapter's
 * rails filled in: its declared hosts and its replay actions (the read surface
 * a non-GET step must match). Taking the adapter, rather than those lists, is
 * what keeps a call site from dropping either one.
 */
export function flowStepBuilder(
  template: FlowTemplate,
  app: Pick<Adapter, 'hosts' | 'listReplayActions'>,
): (
  step: FlowTemplateStep,
  session: Session,
  ctx: Pick<FlowStepBuildContext, 'params' | 'priorResponses'>,
) => ReplayRequest | null {
  const allowedHosts = app.hosts;
  const readActions = app.listReplayActions();
  // An older template keeps building; only a refusal says why it may now fail.
  const stale = template.version < FLOW_TEMPLATE_VERSION;
  return (step, session, ctx) => {
    try {
      return buildFlowStepRequest(template, step, session, {
        params: ctx.params,
        priorResponses: ctx.priorResponses,
        allowedHosts,
        readActions,
      });
    } catch (e) {
      if (stale && e instanceof FlowBuildError) {
        e.message += ` This template was learned by an older Sluice (v${template.version}); re-run \`sluice learn-flows\`.`;
      }
      throw e;
    }
  };
}

// ── internals ────────────────────────────────────────────────────────────────

/** A non-empty session value under an OWN key: a ref such as `constructor` never reaches Object.prototype. */
function sessionValue(values: Record<string, string>, key: string): string | undefined {
  const v = Object.hasOwn(values, key) ? values[key] : undefined;
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** An injection map (wire NAME → `values` KEY) resolved to [name, value] pairs; keys with no value send nothing. */
function injected(map: Record<string, string> | undefined, values: Record<string, string>): Array<[string, string]> {
  return Object.entries(map ?? {}).flatMap(([name, key]): Array<[string, string]> => {
    const v = sessionValue(values, key);
    return v === undefined ? [] : [[name, v]];
  });
}

/**
 * Substitute `{name}` / legacy `:id` path segments from step.params + ctx.params.
 * Returns null when a required placeholder cannot be resolved (soft miss).
 * Throws path_unresolved only after URL assembly if something still slips through.
 */
function resolveStepPath(step: FlowTemplateStep, ctx: FlowStepBuildContext): string | null {
  // Named `{param}` placeholders.
  let path = step.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name: string) => {
    const v = resolvePathPlaceholder(name, step, ctx);
    return v !== undefined ? pathSegment(v) : full;
  });

  // Legacy `:id` / `:id2` — prefer explicit step.params named id/id2/cardId… then
  // first unused flow param that looks like an id key, then ctx.params.id.
  if (/(?:^|\/):\w+(?=\/|$)/.test(path)) {
    const ids = new Set<string>();
    const tryNames = ['id', 'cardId', 'boardId', 'listId', 'memberId', 'channel', 'channelId'];
    for (const name of tryNames) {
      const v = resolvePathPlaceholder(name, step, ctx);
      if (v !== undefined) ids.add(v);
    }
    // Any other resolved step path-ish params.
    for (const [k, src] of Object.entries(step.params ?? {})) {
      if (!/Id$|^id\d*$/i.test(k)) continue;
      const v = resolveParam(src, ctx) ?? ctx.params[k];
      if (v !== undefined) ids.add(v);
    }
    const idValues = [...ids];
    let i = 0;
    path = path.replace(/(?<=^|\/):(\w+)(?=\/|$)/g, (full) => {
      const v = idValues[i++];
      return v !== undefined ? pathSegment(v) : full;
    });
  }

  return pathStillHasPlaceholders(path) ? null : path; // missing path param — cannot build faithfully
}

/**
 * One percent-encoded path segment. `.` and `..` survive encodeURIComponent and
 * a URL parser resolves them, so a caller value could climb out of the learned
 * path (`/1/cards/{cardId}` → `/1/`): refused.
 */
function pathSegment(value: string): string {
  if (value === '.' || value === '..') {
    throw new FlowBuildError('path_unresolved', 'flow build refused: "." and ".." are not path segment values.');
  }
  return encodeURIComponent(value);
}

function resolvePathPlaceholder(
  name: string,
  step: FlowTemplateStep,
  ctx: FlowStepBuildContext,
): string | undefined {
  const src = step.params?.[name];
  if (src) {
    const v = resolveParam(src, ctx);
    if (v !== undefined) return v;
  }
  if (ctx.params[name] !== undefined) return ctx.params[name];
  // Common aliases: callers pass id for {cardId} etc., and cardId for {id}.
  return name.endsWith('Id') ? ctx.params.id : name === 'id' ? ctx.params.cardId : undefined;
}

function pathPlaceholderNames(path: string): Set<string> {
  const names = new Set(Array.from(path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g), (m) => m[1]!));
  if (/(?:^|\/):\w+(?=\/|$)/.test(path)) names.add('id');
  return names;
}

function pathStillHasPlaceholders(urlOrPath: string): boolean {
  const path = urlPathname(urlOrPath);
  return /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(path) || /(?:^|\/):\w+(?=\/|$)/.test(path);
}

function resolveParam(src: FlowParamSource, ctx: FlowStepBuildContext): string | undefined {
  switch (src.kind) {
    case 'literal':
      return src.value.includes(MASK) ? undefined : src.value;
    case 'flowParam':
      return ctx.params[src.name];
    case 'session':
      // Never guessed from the session: a credential goes out only where the
      // adapter's injection declares it (applied after params resolve), not
      // under whatever name a redacted capture param had.
      return undefined;
    case 'bind': {
      const data = ctx.priorResponses.get(src.fromStep);
      if (data === undefined) return undefined;
      // `a.b[0].c` paths from flow-learn.
      return resolveJsonPath(data, src.jsonPath);
    }
    default:
      return undefined;
  }
}

/**
 * Where a relative step path is sent, in order: the host of an absolute path;
 * the fixed host of an adapter with one API origin (kept ahead of the learned
 * host, so a Slack template never pins the workspace subdomain it was learned
 * on); the host learned for the step, when it is a plain `host[:port]`; else
 * `<adapterId>.example`, which the host rail refuses.
 */
function stepHost(step: FlowTemplateStep, template: FlowTemplate): string {
  if (step.path.startsWith('http')) {
    try {
      return new URL(step.path).host;
    } catch {
      /* fall through */
    }
  }
  switch (template.adapterId) {
    case 'slack':
      return 'slack.com';
    case 'trello':
      return 'trello.com';
    case 'gmail':
      return 'mail.google.com';
    case 'fast':
      return 'api.fast.com';
  }
  if (step.host && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(step.host)) return step.host;
  return `${template.adapterId}.example`;
}
