// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-toters — the self-contained Toters app.
 *
 * Toters is a MENA delivery service with no desktop client: the traffic this
 * adapter was written from came from an iPhone routed through Engine A's LAN
 * proxy. That single fact shapes every seam here.
 *
 * It contributes:
 *   - an adapter claiming toters-api.com / totersapp.com / totersapi.com,
 *   - a parser turning the `{ errors, data }` envelope into Workspace, Actor,
 *     Container (stores, saved addresses) and Item (catalogue items),
 *   - a classifier that reads the body's own `errors` flag, because Toters
 *     signals failure on an HTTP 200,
 *   - Laravel-paginator cursor seeding for the store list,
 *   - five GET-only replay actions,
 *   - a PASTE-IN-only credential provider (see below),
 *   - three store-backed MCP tools,
 *   - redaction for the payment token the generic policy cannot reach.
 *
 * ## Why there is no local credential extraction
 *
 * Every other credentialed app in this repo reads a desktop application's
 * on-disk state — Slack's LevelDB, Chrome's cookie DB. Toters has no desktop
 * app, so there is nothing on this Mac to extract: the bearer token lives in
 * the phone's keystore. `extractSessions` therefore returns `[]` rather than
 * pretending, and `sessionFromInput` is the real path — paste the
 * `access_token` the app is using and replay works.
 */
import type {
  App,
  AppRedaction,
  CredentialProvider,
  Session,
} from '@sluice/core';
import { newId } from '@sluice/core';
import {
  ADAPTER_ID,
  buildTotersReplayRequest,
  classifyTotersCapture,
  matchesToters,
  parseTotersCapture,
  TOTERS_REPLAY_ACTIONS,
  totersNextCursors,
  WORKSPACE_ID,
} from './toters-adapter.js';
import { totersMcpTools } from './mcp-tools.js';

// ── Credentials ──────────────────────────────────────────────────────────────

/**
 * Paste-in only. See the module header for why there is nothing to extract.
 *
 * `sessionFromInput` maps the generic `{ token, cookie }` pair onto Toters'
 * vocabulary: `token` is the `access_token` from `POST /api/auth/refresh`, and
 * `cookie` is the optional `client-device-token`, which some endpoints require
 * alongside the bearer. The app-specific keys `accessToken` /
 * `clientDeviceToken` are accepted too and take precedence.
 */
const totersCredentials: CredentialProvider = {
  extractSessions: async (): Promise<Session[]> => [],
  listWorkspaces: async () => [],

  sessionFromInput: (input) => {
    // Toters' own names win over the generic pair, so a caller can say exactly
    // which value is which. A pasted `Bearer …` is unwrapped, not doubled.
    const accessToken = (input.accessToken ?? input.token)?.trim().replace(/^Bearer(?:\s+|$)/i, '');
    // A Slack `xox?-` token is never a Toters bearer: refuse it rather than
    // send someone's Slack session to api.toters-api.com.
    if (!accessToken || /^xox[a-z]-/i.test(accessToken)) return undefined;
    const values: Record<string, string> = { accessToken, authorization: `Bearer ${accessToken}` };
    const deviceToken = (input.clientDeviceToken ?? input.cookie)?.trim();
    if (deviceToken) values.clientDeviceToken = deviceToken;
    return {
      id: newId('sess'),
      adapterId: ADAPTER_ID,
      workspaceId: WORKSPACE_ID,
      label: 'Toters (pasted token)',
      credentials: {
        kind: 'toters-bearer',
        values,
        injection: {
          headers: {
            authorization: 'authorization',
            'client-device-token': 'clientDeviceToken',
          },
        },
      },
      discoveredAt: Date.now(),
      source: 'manual',
    };
  },
};

// ── Redaction ────────────────────────────────────────────────────────────────

/**
 * The `pm_` / `seti_` value patterns mask Stripe ids under any field name, in
 * every app's traffic, because redaction runs before attribution. The field-name
 * lookbehind masks the whole quoted value, where core's field rule stops at a
 * space or comma.
 */
const totersRedaction: AppRedaction = {
  patterns: [
    // Stripe payment-method / setup-intent ids as they appear in Toters bodies.
    /\bpm_[A-Za-z0-9]{16,}/g,
    /\bseti_[A-Za-z0-9]{16,}/g,
    // Whole-quoted-value belt for Toters' compound token field names.
    //
    // A LOOKBEHIND, not a capture group: `patterns` entries are replaced
    // wholesale with the mask, so matching the `"field":"` prefix as well would
    // delete the field NAME and leave `{"id":12,«redacted»"}` — malformed JSON
    // that every later parse of the capture then fails on. Matching only the
    // value keeps the document well-formed.
    /(?<="(?:payment_method_token|address_token|sm_access_token)"\s*:\s*")[^"]{4,}/g,
  ],
  headers: ['client-device-token', 'device-uuid', 'x-forwarded-id'],
};

// ── The app ──────────────────────────────────────────────────────────────────

export const totersApp: App = {
  id: ADAPTER_ID,
  displayName: 'Toters',
  hosts: ['toters-api.com', 'totersapp.com', 'totersapi.com'],
  matchRequest(input) {
    return matchesToters(input.host);
  },
  parse: parseTotersCapture,
  classify: classifyTotersCapture,
  nextCursors: totersNextCursors,
  listReplayActions() {
    return TOTERS_REPLAY_ACTIONS;
  },
  buildReplayRequest: buildTotersReplayRequest,
  credentials: totersCredentials,
  mcpTools() {
    return totersMcpTools;
  },
  redaction: totersRedaction,
};

// ── Named re-exports ─────────────────────────────────────────────────────────
export {
  parseTotersCapture,
  classifyTotersCapture,
  totersNextCursors,
  totersOperation,
  buildTotersReplayRequest,
} from './toters-adapter.js';
