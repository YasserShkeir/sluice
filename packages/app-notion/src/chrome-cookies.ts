// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notion session cookies from Google Chrome (macOS).
 *
 * The profile probe, Keychain access and decryption live in `@sluice/core`; this
 * file is the Notion-specific part. A profile that merely loaded a public Notion
 * page has cookies for the domain (`notion_browser_id`, `__cf_bm`, consent) and
 * matches core's default probe without authenticating, so the probe requires
 * `token_v2` via `locateChromeProfile`'s `requireCookie`.
 *
 * `token_v2` sits on `.app.notion.com` and `file_token` (attachment downloads) on
 * `.notion.com`; reading the domain, not the host, puts both in one header.
 */
import {
  buildChromeCookieHeader,
  locateChromeProfile,
  NoChromeSessionError,
  readChromeCookies,
} from '@sluice/core';

/** Registrable domain the app and its file tokens live on. */
const NOTION_DOMAIN = 'notion.com';

/** The cookie that actually carries the session. Anything else is decoration. */
const SESSION_COOKIE = 'token_v2';

/** The cookie naming the active account — sent back as `x-notion-active-user-header`. */
const ACTIVE_USER_COOKIE = 'notion_user_id';

export interface NotionCookieHeader {
  /** `name1=value1; …` — SECRET; never persist, stream, or log. */
  cookieHeader: string;
  /** The signed-in user's id, when Chrome recorded one. NOT secret. */
  activeUserId?: string;
  /** Chrome profile the cookies were read from (e.g. 'Profile 2'). */
  profile: string;
}

/**
 * Passive probe: the first Chrome profile holding a Notion SESSION cookie.
 * Counts rows without decrypting, so it never triggers a Keychain prompt.
 */
export function locateNotionProfile(
  opts: { chromeUserDataDir?: string } = {},
): { profile: string; cookiesPath: string } | undefined {
  return locateChromeProfile(NOTION_DOMAIN, {
    chromeUserDataDir: opts.chromeUserDataDir,
    requireCookie: SESSION_COOKIE,
  });
}

/**
 * Locate the Chrome profile signed in to Notion, decrypt its notion.com cookies,
 * and return a ready-to-send `Cookie:` header plus the active user id.
 *
 * macOS-only (throws elsewhere). Throws core's `NoChromeSessionError` when no
 * profile is signed in. Cookie values are never logged.
 */
export function readNotionCookieHeader(
  opts: { chromeUserDataDir?: string } = {},
): NotionCookieHeader {
  if (process.platform !== 'darwin') {
    throw new Error(
      'readNotionCookieHeader supports macOS (darwin) only — Chrome cookie decryption goes through the macOS Keychain.',
    );
  }

  const located = locateNotionProfile(opts);
  if (!located) {
    throw new NoChromeSessionError(
      `No Chrome profile signed in to Notion found (no ${SESSION_COOKIE} cookie) — open https://app.${NOTION_DOMAIN} in Google Chrome and sign in first.`,
    );
  }

  const cookies = readChromeCookies(located.cookiesPath, NOTION_DOMAIN);
  const cookieHeader = buildChromeCookieHeader(cookies, NOTION_DOMAIN);
  if (!cookieHeader.includes(`${SESSION_COOKIE}=`)) {
    // The row was there and did not decrypt. That is a Keychain or OSCrypt
    // problem, not a sign-in problem, and saying "sign in" would send the user
    // to fix something that is not broken.
    throw new Error(
      `Chrome profile "${located.profile}" has a Notion session cookie that could not be decrypted — check that Chrome Safe Storage is accessible in the Keychain.`,
    );
  }

  return {
    cookieHeader,
    activeUserId: cookies.find((c) => c.name === ACTIVE_USER_COOKIE)?.value,
    profile: located.profile,
  };
}
