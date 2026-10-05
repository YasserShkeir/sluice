// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-slack — the self-contained Slack app.
 *
 * The Slack adapter + parser and the macOS credential extractor, exported as
 * `slackApp: App` (an Adapter plus a `credentials` provider).
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
    // ONE class covering every byte Slack puts in a token, escaped (`%2F`) or raw
    // (`+/=`). `redactText` applies patterns in order, so a narrower pattern first
    // would mask only a prefix of a percent-escaped `d` cookie and eat the `xoxd-`
    // anchor that a wider pattern needs.
    /xox[abcdeprs]-[A-Za-z0-9%+/=._-]{8,}/g,
  ],
  headers: ['x-slack-auth', 'x-slack-session'],
};

/** Generic credential seam for Slack: local-store extraction + passive enumeration + paste-in. */
const slackCredentials: CredentialProvider = {
  extractSessions: (opts) => extractAllSlackSessions(opts),
  listWorkspaces: (opts) => listSlackWorkspaces(opts),
  sessionFromInput: (input) => {
    const { token, cookie } = input;
    // Only a Slack-shaped token: the runner scopes paste-in to one app, and this
    // keeps another service's pasted credential from ever becoming a Slack
    // session sent to slack.com.
    if (!token || !cookie || !/^xox[a-z]-/.test(token)) return undefined;
    return slackSessionFromCreds(token, cookie, { label: 'Slack (paste-in)' });
  },
};

/** The one installed Slack app: adapter + credential provider. */
export const slackApp: App = {
  ...slackAdapter,
  credentials: slackCredentials,
  redaction: slackRedaction,
  /**
   * Hand-authored companion sketch when clustering is sparse. Data-learned
   * templates always win at replay; this only documents expected neighbors.
   */
  listFlowHints: () => [
    {
      primaryKey: 'conversations.history',
      label: 'Open channel',
      companions: ['conversations.members', 'conversations.info', 'emoji.list', 'users.info'],
    },
    {
      primaryKey: 'conversations.replies',
      label: 'Open thread',
      companions: ['conversations.history', 'users.info'],
    },
  ],
};
