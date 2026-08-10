// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/app-linkedin — the self-contained LinkedIn app.
 *
 * The primary export is `linkedinApp: App` — the LinkedIn `Adapter` plus:
 *   - a `credentials` provider that mints an in-memory Session from the local
 *     Chrome session cookie (macOS, via chrome-cookies.ts), and
 *   - store-backed MCP tools (`linkedin_*`) for me / jobs / messaging / search.
 *
 * LinkedIn Voyager is authorized by the browser SESSION COOKIE plus a matching
 * `csrf-token` (from JSESSIONID). Everything the credential provider returns is
 * SECRET (`credentials.values`) and must never be persisted or streamed.
 */
import { newId } from '@sluice/core';
import type { App, CredentialProvider, Session, WorkspaceInfo } from '@sluice/core';
import {
  ADAPTER_ID,
  linkedinAdapter,
} from './linkedin-adapter.js';
import {
  csrfTokenFromCookieHeader,
  locateLinkedInProfile,
  readLinkedInCookieHeader,
} from './chrome-cookies.js';
import { linkedinMcpTools } from './mcp-tools.js';

// ── Credential provider (macOS Chrome local store) ───────────────────────────────

function isNoSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not signed in|no .*cookie|not found|does not exist|ENOENT/i.test(msg);
}

const linkedinCredentials: CredentialProvider = {
  /**
   * Passive readiness probe: does a Chrome profile hold linkedin.com cookies?
   * Counts rows without decrypting — never triggers Keychain.
   */
  listWorkspaces: async (): Promise<WorkspaceInfo[]> => {
    if (process.platform !== 'darwin') return [];
    try {
      const found = locateLinkedInProfile();
      if (!found) return [];
      return [
        {
          id: 'linkedin',
          name: 'LinkedIn',
          domain: 'linkedin.com',
          url: 'https://www.linkedin.com/',
        },
      ];
    } catch {
      return [];
    }
  },

  extractSessions: async (): Promise<Session[]> => {
    if (process.platform !== 'darwin') return [];
    try {
      const { cookieHeader } = readLinkedInCookieHeader();
      const csrfToken = csrfTokenFromCookieHeader(cookieHeader);
      const values: Record<string, string> = { cookieHeader };
      if (csrfToken) values.csrfToken = csrfToken;

      const session: Session = {
        id: newId('sess'),
        adapterId: ADAPTER_ID,
        label: 'LinkedIn',
        credentials: {
          kind: 'linkedin-session',
          values,
          injection: {
            headers: {
              Cookie: 'cookieHeader',
              ...(csrfToken ? { 'csrf-token': 'csrfToken' } : {}),
            },
          },
        },
        discoveredAt: Date.now(),
        source: 'local-store',
      };
      return [session];
    } catch (err) {
      if (isNoSessionError(err)) return [];
      throw new Error(
        `LinkedIn credential extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

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
  matchesLinkedIn,
  queryIdOf,
  textOf,
  CHROME_UA,
  ADAPTER_ID,
  WORKSPACE_ID,
  JOBS_CONTAINER_ID,
  FEED_CONTAINER_ID,
} from './linkedin-adapter.js';
export {
  readLinkedInCookieHeader,
  locateLinkedInProfile,
  csrfTokenFromCookieHeader,
} from './chrome-cookies.js';
export type { LinkedInCookieHeader } from './chrome-cookies.js';
export { linkedinMcpTools } from './mcp-tools.js';
