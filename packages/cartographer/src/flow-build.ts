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
 * F4.4 conformance: refuses denied methods/ops and hosts outside the declared
 * adapter allowlist at build time so a bad template never reaches `runReplay`.
 * Runtime rails in interceptor remain the final gate.
 */

import type {
  FlowParamSource,
  FlowTemplate,
  FlowTemplateStep,
  ReplayRequest,
  Session,
} from '@sluice/core';
import { looksLikeDeniedOperation } from '@sluice/core';
import { makeFaithful } from './faithful.js';
import type { RequestTemplate } from './faithful.js';

export interface FlowStepBuildContext {
  params: Record<string, string>;
  /** seq → parsed response body from earlier steps in this run */
  priorResponses: Map<number, unknown>;
  /**
   * Resolve a bind path. Default understands `a.b[0].c` style paths used by
   * flow-learn. Injected so tests can stub without pulling interceptor.
   */
  resolvePath?: (data: unknown, path: string) => string | undefined;
  /**
   * Declared adapter hosts (F4.4). When set, the built URL's host must match
   * one of them (exact or parent of a `*.host` style entry / subdomain of an
   * apex). Omitted = no host check at build (runtime still has no host rail).
   */
  allowedHosts?: readonly string[];
}

const MASK = '«redacted»';

/** Verbs that can only mutate — mirror of interceptor ALLOWED_METHODS. */
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

export class FlowBuildError extends Error {
  readonly code:
    | 'method_not_allowed'
    | 'operation_not_allowed'
    | 'host_not_allowed'
    | 'path_unresolved';
  constructor(code: FlowBuildError['code'], message: string) {
    super(message);
    this.name = 'FlowBuildError';
    this.code = code;
  }
}

/**
 * Build-time rails for one step request (F4.4). Throws {@link FlowBuildError}.
 * Safe to call from tests without opening a socket.
 */
export function assertFlowStepAllowed(
  req: ReplayRequest,
  opts: { operation?: string; allowedHosts?: readonly string[] } = {},
): void {
  const method = (req.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new FlowBuildError(
      'method_not_allowed',
      `flow build refused: ${method} can only mutate. Sluice replays reads only.`,
    );
  }

  let pathProbe = req.url;
  let host = '';
  try {
    const u = new URL(req.url);
    pathProbe = `${u.pathname}?${u.searchParams.toString()}`;
    host = u.hostname.toLowerCase();
  } catch {
    /* match raw string */
  }

  const op = opts.operation ?? '';
  if (looksLikeDeniedOperation(op, pathProbe, req.body)) {
    throw new FlowBuildError(
      'operation_not_allowed',
      `flow build refused: operation looks write-shaped (${op || pathProbe}).`,
    );
  }

  if (opts.allowedHosts && opts.allowedHosts.length > 0 && host) {
    if (!hostAllowed(host, opts.allowedHosts)) {
      throw new FlowBuildError(
        'host_not_allowed',
        `flow build refused: host "${host}" is outside the adapter's declared hosts.`,
      );
    }
  }
}

/** True when `host` is listed or is a subdomain of a listed apex / wildcard. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowed) {
    const a = raw.toLowerCase().replace(/^\*\./, '');
    if (!a) continue;
    if (h === a || h.endsWith(`.${a}`)) return true;
  }
  return false;
}

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
  const resolvedPath = resolveStepPath(step, session, ctx);
  if (resolvedPath === null) return null;

  const hostGuess = hostFromSessionOrPath(session, step, template);
  const url = new URL(
    resolvedPath.startsWith('http')
      ? resolvedPath
      : `https://${hostGuess}${resolvedPath.startsWith('/') ? '' : '/'}${resolvedPath}`,
  );

  // Collect body/query params from the template + sources.
  const params: Record<string, string> = {};
  const pathParamNames = pathPlaceholderNames(step.path);

  // Learned stable body params first.
  if (step.request?.bodyParams) {
    for (const [k, v] of Object.entries(step.request.bodyParams)) {
      if (v.includes(MASK)) continue;
      params[k] = v;
    }
  }

  if (step.params) {
    for (const [k, src] of Object.entries(step.params)) {
      // Path placeholders are applied to the URL, not body/query (unless also a body key).
      if (pathParamNames.has(k) && src.kind === 'flowParam') {
        // Still resolve so missing path params fail early via resolveStepPath;
        // skip putting them in body/query when they only appear in the path.
        continue;
      }
      const resolved = resolveParam(src, session, ctx);
      if (resolved === undefined) {
        if (src.kind === 'unreproducible') {
          // Soft: omit. Required steps with unreproducible params are flagged
          // on the step itself and skipped by the runner.
          continue;
        }
        if (src.kind === 'flowParam' || src.kind === 'bind') {
          // Missing binding/param — cannot build faithfully.
          return null;
        }
        continue;
      }
      params[k] = resolved;
    }
  }

  // Caller flow params fill any still-missing keys that match by name
  // (except pure path placeholders already consumed by resolveStepPath).
  for (const [k, v] of Object.entries(ctx.params)) {
    if (params[k] === undefined && !pathParamNames.has(k)) params[k] = v;
  }

  // Session injection (token form field, query, cookies, headers).
  const inj = session.credentials.injection;
  const values = session.credentials.values;
  if (inj.tokenFormField) {
    const tok = values.token ?? values[inj.tokenFormField];
    if (tok) params[inj.tokenFormField] = tok;
  }
  if (inj.query) {
    for (const [qName, valueKey] of Object.entries(inj.query)) {
      const v = values[valueKey];
      if (v) url.searchParams.set(qName, v);
    }
  }

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
  if (inj.cookies) {
    const parts: string[] = [];
    for (const [cookieName, valueKey] of Object.entries(inj.cookies)) {
      const v = values[valueKey];
      if (v) parts.push(`${cookieName}=${v}`);
    }
    if (parts.length > 0) headers['cookie'] = parts.join('; ');
  }
  if (inj.headers) {
    for (const [hName, valueKey] of Object.entries(inj.headers)) {
      const v = values[valueKey];
      if (v) headers[hName] = v;
    }
  }
  // Common bearer pattern when injection.headers didn't name it.
  if (values.token && !headers['authorization'] && !inj.tokenFormField) {
    // Only add bearer if no form token field — adapters that use headers set injection.
  }

  let req: ReplayRequest = {
    method,
    url: url.toString(),
    headers,
    body,
  };

  // Overlay learned identity headers / stable fingerprint.
  if (step.request) {
    const tmpl: RequestTemplate = {
      headers: step.request.headers,
      bodyParams: step.request.bodyParams,
      volatileParams: step.request.volatileParams,
    };
    req = makeFaithful(req, tmpl);
  }

  // Guard: never send unsubstituted path placeholders.
  if (pathStillHasPlaceholders(req.url)) {
    throw new FlowBuildError(
      'path_unresolved',
      `flow build refused: path still has unsubstituted placeholders (${req.url}).`,
    );
  }

  // F4.4 — refuse before the network layer ever sees the request.
  assertFlowStepAllowed(req, {
    operation: step.operation,
    allowedHosts: ctx.allowedHosts,
  });

  return req;
}

/**
 * Build every reproducible step up front (no binds that need live responses).
 * Steps that need binds return null placeholders — prefer runFlowReplay's
 * per-step build for bind-aware runs.
 */
export function buildFlowRequests(
  template: FlowTemplate,
  session: Session,
  params: Record<string, string> = {},
  opts: { allowedHosts?: readonly string[] } = {},
): Array<{ step: FlowTemplateStep; request: ReplayRequest | null }> {
  const ctx: FlowStepBuildContext = {
    params,
    priorResponses: new Map(),
    allowedHosts: opts.allowedHosts,
  };
  return template.steps
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((step) => {
      try {
        return { step, request: buildFlowStepRequest(template, step, session, ctx) };
      } catch (e) {
        if (e instanceof FlowBuildError) {
          // Surface as null + leave the error on the step path via throw at run.
          // Callers that want fail-fast should use buildFlowStepRequest directly.
          throw e;
        }
        throw e;
      }
    });
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Substitute `{name}` / legacy `:id` path segments from step.params + ctx.params.
 * Returns null when a required placeholder cannot be resolved (soft miss).
 * Throws path_unresolved only after URL assembly if something still slips through.
 */
function resolveStepPath(
  step: FlowTemplateStep,
  session: Session,
  ctx: FlowStepBuildContext,
): string | null {
  let path = step.path;

  // Named `{param}` placeholders.
  path = path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name: string) => {
    const v = resolvePathPlaceholder(name, step, session, ctx);
    return v !== undefined ? encodeURIComponent(v) : full;
  });

  // Legacy `:id` / `:id2` — prefer explicit step.params named id/id2/cardId… then
  // first unused flow param that looks like an id key, then ctx.params.id.
  if (/(?:^|\/):\w+(?=\/|$)/.test(path)) {
    const idValues: string[] = [];
    const tryNames = ['id', 'cardId', 'boardId', 'listId', 'memberId', 'channel', 'channelId'];
    const seen = new Set<string>();
    for (const name of tryNames) {
      const v = resolvePathPlaceholder(name, step, session, ctx);
      if (v !== undefined && !seen.has(v)) {
        idValues.push(v);
        seen.add(v);
      }
    }
    // Any other resolved step path-ish params.
    if (step.params) {
      for (const [k, src] of Object.entries(step.params)) {
        if (!/Id$|^id\d*$/i.test(k)) continue;
        const v = resolveParam(src, session, ctx) ?? ctx.params[k];
        if (v !== undefined && !seen.has(v)) {
          idValues.push(v);
          seen.add(v);
        }
      }
    }
    let i = 0;
    path = path.replace(/(?<=^|\/):(\w+)(?=\/|$)/g, (full) => {
      const v = idValues[i++];
      return v !== undefined ? encodeURIComponent(v) : full;
    });
  }

  if (pathStillHasPlaceholders(path)) {
    // Missing path param — cannot build faithfully (same as missing flowParam).
    return null;
  }
  return path;
}

function resolvePathPlaceholder(
  name: string,
  step: FlowTemplateStep,
  session: Session,
  ctx: FlowStepBuildContext,
): string | undefined {
  const src = step.params?.[name];
  if (src) {
    const v = resolveParam(src, session, ctx);
    if (v !== undefined) return v;
  }
  if (ctx.params[name] !== undefined) return ctx.params[name];
  // Common alias: callers pass `id` for `{cardId}` etc.
  if (name.endsWith('Id') && ctx.params.id !== undefined) return ctx.params.id;
  if (name === 'id' || name === 'cardId') {
    return ctx.params.cardId ?? ctx.params.id;
  }
  if (name === 'boardId') return ctx.params.boardId ?? ctx.params.id;
  return undefined;
}

function pathPlaceholderNames(path: string): Set<string> {
  const names = new Set<string>();
  for (const m of path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (m[1]) names.add(m[1]);
  }
  if (/(?:^|\/):\w+(?=\/|$)/.test(path)) {
    names.add('id');
  }
  return names;
}

function pathStillHasPlaceholders(urlOrPath: string): boolean {
  let path = urlOrPath;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath.split('?')[0] ?? urlOrPath;
  }
  return /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(path) || /(?:^|\/):\w+(?=\/|$)/.test(path);
}

function resolveParam(
  src: FlowParamSource,
  session: Session,
  ctx: FlowStepBuildContext,
): string | undefined {
  switch (src.kind) {
    case 'literal':
      return src.value.includes(MASK) ? undefined : src.value;
    case 'flowParam':
      return ctx.params[src.name];
    case 'session': {
      // Prefer explicit token, then cookie, then first value.
      const v = session.credentials.values;
      return v.token ?? v.d ?? v.cookie ?? Object.values(v)[0];
    }
    case 'bind': {
      const data = ctx.priorResponses.get(src.fromStep);
      if (data === undefined) return undefined;
      const resolve = ctx.resolvePath ?? defaultResolvePath;
      return resolve(data, src.jsonPath);
    }
    case 'unreproducible':
      return undefined;
    default:
      return undefined;
  }
}

function defaultResolvePath(data: unknown, path: string): string | undefined {
  if (!path || path === '$') return prim(data);
  let cur: unknown = data;
  const tokens = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (const raw of tokens) {
    if (cur == null) return undefined;
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const idx = Number(raw.slice(1, -1));
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[raw];
    } else {
      return undefined;
    }
  }
  return prim(cur);
}

function prim(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function hostFromSessionOrPath(
  _session: Session,
  step: FlowTemplateStep,
  template: FlowTemplate,
): string {
  // Prefer host embedded in a full URL path sample.
  if (step.path.startsWith('http')) {
    try {
      return new URL(step.path).host;
    } catch {
      /* fall through */
    }
  }
  // Adapter-id heuristic — good enough for build; real hosts come from captures
  // when path was absolute. Callers can pass absolute paths in templates.
  switch (template.adapterId) {
    case 'slack':
      return 'slack.com';
    case 'trello':
      return 'trello.com';
    case 'gmail':
      return 'mail.google.com';
    case 'fast':
      return 'api.fast.com';
    default:
      return `${template.adapterId}.example`;
  }
}
