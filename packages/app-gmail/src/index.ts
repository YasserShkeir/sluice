// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-gmail — the self-contained Gmail app.
 *
 * The primary export is `gmailApp: App`. It has no `credentials` provider yet (Gmail is
 * authorized by Google's SID/HSID/SSID/APISID/SAPISID cookies, which `buildReplayRequest`
 * already consumes), so `listReplayActions()` offers nothing; see GMAIL_THREADS_LIST.
 *
 * Registered in `@sluice/apps`, which is what turns the redaction contribution
 * below into global policy and puts `mail.google.com` on the proxy's
 * TLS-intercept list.
 *
 * The five `gmail_*` MCP tools (mcp-tools.ts) answer from the capture store.
 */
import type { App, AppRedaction } from '@sluice/core';
import { gmailAdapter } from './gmail-adapter.js';
import { gmailMcpTools } from './mcp-tools.js';
import { gmailReconcile } from './reconcile.js';

/**
 * Gmail's own credential shape.
 *
 * `x-framework-xsrf-token` is a `<session token>:<epoch ms>` pair, sent on every
 * `/sync/…` call. The generic redactor masks credential-NAMED fields and this
 * header is not one of them, so without this line a live XSRF token is written to
 * SQLite verbatim and streamed to the webapp on every capture.
 */
const gmailRedaction: AppRedaction = {
  headers: ['x-framework-xsrf-token'],
};

/** The one installed Gmail app: an adapter with no credential provider yet, plus its MCP tools. */
export const gmailApp: App = {
  ...gmailAdapter,
  redaction: gmailRedaction,
  mcpTools: () => gmailMcpTools,
  reconcile: gmailReconcile,
};
