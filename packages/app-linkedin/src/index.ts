// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-linkedin — the self-contained LinkedIn app.
 *
 * The primary export is `linkedinApp: App` — the LinkedIn `Adapter` plus:
 *   - a `credentials` provider that mints an in-memory Session from the local
 *     Chrome session cookie (macOS, via core's Chrome cookie reader), and
 *   - store-backed MCP tools (`linkedin_*`) for me / jobs / messaging / search.
 *
 * LinkedIn Voyager is authorized by the browser SESSION COOKIE plus a matching
 * `csrf-token` (from JSESSIONID). Everything the credential provider returns is
 * SECRET (`credentials.values`) and must never be persisted or streamed.
 */
import { localSessionCredentials } from '@sluice/adapter-sdk';
import { locateChromeProfile, readChromeCookieHeader } from '@sluice/core';
import type { App, CredentialProvider } from '@sluice/core';
import {
  ADAPTER_ID,
  csrfTokenFromCookieHeader,
  linkedinAdapter,
} from './linkedin-adapter.js';
import { linkedinMcpTools } from './mcp-tools.js';

// ── Credential provider (macOS Chrome local store) ───────────────────────────────

/** `read` adds the `csrf-token` Voyager requires, derived from JSESSIONID. */
const linkedinCredentials: CredentialProvider = localSessionCredentials({
  adapterId: ADAPTER_ID,
  label: 'LinkedIn',
  kind: 'linkedin-session',
  workspace: {
    id: 'linkedin',
    name: 'LinkedIn',
    domain: 'linkedin.com',
    url: 'https://www.linkedin.com/',
  },
  locate: () => locateChromeProfile('linkedin.com'), // passive probe; see LocalSessionSpec.locate
  read: () => {
    const { cookieHeader } = readChromeCookieHeader({ domainSuffix: 'linkedin.com', serviceLabel: 'LinkedIn' });
    const csrfToken = csrfTokenFromCookieHeader(cookieHeader);
    return {
      values: { cookieHeader, ...(csrfToken ? { csrfToken } : {}) },
      injection: {
        headers: {
          Cookie: 'cookieHeader',
          ...(csrfToken ? { 'csrf-token': 'csrfToken' } : {}),
        },
      },
    };
  },
});

// ── The app ──────────────────────────────────────────────────────────────────────

/** The one installed LinkedIn app: adapter + credential provider + MCP tools. */
export const linkedinApp: App = {
  ...linkedinAdapter,
  credentials: linkedinCredentials,
  mcpTools() {
    return linkedinMcpTools();
  },
};

// ── Named re-exports ─────────────────────────────────────────────────────────────
export {
  linkedinAdapter,
  parseLinkedInCapture,
  classifyLinkedInCapture,
  linkedInNextCursors,
  buildLinkedInReplayRequest,
  extractLinkedInCredentialHints,
  ADAPTER_ID,
  JOBS_CONTAINER_ID,
  csrfTokenFromCookieHeader,
} from './linkedin-adapter.js';
export { linkedinMcpTools } from './mcp-tools.js';
