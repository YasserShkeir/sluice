// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Trello session cookies from Google Chrome (macOS).
 *
 * Thin domain wrapper over `@sluice/core`'s shared Chromium OSCrypt + Chrome
 * profile reader. Crypto, Keychain, and copy-then-read live in core so they are
 * not pasted a fifth time when the next cookie-auth app lands.
 */
import {
  locateChromeProfile,
  readChromeCookieHeader,
  type ChromeCookieHeader,
} from '@sluice/core';

export type TrelloCookieHeader = ChromeCookieHeader;

/**
 * Locate the first Chrome profile signed in to Trello, decrypt its trello.com
 * cookies, and return them as a ready-to-send `Cookie:` header.
 */
export function readTrelloCookieHeader(): TrelloCookieHeader {
  return readChromeCookieHeader({
    domainSuffix: 'trello.com',
    serviceLabel: 'Trello',
  });
}

/**
 * Passive probe: first Chrome profile whose Cookies DB holds trello.com rows.
 * Does not decrypt and never triggers Keychain.
 */
export function locateTrelloProfile(): { profile: string; cookiesPath: string } | undefined {
  return locateChromeProfile('trello.com');
}
