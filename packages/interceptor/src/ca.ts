// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared Sluice CA — ONE root cert for both the mitm proxy (`sluice start`) and
 * the trust installer (`sluice ca-install`). It lives at
 * `~/Library/Application Support/Sluice/ca/` on macOS, key `sluice-ca.key` (0600)
 * and cert `sluice-ca.cert` (0644), and the existing pair is reused whenever both
 * files are present.
 *
 * This is the ONLY definition of those paths. mitm-engine.ts used to carry a
 * second copy, so the proxy and the installer agreed on a root cert only for as
 * long as someone kept two functions hand-synchronised; they now both call
 * `ensureSluiceCA`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadMockttp } from './mockttp-loader.js';

/**
 * Ensure a persisted Sluice CA exists and return the paths to its cert and key.
 * Generates the pair via mockttp on first use; reuses the on-disk files after.
 */
export async function ensureSluiceCA(): Promise<{ caPath: string; keyPath: string }> {
  const dir = join(appDir(), 'ca');
  const keyPath = join(dir, 'sluice-ca.key');
  const caPath = join(dir, 'sluice-ca.cert');

  if (existsSync(keyPath) && existsSync(caPath)) {
    return { caPath, keyPath };
  }

  // Loaded on demand — see the note in mockttp-loader.ts.
  const { generateCACertificate } = await loadMockttp();
  const ca = await generateCACertificate();
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, ca.key, { mode: 0o600 });
  writeFileSync(caPath, ca.cert, { mode: 0o644 });
  return { caPath, keyPath };
}

/**
 * Where the CA cert lives, WITHOUT generating it. `ensureSluiceCA` creates the
 * pair on demand; this only reports the path, so a caller can ask "does the CA
 * exist?" (e.g. the dashboard's first-run check) without the side effect of
 * minting one.
 */
export function sluiceCaCertPath(): string {
  return join(appDir(), 'ca', 'sluice-ca.cert');
}

function appDir(): string {
  const home = homedir();
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Sluice')
    : join(home, '.sluice');
}
