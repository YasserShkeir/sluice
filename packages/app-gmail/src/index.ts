// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-gmail — the self-contained Gmail app.
 *
 * The primary export is `gmailApp: App`. There is no `credentials` provider yet:
 * Gmail is authorized by Google's browser cookie set (SID/HSID/SSID/APISID/SAPISID),
 * so a provider here would be a second copy of app-trello's macOS Chrome cookie
 * reader pointed at a different host. `buildReplayRequest` already consumes a
 * Session built from those cookies, so the seam is open — nothing fills it.
 *
 * Registered in `@sluice/apps`, which is what turns the redaction contribution
 * below into global policy and puts `mail.google.com` on the proxy's
 * TLS-intercept list.
 *
 * The five `gmail_*` MCP tools live here too, in `mcp-tools.ts`. They answer from
 * the capture store rather than the network, which was impossible until
 * `AppToolContext` grew a read-only store view — until then they were compiled
 * into `packages/mcp`'s own spine.
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
  mcpTools() {
    return gmailMcpTools;
  },
  reconcile(store) {
    return gmailReconcile(store);
  },
};

// ── Named re-exports ───────────────────────────────────────────────────────────────
export {
  gmailAdapter,
  parseGmailCapture,
  classifyGmailCapture,
  gmailNextCursors,
  decodeGmailBody,
  gmailMessageView,
  gmailThreadView,
  ADAPTER_ID,
  CHROME_UA,
  accountWorkspaceId,
  accountSlotOfWorkspaceId,
  addressOfWorkspaceId,
  isProvisionalWorkspaceId,
  provisionalWorkspaceId,
  labelContainerId,
  unknownContainerId,
  labelRef,
  containerKind,
  gmailAccountSlot,
  gmailAccountAddress,
  gmailCarriesEntities,
} from './gmail-adapter.js';
export type { AddressRef, GmailMessageView, GmailThreadView, LabelRef } from './gmail-adapter.js';
export { gmailMcpTools } from './mcp-tools.js';
export { reconcileGmailAccounts, gmailReconcile, slotLedger, describeAccounts } from './reconcile.js';
export type { ReconcileReport, SlotBinding, UnresolvedReason } from './reconcile.js';
