// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react';

/**
 * The blocking first-run gate.
 *
 * Sluice's honest caveats — the ToS position, the credential blast radius, the
 * real account risk — lived only in SECURITY.md in the repo. A user who ran
 * `sluice start` and opened the dashboard installed a trusted MITM CA and read a
 * live session credential without ever being shown any of it. A security posture
 * the user never reads is not a security posture.
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
          These are the caveats in full — they are not fine print.
        </p>

        <ul className="consent-list">
          <li>
            <strong>This is a ToS gray area.</strong> Calling a service's endpoints with a{' '}
            <em>session</em> token is against most services' Terms of Service, even though the
            account is yours, the machine is yours, and nothing leaves the box.
          </li>
          <li>
            <strong>Credential blast radius.</strong> A session token plus its cookie together
            <em> are</em> your logged-in session. Anyone who obtains both can read and act as you
            until the session is revoked.
          </li>
          <li>
            <strong>Real risk to your account.</strong> Rate-limiting, session invalidation, and —
            at an admin's or the service's discretion — account flagging or suspension. Local-only
            data protects the captured bytes; it does not make the access invisible to audit logs.
          </li>
          <li>
            <strong>Your employer's policy may forbid this</strong> even on your own account and
            machine. Sluice cannot adjudicate that for you.
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
          <span>I understand the risks and I am accessing only my own account.</span>
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
