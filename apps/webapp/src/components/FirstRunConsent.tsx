// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react';

/**
 * The blocking first-run gate.
 *
 * Product caveats — session credentials, operational effects, workplace policy —
 * lived only in SECURITY.md in the repo. A user who ran `sluice start` and
 * opened the dashboard installed a trusted MITM CA and read a live session
 * credential without ever being shown any of it. A security posture the user
 * never reads is not a security posture.
 *
 * Consent is stored locally (the page is loopback-only, so there is nobody to
 * tell) and the gate blocks the app until it is given.
 */
const CONSENT_KEY = 'sluice.consent.v1';

export function hasConsented(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === 'yes';
  } catch {
    // Storage disabled — ask every time rather than silently letting it through.
    return false;
  }
}

function recordConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, 'yes');
  } catch {
    /* nothing to do — the gate will simply reappear next load */
  }
}

export function FirstRunConsent({ onAccept }: { onAccept: () => void }) {
  const [ack, setAck] = useState(false);

  return (
    <div className="consent-backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="consent-card">
        <h1 id="consent-title">Before you capture anything</h1>
        <p className="consent-lede">
          Sluice reads a credential equivalent to a live, logged-in session, on your own machine.
          A short summary of how Sluice handles session data — worth reading once.
        </p>

        <ul className="consent-list">
          <li>
            <strong>Session tokens vs supported APIs.</strong> Calling a service with a{' '}
            <em>session</em> token is the same class of credential a browser extension would use
            on a logged-in tab. Prefer a workspace-issued API token when one is available.
          </li>
          <li>
            <strong>Credential sensitivity.</strong> A session token plus its cookie together
            <em> are</em> a logged-in session. Treat both as highly sensitive until the session
            is revoked.
          </li>
          <li>
            <strong>Operational effects.</strong> Rate-limiting and session invalidation can still
            happen. Local-only storage protects captured bytes; it does not hide requests from the
            service's own logs.
          </li>
          <li>
            <strong>Workplace policy.</strong> Check any workplace rules that apply to how you
            access company tools on your machine.
          </li>
          <li>
            <strong>Captured traffic is sensitive.</strong> Secrets are redacted before anything is
            stored, but an export is your workspace's content — treat it accordingly.
          </li>
        </ul>

        <p className="consent-note">
          Sluice is local-only and zero-egress: it never sends your data anywhere. Replays are
          restricted to read operations and are rate-limited. You can erase everything at any time
          with <code>sluice wipe --all</code>.
        </p>

        <label className="consent-ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I understand how session credentials are handled and I am using my own local session.</span>
        </label>

        <div className="consent-actions">
          <button
            type="button"
            className="consent-accept"
            disabled={!ack}
            onClick={() => {
              recordConsent();
              onAccept();
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
