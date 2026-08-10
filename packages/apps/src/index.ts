// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/apps — the installed-apps registry.
 *
 * This is the ONE place that names specific app packages (analogous to a
 * plugins config). Everything upstream — the runner, the MCP server — drives
 * off the generic `App[]` this exposes and never imports an app package
 * directly. To install another app, add its package here.
 */
import type { App } from '@sluice/core';
import { registerAppRedaction } from '@sluice/core';
import { slackApp } from '@sluice/app-slack';
import { fastApp } from '@sluice/app-fast';
import { trelloApp } from '@sluice/app-trello';
import { gmailApp } from '@sluice/app-gmail';
import { loomApp } from '@sluice/app-loom';
import { linkedinApp } from '@sluice/app-linkedin';
import { checkConformance } from '@sluice/adapter-sdk';
import { discoverAdapters, readEnabledAdapterIds } from './discover.js';
import type { DiscoverOptions, DiscoveryResult } from './discover.js';

/** Every installed app, in registration order. `apps[0]` is the default. */
export const apps: App[] = [slackApp, fastApp, trelloApp, gmailApp, loomApp, linkedinApp];

/**
 * Load every installed app's redaction contributions into the global policy, at
 * import time. Redaction happens before a capture is attributed to an adapter,
 * so the policy has to be complete before the first byte is captured — and every
 * process that can capture (runner, mcp) imports this registry. Doing it here,
 * rather than in each entrypoint, means a new app cannot be installed with its
 * token shapes left unregistered.
 */
registerAppRedaction(apps);

/**
 * Load the external adapters the home config names, and register them.
 *
 * NOT called at import time, unlike `registerAppRedaction` above, and the
 * difference is deliberate. Redaction has to be complete before the first byte
 * is captured, so it cannot wait; loading third-party code is a decision, and a
 * decision belongs to an entrypoint that can report what it did. `sluice start`
 * calls this and prints the hosts each one added.
 *
 * Appended, never prepended: registration order decides which adapter is offered
 * a capture first, and the built-ins must keep winning ties.
 */
export async function installExternalAdapters(
  opts: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const result = await discoverAdapters({
    taken: new Set(apps.map((a) => a.id)),
    check: checkConformance,
    ...opts,
  });
  if (result.loaded.length === 0) return result;
  const added = result.loaded.map((d) => d.app);
  apps.push(...added);
  // Their token shapes have to reach the global policy too, or an external
  // adapter's secrets are the one kind Sluice does not redact.
  registerAppRedaction(added);
  return result;
}

/**
 * The apps this machine is configured to use, in registration order.
 *
 * Filtering matters here for a reason that is not code size — the four app
 * packages are 428 KB of source against a 12 MB mockttp chunk, so nobody is
 * saving a download. It matters because **every registered adapter's `hosts[]`
 * seeds the proxy's TLS-intercept list**. Someone who installed Sluice for Slack
 * should not have `mail.google.com` decryptable, and the allow-list is what says
 * so. The tool surface an MCP client sees is the second reason and the smaller
 * one.
 *
 * REDACTION IS DELIBERATELY NOT FILTERED. `registerAppRedaction` runs over every
 * built-in at import, above, and stays that way: redaction happens before a
 * capture is attributed to any adapter, so knowing Slack's token shapes protects
 * you on a machine that never captures Slack. Narrowing what is captured must
 * not narrow what is scrubbed.
 */
export function enabledApps(allow = readEnabledAdapterIds()): App[] {
  if (allow === undefined || allow.length === 0) return apps;
  const known = new Set(apps.map((a) => a.id));
  const unknown = allow.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown adapter id(s) in config: ${unknown.join(', ')}. Installed: ${[...known].join(', ')}`,
    );
  }
  return apps.filter((a) => allow.includes(a.id));
}

/** Look up an installed app by its adapter id. */
export function getApp(id: string): App | undefined {
  return apps.find((a) => a.id === id);
}

export { discoverAdapters, describeDiscovery, externalConfigPath, readEnabledAdapterIds } from './discover.js';
export type { DiscoveredAdapter, DiscoveryResult, RejectedAdapter } from './discover.js';
