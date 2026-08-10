// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Slack Adapter — the reference implementation of the `Adapter` seam.
 *
 * Auth contract (both parts mandatory, cookie-bound `xoxc`):
 *   1. the `xoxc-` token rides as a form field named `token`
 *      (x-www-form-urlencoded), NOT a Bearer header, and
 *   2. the `d` cookie (`d=xoxd-…`) rides in the `Cookie` header.
 * Either one alone yields `not_authed`. `buildReplayRequest` assembles exactly
 * that, reading the secret values out of `session.credentials.values` and the
 * placement out of `session.credentials.injection`.
 */
import { newId, previewSecret } from '@sluice/core';
import type {
  Adapter,
  Capture,
  CredentialHint,
  ReplayAction,
  ReplayRequest,
  Session,
} from '@sluice/core';
import { ADAPTER_ID, classifySlackCapture, parseSlackCapture, slackNextCursors } from './parse.js';

const api = (method: string): string => `https://slack.com/api/${method}`;

/** slack.com, any workspace subdomain (acme.slack.com), edgeapi.slack.com, app.slack.com. */
function isSlackApiHost(host: string): boolean {
  return host === 'slack.com' || host.endsWith('.slack.com');
}

// ── Replay actions ──────────────────────────────────────────────────────────────

const SLACK_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'slack.conversations.list',
    adapterId: ADAPTER_ID,
    label: 'List conversations',
    method: 'POST',
    urlTemplate: api('conversations.list'),
    params: [
      {
        name: 'types',
        label: 'Types',
        kind: 'string',
        default: 'public_channel,private_channel,mpim,im',
      },
      { name: 'cursor', label: 'Cursor', kind: 'cursor' },
      { name: 'limit', label: 'Limit', kind: 'number', default: '200' },
    ],
  },
  {
    id: 'slack.conversations.history',
    adapterId: ADAPTER_ID,
    label: 'Channel history',
    method: 'POST',
    urlTemplate: api('conversations.history'),
    params: [
      { name: 'channel', label: 'Channel', kind: 'containerId', required: true },
      { name: 'cursor', label: 'Cursor', kind: 'cursor' },
      { name: 'limit', label: 'Limit', kind: 'number', default: '200' },
    ],
  },
  {
    id: 'slack.users.list',
    adapterId: ADAPTER_ID,
    label: 'List users',
    method: 'POST',
    urlTemplate: api('users.list'),
    params: [
      { name: 'cursor', label: 'Cursor', kind: 'cursor' },
      { name: 'limit', label: 'Limit', kind: 'number', default: '200' },
    ],
  },
  {
    id: 'slack.conversations.replies',
    adapterId: ADAPTER_ID,
    label: 'Thread replies',
    method: 'POST',
    urlTemplate: api('conversations.replies'),
    params: [
      { name: 'channel', label: 'Channel', kind: 'containerId', required: true },
      { name: 'ts', label: 'Thread ts', kind: 'string', required: true },
      { name: 'cursor', label: 'Cursor', kind: 'cursor' },
      { name: 'limit', label: 'Limit', kind: 'number', default: '200' },
    ],
  },
  // Appended, not folded into `slack.conversations.list`: a Slack cursor is
  // scoped to the method that issued it, so `users.conversations` pagination had
  // nowhere valid to go and its second page was silently dropped.
  {
    id: 'slack.users.conversations',
    adapterId: ADAPTER_ID,
    label: 'My conversations',
    method: 'POST',
    urlTemplate: api('users.conversations'),
    params: [
      {
        name: 'types',
        label: 'Types',
        kind: 'string',
        default: 'public_channel,private_channel,mpim,im',
      },
      { name: 'cursor', label: 'Cursor', kind: 'cursor' },
      { name: 'limit', label: 'Limit', kind: 'number', default: '200' },
    ],
  },
];

// ── Credential hints (Phase-B seed) ─────────────────────────────────────────────

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

/**
 * Surface xoxc-token / d-cookie candidates. Works in two modes: if handed a raw
 * (pre-redaction) capture it can preview the real token shape; on a redacted
 * capture (the normal case — headers are masked before a Capture exists) it
 * reports mere presence. It never emits a full secret: matched values go through
 * `previewSecret`, and masked ones become a presence marker.
 */
export function extractSlackCredentialHints(capture: Capture): CredentialHint[] {
  const hints: CredentialHint[] = [];
  const headers = capture.reqHeaders ?? {};

  const auth = getHeader(headers, 'authorization');
  if (auth !== undefined) {
    const m = /xoxc-[A-Za-z0-9-]+/.exec(auth);
    hints.push({
      adapterId: ADAPTER_ID,
      location: 'header',
      name: 'authorization',
      valuePreview: m ? previewSecret(m[0]) : '«present»',
      confidence: m ? 0.95 : 0.5,
      role: 'bearer',
    });
  }

  const cookie = getHeader(headers, 'cookie');
  if (cookie !== undefined) {
    const m = /xoxd-[A-Za-z0-9%._-]+/.exec(cookie);
    hints.push({
      adapterId: ADAPTER_ID,
      location: 'cookie',
      name: 'd',
      valuePreview: m ? previewSecret(m[0]) : '«present»',
      confidence: m ? 0.9 : 0.5,
      role: 'session-cookie',
    });
  }

  const body = capture.reqBody;
  if (body) {
    const m = /xoxc-[A-Za-z0-9-]+/.exec(body);
    if (m) {
      hints.push({
        adapterId: ADAPTER_ID,
        location: 'body',
        name: 'token',
        valuePreview: previewSecret(m[0]),
        confidence: 0.9,
        role: 'bearer',
      });
    } else if (/(^|&)token=/.test(body)) {
      hints.push({
        adapterId: ADAPTER_ID,
        location: 'body',
        name: 'token',
        valuePreview: '«present»',
        confidence: 0.5,
        role: 'bearer',
      });
    }
  }

  return hints;
}

// ── Replay request builder ──────────────────────────────────────────────────────

function buildReplayRequest(
  action: ReplayAction,
  params: Record<string, string>,
  session: Session,
): ReplayRequest {
  const creds = session.credentials;
  const inj = creds.injection;

  const form = new URLSearchParams();
  const tokenField = inj.tokenFormField ?? 'token';
  const token = creds.values.token;
  if (token) form.set(tokenField, token);

  for (const p of action.params) {
    const v = params[p.name];
    if (v !== undefined && v !== '') form.set(p.name, v);
  }
  for (const [k, v] of Object.entries(inj.query ?? {})) form.set(k, v);

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  for (const [k, v] of Object.entries(inj.headers ?? {})) headers[k] = v;

  // Cookie header: each injection.cookies entry maps a cookie name to the key in
  // `values` holding its secret (falling back to a literal). Default to `d`.
  const cookiePairs: string[] = [];
  const injCookies = inj.cookies ?? {};
  const cookieEntries = Object.entries(injCookies);
  if (cookieEntries.length > 0) {
    for (const [name, ref] of cookieEntries) {
      const value = creds.values[ref] ?? ref;
      if (value) cookiePairs.push(`${name}=${value}`);
    }
  } else if (creds.values.cookieD) {
    cookiePairs.push(`d=${creds.values.cookieD}`);
  }
  if (cookiePairs.length > 0) headers['Cookie'] = cookiePairs.join('; ');

  // Phase-B extension point: for Enterprise Grid / edge methods the workspace
  // host (acme.enterprise.slack.com, edgeapi.slack.com) should override the
  // slack.com template. Phase A replays against slack.com, which the client's
  // own session token accepts for the reconstruction + history methods above.
  return {
    method: action.method,
    url: action.urlTemplate,
    headers,
    body: form.toString(),
  };
}

// ── The adapter ─────────────────────────────────────────────────────────────────

export const slackAdapter: Adapter = {
  id: ADAPTER_ID,
  displayName: 'Slack',
  // Every host a Slack client actually talks to. matchRequest claims all of
  // *.slack.com regardless (a workspace is served from acme.slack.com), but this
  // list is metadata in its own right: it seeds Engine A's TLS-intercept scope,
  // it is what `sluice adapters` prints, and defaultCaptureUrl() picks the
  // `app.`-prefixed entry as the page `sluice capture` opens.
  hosts: ['slack.com', 'edgeapi.slack.com', 'app.slack.com'],
  matchRequest(input) {
    return isSlackApiHost(input.host) && input.path.startsWith('/api/');
  },
  parse(capture, ctx) {
    return parseSlackCapture(capture, ctx);
  },
  classify(capture) {
    return classifySlackCapture(capture);
  },
  nextCursors(capture, ctx) {
    return slackNextCursors(capture, ctx);
  },
  listReplayActions() {
    return SLACK_REPLAY_ACTIONS;
  },
  buildReplayRequest,
  extractCredentialHints(capture) {
    return extractSlackCredentialHints(capture);
  },
};

// ── Manual-session helper ────────────────────────────────────────────────────────

/**
 * Build a `Session` from a pasted-in `xoxc` token + `d` cookie value. The result
 * is SECRET (its `credentials.values`) and must never be persisted or streamed —
 * only a `RedactedSession` (via `redactSession`) may cross those boundaries.
 */
export function slackSessionFromCreds(
  token: string,
  cookieD: string,
  opts?: { workspaceId?: string; label?: string },
): Session {
  return {
    id: newId('sess'),
    adapterId: ADAPTER_ID,
    workspaceId: opts?.workspaceId,
    label: opts?.label ?? 'Slack (manual)',
    credentials: {
      kind: 'slack-session',
      values: { token, cookieD },
      injection: {
        tokenFormField: 'token',
        cookies: { d: 'cookieD' },
      },
    },
    discoveredAt: Date.now(),
    source: 'manual',
  };
}
