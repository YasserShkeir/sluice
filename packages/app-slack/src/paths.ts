// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Slack desktop file locations (macOS).
 *
 * These moved out of the generic runner so the engine no longer hard-codes any
 * Slack path. Everything here is pure path math — nothing reads a secret.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Every candidate Application Support dir, in preference order: the
 * direct-download path, then the Mac App Store sandboxed container.
 *
 * This is the ONE place those paths are written down. `slack-credentials.ts`
 * carried a second copy, which is exactly how two copies drift when Slack moves
 * something.
 */
export function slackAppSupportDirs(override?: string): string[] {
  if (override) return [override];
  const home = homedir();
  return [
    join(home, 'Library', 'Application Support', 'Slack'),
    join(home, 'Library', 'Containers', 'com.tinyspeck.slackmacgap', 'Data', 'Library', 'Application Support', 'Slack'),
  ];
}

/**
 * Slack's Application Support dir. Prefers whichever exists: the direct-download
 * path, or the Mac App Store sandboxed container. Falls back to the direct path.
 */
export function slackAppSupportDir(): string {
  const candidates = slackAppSupportDirs();
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0]!;
}

/** The LevelDB that holds the `xoxc` client token. */
export function slackLevelDbDir(appSupportDir: string = slackAppSupportDir()): string {
  return join(appSupportDir, 'Local Storage', 'leveldb');
}

/** The encrypted Cookies store that holds the `d` cookie. */
export function slackCookiesPath(appSupportDir: string = slackAppSupportDir()): string {
  return join(appSupportDir, 'Cookies');
}
