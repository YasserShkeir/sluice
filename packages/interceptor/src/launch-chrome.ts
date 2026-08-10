// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Launch a dedicated, debug-enabled Chrome instance for Engine C.
 *
 * It uses its OWN user-data-dir (default ~/.sluice/chrome) so it never touches the
 * user's main browser or profile. You sign in once in this window and the
 * session persists there for next time. Chrome must be started with the debug port
 * (you can't enable it on an already-running instance), which is why we spawn one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function defaultChromePath(): string {
  return MAC_CHROME;
}

export function defaultChromeProfileDir(): string {
  return join(homedir(), '.sluice', 'chrome');
}

export interface LaunchChromeOptions {
  port: number;
  userDataDir?: string;
  startUrl?: string;
  chromePath?: string;
  headless?: boolean;
}

export interface LaunchedChrome {
  pid: number | undefined;
  child: ChildProcess;
  close: () => void;
}

export async function launchDebugChrome(opts: LaunchChromeOptions): Promise<LaunchedChrome> {
  const chromePath = opts.chromePath ?? defaultChromePath();
  if (!existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath} — pass chromePath or install Google Chrome.`);
  }
  const userDataDir = opts.userDataDir ?? defaultChromeProfileDir();
  mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*', // allow the local CDP client to attach (Chrome 111+)
    ...(opts.headless ? ['--headless=new'] : []),
    opts.startUrl ?? 'about:blank',
  ];

  const child = spawn(chromePath, args, { stdio: 'ignore', detached: false });
  child.on('error', () => {
    /* surfaced via the readiness poll below */
  });

  await waitForDebugPort(opts.port, 15_000);
  return {
    pid: child.pid,
    child,
    close: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Poll the CDP HTTP endpoint until it answers or we time out. */
async function waitForDebugPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await delay(200);
  }
  const detail = lastErr instanceof Error ? `: ${lastErr.message}` : '';
  throw new Error(`Chrome debug port ${port} did not become ready within ${timeoutMs}ms${detail}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
