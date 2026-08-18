// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from 'react';
import { Button } from '../ui/button.js';

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
    <div
      className="fixed inset-0 z-[100] grid place-items-center overflow-y-auto bg-bg p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-title"
    >
      <div className="w-full max-w-[660px] rounded-lg border border-border-2 bg-bg-1 px-[30px] py-7 font-sans leading-relaxed">
        <h1 id="consent-title" className="mb-2.5 text-[19px] font-semibold text-fg">
          Before you capture anything
        </h1>
        <p className="mb-[18px] text-[13.5px] text-fg-dim">
          Sluice reads a credential equivalent to a live, logged-in session, on your own machine. A
          short summary of how Sluice handles session data — worth reading once.
        </p>

        <ul className="mb-[18px] list-disc space-y-2.5 pl-5 text-[13px] text-fg">
          <li>
            <strong className="font-semibold text-warn">Session tokens vs supported APIs.</strong>{' '}
            Calling a service with a <em>session</em> token is the same class of credential a browser
            extension would use on a logged-in tab. Prefer a workspace-issued API token when one is
            available.
          </li>
          <li>
            <strong className="font-semibold text-warn">Credential sensitivity.</strong> A session
            token plus its cookie together <em>are</em> a logged-in session. Treat both as highly
            sensitive until the session is revoked.
          </li>
          <li>
            <strong className="font-semibold text-warn">Operational effects.</strong> Rate-limiting and
            session invalidation can still happen. Local-only storage protects captured bytes; it
            does not hide requests from the service&apos;s own logs.
          </li>
          <li>
            <strong className="font-semibold text-warn">Workplace policy.</strong> Check any workplace
            rules that apply to how you access company tools on your machine.
          </li>
          <li>
            <strong className="font-semibold text-warn">Captured traffic is sensitive.</strong> Secrets
            are redacted before anything is stored, but an export is your workspace&apos;s content —
            treat it accordingly.
          </li>
        </ul>

        <p className="mb-5 rounded border-l-2 border-ok bg-bg-2 px-3.5 py-2.5 text-[12.5px] text-fg-dim">
          Sluice is local-only and zero-egress: it never sends your data anywhere. Replays are
          restricted to read operations and are rate-limited. You can erase everything at any time
          with <code className="font-mono text-fg">sluice wipe --all</code>.
        </p>

        <label className="mb-[18px] flex cursor-pointer items-start gap-2.5 text-[13px] text-fg">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-1 shrink-0 accent-[var(--accent)]"
          />
          <span>I understand how session credentials are handled and I am using my own local session.</span>
        </label>

        <div className="flex justify-end">
          <Button
            variant="primary"
            size="md"
            disabled={!ack}
            className="h-8 px-5 text-[13px]"
            onClick={() => {
              recordConsent();
              onAccept();
            }}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
