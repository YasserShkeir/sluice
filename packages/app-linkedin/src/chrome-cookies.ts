// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * LinkedIn session cookies from Google Chrome (macOS).
 *
 * Thin domain wrapper over `@sluice/core`'s shared Chromium OSCrypt + Chrome
 * profile reader. CSRF derivation stays here — it is LinkedIn-specific.
 */
import {
  locateChromeProfile,
  readChromeCookieHeader,
  type ChromeCookieHeader,
} from '@sluice/core';

export type LinkedInCookieHeader = ChromeCookieHeader;

/**
 * Locate the first Chrome profile signed in to LinkedIn, decrypt its cookies,
 * and return a ready-to-send `Cookie:` header.
 */
export function readLinkedInCookieHeader(): LinkedInCookieHeader {
  return readChromeCookieHeader({
    domainSuffix: 'linkedin.com',
    serviceLabel: 'LinkedIn',
  });
}

/**
 * Passive probe: first Chrome profile whose Cookies DB holds linkedin.com rows.
 * Does not decrypt and never triggers Keychain.
 */
export function locateLinkedInProfile(): { profile: string; cookiesPath: string } | undefined {
  return locateChromeProfile('linkedin.com');
}

/**
 * Derive the Voyager `csrf-token` header value from a Cookie header.
 *
 * LinkedIn's browser client sends `csrf-token: ajax:…` matching the
 * `JSESSIONID` cookie (often quoted as `"ajax:…"`). Without it Voyager rejects
 * the request even when Cookie is present.
 */
export function csrfTokenFromCookieHeader(cookieHeader: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name.toLowerCase() !== 'jsessionid') continue;
    let value = part.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}
