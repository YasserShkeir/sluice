// SPDX-License-Identifier: Apache-2.0
/**
 * A CredentialProvider for a session held in a local macOS store — in practice
 * Chrome's cookie jar, read through `@sluice/core`'s chrome-cookies helpers.
 */
import { errorMessage, isNoSessionError, newId } from '@sluice/core';
import type { CredentialBundle, CredentialProvider, Session, WorkspaceInfo } from '@sluice/core';

export interface LocalSessionSpec {
  /** The owning adapter; every Session is addressed to it. */
  adapterId: string;
  /** Human label (`Trello`), used as the Session label and in error messages. */
  label: string;
  /** `CredentialBundle.kind`, e.g. `trello-session`. */
  kind: string;
  /** The one workspace `listWorkspaces` reports when `locate()` finds a session. */
  workspace: WorkspaceInfo;
  /**
   * Passive probe: truthy when a local profile holds a session. It MUST NOT
   * decrypt anything — `sluice doctor` calls it, and a Keychain prompt from a
   * readiness check is exactly what it exists to avoid.
   */
  locate: () => unknown;
  /**
   * Read the session: SECRET `values` plus the `injection` map that says where
   * they go. May prompt the Keychain. Throw core's `NoChromeSessionError` when
   * nobody is signed in; any other throw is reported as a failure.
   */
  read: () => Pick<CredentialBundle, 'values' | 'injection'>;
  /** Test seam; defaults to `process.platform`, read at call time. */
  platform?: NodeJS.Platform;
}

/**
 * `listWorkspaces` + `extractSessions` for a macOS local-store session.
 *
 * Both answer `[]` off macOS. `listWorkspaces` returns a fresh copy of the
 * workspace when `locate()` is truthy and `[]` when it is falsy or throws.
 * `extractSessions` returns exactly one Session with source `local-store`, whose
 * `credentials.values` are SECRET: they must never be persisted, streamed, logged
 * or embedded in an error. A "no session here" failure (core's `isNoSessionError`)
 * is `[]`; anything else — a locked cookie DB, a denied Keychain prompt, a
 * decrypt failure — throws `<label> credential extraction failed: …`, because a
 * blanket catch told users to sign in when they already were.
 *
 * @example
 * const credentials: CredentialProvider = localSessionCredentials({
 *   adapterId: 'trello', label: 'Trello', kind: 'trello-session',
 *   workspace: { id: 'trello', name: 'Trello', domain: 'trello.com', url: 'https://trello.com/' },
 *   locate: () => locateChromeProfile('trello.com'),
 *   read: () => ({
 *     values: { cookieHeader: readChromeCookieHeader({ domainSuffix: 'trello.com', serviceLabel: 'Trello' }).cookieHeader },
 *     injection: { headers: { Cookie: 'cookieHeader' } },
 *   }),
 * });
 */
export function localSessionCredentials(
  spec: LocalSessionSpec,
): Required<Pick<CredentialProvider, 'extractSessions' | 'listWorkspaces'>> {
  const onMac = (): boolean => (spec.platform ?? process.platform) === 'darwin';
  return {
    listWorkspaces: async (): Promise<WorkspaceInfo[]> => {
      if (!onMac()) return [];
      try {
        return spec.locate() ? [{ ...spec.workspace }] : [];
      } catch {
        return [];
      }
    },
    extractSessions: async (): Promise<Session[]> => {
      if (!onMac()) return [];
      try {
        const { values, injection } = spec.read();
        return [
          {
            id: newId('sess'),
            adapterId: spec.adapterId,
            label: spec.label,
            credentials: { kind: spec.kind, values, injection },
            discoveredAt: Date.now(),
            source: 'local-store',
          },
        ];
      } catch (err) {
        if (isNoSessionError(err)) return [];
        throw new Error(`${spec.label} credential extraction failed: ${errorMessage(err)}`);
      }
    },
  };
}
