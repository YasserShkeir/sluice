// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loom session cookies from Google Chrome (macOS).
 *
 * Thin domain wrapper over `@sluice/core`'s shared Chromium OSCrypt + Chrome
 * profile reader (same path as Trello / LinkedIn).
 */
import {
  locateChromeProfile,
  readChromeCookieHeader,
  type ChromeCookieHeader,
} from '@sluice/core';

export type LoomCookieHeader = ChromeCookieHeader;

/**
 * Locate the first Chrome profile signed in to Loom, decrypt its loom.com
 * cookies, and return them as a ready-to-send `Cookie:` header.
 */
export function readLoomCookieHeader(): LoomCookieHeader {
  return readChromeCookieHeader({
    domainSuffix: 'loom.com',
    serviceLabel: 'Loom',
  });
}

/**
 * Passive probe: first Chrome profile whose Cookies DB holds loom.com rows.
 * Does not decrypt and never triggers Keychain.
 */
export function locateLoomProfile(): { profile: string; cookiesPath: string } | undefined {
  return locateChromeProfile('loom.com');
}
