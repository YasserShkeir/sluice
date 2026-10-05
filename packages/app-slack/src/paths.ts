// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Slack desktop file locations (macOS).
 *
 * Everything here is pure path math — nothing reads a secret.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Every candidate Application Support dir, in preference order: the
 * direct-download path, then the Mac App Store sandboxed container.
 *
 * This is the ONE place those paths are written down.
 */
export function slackAppSupportDirs(override?: string): string[] {
  if (override) return [override];
  const home = homedir();
  return [
    join(home, 'Library', 'Application Support', 'Slack'),
    join(home, 'Library', 'Containers', 'com.tinyspeck.slackmacgap', 'Data', 'Library', 'Application Support', 'Slack'),
  ];
}
