// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-slack — the self-contained Slack app.
 *
 * Bundles three things that used to be scattered across the engine packages:
 *   - the Slack adapter + parser (was `@sluice/adapter-slack`),
 *   - the macOS credential extractor (was `@sluice/interceptor`'s
 *     slack-token-extract), wrapped as a generic `CredentialProvider`,
 *   - the Slack desktop path helpers (were in `@sluice/runner`'s config).
 *
 * The primary export is `slackApp: App` — an `Adapter` plus a `credentials`
 * provider. The lower-level named exports (`slackAdapter`, `parseSlackCapture`,
 * `extractAllSlackSessions`, …) remain available for direct use and testing.
 */
import type { App, AppRedaction, CredentialProvider } from '@sluice/core';
import { slackAdapter, slackSessionFromCreds } from './slack-adapter.js';
import { extractAllSlackSessions, listSlackWorkspaces } from './slack-credentials.js';

/**
 * Slack's own token shapes. The generic redactor only masks credential-*named*
 * fields, so a live `xoxc-`/`xoxd-` value under a field name it doesn't know
 * (`api_token`, `idToken`, a bare `d` cookie value inside a JSON body) would
 * otherwise reach SQLite and the WebSocket. This pattern matches the secret by
 * its shape instead, wherever it appears.
 */
const slackRedaction: AppRedaction = {
  patterns: [
    // ONE pattern, not a narrow one plus a wide one. `redactText` applies patterns
    // in registration order, so the narrow `xox[abcdeprs]-[A-Za-z0-9-]{8,}` ran
    // first and — having no `%` in its class — masked only `xoxd-cVdDdMSUmqNs` of
    // a percent-escaped `d` cookie, leaving 40 of its 57 characters in SQLite AND
    // eating the `xoxd-` the wider pattern behind it needed to anchor on. One
    // class covering every byte Slack puts in a token, escaped (`%2F`) or raw
    // (`+/=`), cannot be shadowed whatever order the patterns are applied in.
    /xox[abcdeprs]-[A-Za-z0-9%+/=._-]{8,}/g,
  ],
  headers: ['x-slack-auth', 'x-slack-session'],
};

/** Generic credential seam for Slack: local-store extraction + passive enumeration + paste-in. */
const slackCredentials: CredentialProvider = {
  extractSessions: (opts) => extractAllSlackSessions(opts),
  listWorkspaces: (opts) => listSlackWorkspaces(opts),
  sessionFromInput: (input) => {
    const token = input.token;
    const cookie = input.cookie;
    if (!token || !cookie) return undefined;
    return slackSessionFromCreds(token, cookie, { label: 'Slack (paste-in)' });
  },
};

/** The one installed Slack app: adapter + credential provider. */
export const slackApp: App = {
  ...slackAdapter,
  credentials: slackCredentials,
  redaction: slackRedaction,
};

// ── Named re-exports (adapter alias + raw pieces for callers/tests) ─────────────
export { slackAdapter, slackSessionFromCreds, extractSlackCredentialHints } from './slack-adapter.js';
export {
  parseSlackCapture,
  classifySlackCapture,
  slackNextCursors,
  slackMethod,
  ADAPTER_ID,
} from './parse.js';
export { extractAllSlackSessions, listSlackWorkspaces } from './slack-credentials.js';
export type { SlackWorkspaceInfo } from './slack-credentials.js';
export { slackAppSupportDir, slackLevelDbDir, slackCookiesPath } from './paths.js';
