// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared Sluice CA — ONE root cert for both the mitm proxy (`sluice start`) and
 * the trust installer (`sluice ca-install`). It lives at
 * `~/Library/Application Support/Sluice/ca/` on macOS, key `sluice-ca.key` (0600)
 * and cert `sluice-ca.cert` (0644), and the existing pair is reused whenever both
 * files are present.
 *
 * This is the ONLY definition of those paths.
 */
import { X509Certificate } from 'node:crypto';
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
  // Owner-only, like the key inside it (applies to directories this creates).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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

/** DER encoding of a CA PEM for `/sluice-ca.cer`; undefined when it is not parseable X.509. */
export function caDer(pem: string): Buffer | undefined {
  try {
    return new X509Certificate(pem).raw;
  } catch {
    return undefined;
  }
}

const CA_PROFILE_UUID = 'a0f3c8e1-6b2d-4c9a-8e11-7d4b2a1c9f01';
const CA_PAYLOAD_UUID = 'a0f3c8e1-6b2d-4c9a-8e11-7d4b2a1c9f02';

/**
 * Unsigned configuration profile that installs the CA as a root
 * (`com.apple.security.root`). iOS Safari treats a bare `.cer` download as a
 * profile; a real mobileconfig is what Settings can install.
 */
export function caMobileconfig(der: Buffer): Buffer {
  const b64 = der.toString('base64');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>sluice-ca.cer</string>
      <key>PayloadContent</key>
      <data>${b64}</data>
      <key>PayloadDescription</key>
      <string>Sluice MITM CA for this Mac's LAN proxy. Remove when finished.</string>
      <key>PayloadDisplayName</key>
      <string>Sluice CA</string>
      <key>PayloadIdentifier</key>
      <string>dev.sluice.ca</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${CA_PAYLOAD_UUID}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key>
  <string>Sluice CA</string>
  <key>PayloadIdentifier</key>
  <string>dev.sluice.profile</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${CA_PROFILE_UUID}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
  return Buffer.from(xml, 'utf8');
}

function appDir(): string {
  const home = homedir();
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Sluice')
    : join(home, '.sluice');
}
