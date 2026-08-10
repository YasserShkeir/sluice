// SPDX-License-Identifier: Apache-2.0
/**
 * Shared write/admin operation denylist for replay rails.
 *
 * One source of truth for interceptor runtime checks, cartographer learn/build
 * gates, and any other caller that must refuse write-shaped traffic. Patterns
 * are matched case-insensitively against URL path, query, body, and op names.
 *
 * Design notes:
 *   - Method alone is insufficient (Slack/Trello POST for ordinary reads).
 *   - Prefer name/token matches over "all POST to collections".
 *   - Runtime assert must stay a superset of learn/build filters.
 */

/**
 * Operation shapes that write, notify, or administer. Matched against a
 * haystack of path + body + classification — not against HTTP method.
 */
export const REPLAY_DENIED_OPERATION_PATTERNS: readonly RegExp[] = [
  // Slack-shaped RPC (POST is used for reads too, so names matter)
  /\bchat\.(post|update|delete|meMessage|scheduleMessage)/i,
  /\badmin\./i,
  /\bfiles\.(upload|delete|revokePublicURL)/i,
  /\bconversations\.(create|invite|kick|leave|archive|unarchive|rename|setTopic|setPurpose|close)/i,
  /\b(users|usergroups)\.(admin|create|update|disable|enable)/i,
  /\breactions\.(add|remove)/i,
  /\b(pins|stars|bookmarks)\.(add|remove)/i,
  /\bviews\.(open|publish|push|update)/i,
  /\b(oauth|auth)\.(revoke|token|access)/i,
  // Cross-app write tokens (prefix-friendly for classify / path segments)
  /(?:^|[./_-])(messages\.send|mail\.send|cards?\.create|cards?\.update|boards?\.create)(?:$|[./_?&#-])/i,
  // Path-style write fragments (oauth token endpoints, etc.)
  /\b(chat\.(post|update|delete)|admin\.|files\.(upload|delete)|conversations\.(create|invite|kick|leave|archive)|oauth\.(revoke|token|access))\b/i,
];

/** True when any haystack matches a denied operation pattern. */
export function looksLikeDeniedOperation(...haystacks: Array<string | undefined | null>): boolean {
  for (const raw of haystacks) {
    if (!raw) continue;
    for (const re of REPLAY_DENIED_OPERATION_PATTERNS) {
      if (re.test(raw)) return true;
    }
  }
  return false;
}
