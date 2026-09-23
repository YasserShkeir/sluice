// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notion session cookies from Google Chrome (macOS).
 *
 * Crypto, Keychain access and copy-then-read live in `@sluice/core` and are used
 * from there — this file is the Notion-specific part, and there is more of it
 * than for Trello or Loom for one reason:
 *
 * **A Chrome profile can hold Notion cookies without holding a Notion session.**
 * Core's `locateChromeProfile('notion.com')` returns the first profile with ANY
 * matching row, and a profile that merely loaded a public Notion page has
 * `notion_browser_id`, `__cf_bm` and a consent cookie — enough to match, not
 * enough to authenticate. Verified on this machine: `Default` had six
 * notion.com rows and no session, while the signed-in profile was `Profile 2`.
 * Taking the first match would have built a cookie header that authenticates as
 * nobody, and every replay would come back 401 while `doctor` reported Notion as
 * signed in.
 *
 * So the probe here looks for `token_v2` specifically — the session cookie —
 * rather than for the domain.
 *
 * Second Notion-specific bit: the session cookie is scoped to `.app.notion.com`
 * while `file_token` (which authorizes attachment downloads) is on
 * `.notion.com`, so both have to come from the same profile and go into one
 * header. Reading the domain, not the host, is what gets both.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildChromeCookieHeader,
  decryptOscryptV10,
  keychainPassphrase,
  withCopiedSqliteDb,
} from '@sluice/core';

/** Chrome's default profile directory names, in preference order. */
const CHROME_PROFILES = ['Default', 'Profile 1', 'Profile 2', 'Profile 3'] as const;

const CHROME_SAFE_STORAGE = 'Chrome Safe Storage';
const CHROME_ACCOUNT = 'Chrome';

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

function chromeBase(override?: string): string {
  return override ?? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

/** `host`, `.host` and `*.host` rows — Notion uses all three at once. */
const HOST_SQL = `(host_key = '${NOTION_DOMAIN}' OR host_key = '.${NOTION_DOMAIN}' OR host_key LIKE '%.${NOTION_DOMAIN}')`;

/**
 * Passive probe: the first Chrome profile holding a Notion SESSION cookie.
 * Counts rows without decrypting, so it never triggers a Keychain prompt.
 */
export function locateNotionProfile(
  opts: { chromeUserDataDir?: string } = {},
): { profile: string; cookiesPath: string } | undefined {
  const base = chromeBase(opts.chromeUserDataDir);
  const sql = `SELECT COUNT(*) AS n FROM cookies WHERE name = ? AND ${HOST_SQL}`;
  for (const profile of CHROME_PROFILES) {
    const cookiesPath = join(base, profile, 'Cookies');
    if (!existsSync(cookiesPath)) continue;
    const has = withCopiedSqliteDb(cookiesPath, (db) => {
      const row = db.prepare(sql).get(SESSION_COOKIE) as { n: number } | undefined;
      return (row?.n ?? 0) > 0;
    });
    if (has) return { profile, cookiesPath };
  }
  return undefined;
}

/**
 * Locate the Chrome profile signed in to Notion, decrypt its notion.com cookies,
 * and return a ready-to-send `Cookie:` header plus the active user id.
 *
 * macOS-only (throws elsewhere). Cookie values are never logged.
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
    throw new Error(
      `No Chrome profile signed in to Notion found (no ${SESSION_COOKIE} cookie) — open https://app.${NOTION_DOMAIN} in Google Chrome and sign in first.`,
    );
  }

  const cookies = readNotionCookies(located.cookiesPath);
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

interface RawCookie {
  name: string;
  host: string;
  value: string;
}

function readNotionCookies(cookiesPath: string): RawCookie[] {
  const pass = keychainPassphrase(CHROME_SAFE_STORAGE, CHROME_ACCOUNT);
  try {
    return withCopiedSqliteDb(cookiesPath, (db) => {
      const rows = db
        .prepare(`SELECT name, host_key, encrypted_value FROM cookies WHERE ${HOST_SQL}`)
        .all() as Array<{ name: string; host_key: string; encrypted_value: Buffer }>;
      const out: RawCookie[] = [];
      for (const r of rows) {
        try {
          out.push({
            name: r.name,
            host: r.host_key,
            value: decryptOscryptV10(r.encrypted_value, pass, {
              encoding: 'latin1',
              hostHash: 'always',
            }),
          });
        } catch {
          // Skip cookies we can't decrypt (non-v10 / unrelated encoding).
        }
      }
      return out;
    });
  } finally {
    pass.fill(0);
  }
}
