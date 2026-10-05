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
import { injectedCookieHeader, injectedHeaders, injectedQuery } from '@sluice/adapter-sdk';
import { headerValue, newId, previewSecret } from '@sluice/core';
import type {
  Adapter,
  Capture,
  CredentialHint,
  ReplayAction,
  ReplayParam,
  ReplayRequest,
  Session,
} from '@sluice/core';
import { ADAPTER_ID, classifySlackCapture, parseSlackCapture, slackNextCursors } from './parse.js';

/** slack.com, any workspace subdomain (acme.slack.com), edgeapi.slack.com, app.slack.com. */
function isSlackApiHost(host: string): boolean {
  return host === 'slack.com' || host.endsWith('.slack.com');
}

// ── Replay actions ──────────────────────────────────────────────────────────────

// Shared, never mutated: nothing in the repo writes to a ReplayAction's params.
const CURSOR: ReplayParam = { name: 'cursor', label: 'Cursor', kind: 'cursor' };
const LIMIT: ReplayParam = { name: 'limit', label: 'Limit', kind: 'number', default: '200' };
const TYPES: ReplayParam = {
  name: 'types',
  label: 'Types',
  kind: 'string',
  default: 'public_channel,private_channel,mpim,im',
};
const CHANNEL: ReplayParam = { name: 'channel', label: 'Channel', kind: 'containerId', required: true };

const action = (apiMethod: string, label: string, params: ReplayParam[]): ReplayAction => ({
  id: `slack.${apiMethod}`,
  adapterId: ADAPTER_ID,
  label,
  method: 'POST',
  urlTemplate: `https://slack.com/api/${apiMethod}`,
  params,
});

const SLACK_REPLAY_ACTIONS: ReplayAction[] = [
  action('conversations.list', 'List conversations', [TYPES, CURSOR, LIMIT]),
  action('conversations.history', 'Channel history', [CHANNEL, CURSOR, LIMIT]),
  action('users.list', 'List users', [CURSOR, LIMIT]),
  action('conversations.replies', 'Thread replies', [
    CHANNEL,
    { name: 'ts', label: 'Thread ts', kind: 'string', required: true },
    CURSOR,
    LIMIT,
  ]),
  // Appended, not folded into `slack.conversations.list`: a Slack cursor is
  // scoped to the method that issued it, so `users.conversations` pagination had
  // nowhere valid to go and its second page was silently dropped.
  action('users.conversations', 'My conversations', [TYPES, CURSOR, LIMIT]),
];

// ── Credential hints (Phase-B seed) ─────────────────────────────────────────────

/**
 * Surface xoxc-token / d-cookie candidates. Works in two modes: if handed a raw
 * (pre-redaction) capture it can preview the real token shape; on a redacted
 * capture (the normal case — headers are masked before a Capture exists) it
 * reports mere presence. It never emits a full secret: matched values go through
 * `previewSecret`, and masked ones become a presence marker.
 */
export function extractSlackCredentialHints(capture: Capture): CredentialHint[] {
  const hints: CredentialHint[] = [];
  const hint = (
    location: CredentialHint['location'],
    name: string,
    m: RegExpExecArray | null,
    confidence: number,
    role: CredentialHint['role'],
  ): void => {
    hints.push({
      adapterId: ADAPTER_ID,
      location,
      name,
      valuePreview: m ? previewSecret(m[0]) : '«present»',
      confidence: m ? confidence : 0.5,
      role,
    });
  };

  const auth = headerValue(capture.reqHeaders, 'authorization');
  if (auth !== undefined) hint('header', 'authorization', /xoxc-[A-Za-z0-9-]+/.exec(auth), 0.95, 'bearer');

  const cookie = headerValue(capture.reqHeaders, 'cookie');
  if (cookie !== undefined) hint('cookie', 'd', /xoxd-[A-Za-z0-9%._-]+/.exec(cookie), 0.9, 'session-cookie');

  const body = capture.reqBody;
  const token = body ? /xoxc-[A-Za-z0-9-]+/.exec(body) : null;
  if (body && (token || /(^|&)token=/.test(body))) hint('body', 'token', token, 0.9, 'bearer');

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
  for (const [k, v] of Object.entries(injectedQuery(session))) form.set(k, v);

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  Object.assign(headers, injectedHeaders(session));

  // With no cookie map at all, default to the `d` cookie.
  const cookie =
    Object.keys(inj.cookies ?? {}).length > 0
      ? injectedCookieHeader(session)
      : creds.values.cookieD
        ? `d=${creds.values.cookieD}`
        : undefined;
  if (cookie) headers.Cookie = cookie;

  // Always slack.com; Grid/edgeapi workspace hosts are not handled yet.
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
  matchRequest: (input) => isSlackApiHost(input.host) && input.path.startsWith('/api/'),
  parse: parseSlackCapture,
  classify: classifySlackCapture,
  nextCursors: slackNextCursors,
  listReplayActions: () => SLACK_REPLAY_ACTIONS,
  buildReplayRequest,
  extractCredentialHints: extractSlackCredentialHints,
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
