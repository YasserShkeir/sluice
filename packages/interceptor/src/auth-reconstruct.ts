// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Auth-reconstructor seed (Phase-B differentiator, Phase-A shape). Scans one
 * Capture for credential-shaped values and returns ranked CredentialHint[].
 *
 * It composes two sources: (1) any adapter's own `extractCredentialHints`, and
 * (2) a generic scan of Authorization / Cookie headers and `token=` body fields.
 * It degrades gracefully on already-redacted captures — it still flags the
 * *presence* and *role* of a credential (with lower confidence) when the value
 * itself has been masked, which is exactly what a reconstruction copilot needs.
 * `valuePreview` is always run through `previewSecret` — never the full secret.
 */
import { previewSecret } from '@sluice/core';
import type { Adapter, Capture, CredentialHint } from '@sluice/core';

const MASK = '«redacted»';

export function reconstructCredentials(capture: Capture, adapters: Adapter[]): CredentialHint[] {
  const out: CredentialHint[] = [];
  const adapterId = capture.adapterId ?? 'unknown';

  // 1. Adapter-specific hints first (highest fidelity — service knows its shapes).
  for (const a of adapters) {
    if (!a.extractCredentialHints) continue;
    try {
      out.push(...a.extractCredentialHints(capture));
    } catch {
      // A faulty adapter must not sink the generic scan.
    }
  }

  // 2. Generic request-header scan.
  for (const [rawName, value] of Object.entries(capture.reqHeaders ?? {})) {
    if (!value) continue;
    const name = rawName.toLowerCase();
    if (name === 'authorization') {
      const bearer = /Bearer\s+(\S+)/i.exec(value);
      const tok = bearer?.[1];
      out.push({
        adapterId,
        location: 'header',
        name: 'authorization',
        valuePreview: previewSecret(tok ?? value),
        confidence: tok ? 0.7 : 0.5,
        role: 'bearer',
      });
    } else if (name === 'cookie') {
      const cookieHints = scanCookies(value, adapterId);
      if (cookieHints.length > 0) {
        out.push(...cookieHints);
      } else {
        // Redacted / opaque cookie header: still a session credential is present.
        out.push({
          adapterId,
          location: 'cookie',
          name: 'cookie',
          valuePreview: previewSecret(value),
          confidence: 0.5,
          role: 'session-cookie',
        });
      }
    }
  }

  // 3. Response Set-Cookie (a session being established).
  for (const [rawName, value] of Object.entries(capture.resHeaders ?? {})) {
    if (rawName.toLowerCase() !== 'set-cookie' || !value) continue;
    out.push(...scanCookies(value, adapterId));
  }

  // 4. Request body: a `token=…` form field or `"token":"…"` JSON field.
  if (capture.reqBody) {
    const b = capture.reqBody;
    const form =
      /(?:^|[&?])token=([^&\s"']+)/i.exec(b) ??
      /"token"\s*:\s*"([^"]+)"/i.exec(b);
    const tok = form?.[1];
    if (tok && !tok.includes(MASK)) {
      out.push({
        adapterId,
        location: 'body',
        name: 'token',
        valuePreview: previewSecret(tok),
        confidence: 0.9,
        role: 'bearer',
      });
    } else if (/(?:^|[&?])token=/.test(b) || /"token"\s*:/.test(b)) {
      // A masked token field still tells us the credential lives in the body.
      out.push({
        adapterId,
        location: 'body',
        name: 'token',
        valuePreview: 'present (redacted)',
        confidence: 0.6,
        role: 'bearer',
      });
    }
  }

  return dedupe(out);
}

/** Parse a Cookie / Set-Cookie header into credential hints for known-sensitive names. */
function scanCookies(header: string, adapterId: string): CredentialHint[] {
  const hints: CredentialHint[] = [];
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const cname = part.slice(0, eq).trim();
    const cval = part.slice(eq + 1).trim();
    if (!cval) continue;
    // Generic session-cookie names; app-specific cookies (e.g. an app's `d`
    // cookie) are surfaced by that app's own extractCredentialHints.
    if (/sess|sid|token|auth|sso|jwt/.test(cname.toLowerCase())) {
      hints.push({
        adapterId,
        location: 'cookie',
        name: cname,
        valuePreview: previewSecret(cval),
        confidence: 0.45,
        role: 'session-cookie',
      });
    }
  }
  return hints;
}

/** Keep the highest-confidence hint per (location,name); sort most-confident first. */
function dedupe(hints: CredentialHint[]): CredentialHint[] {
  const best = new Map<string, CredentialHint>();
  for (const h of hints) {
    const key = `${h.location}:${h.name.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || h.confidence > prev.confidence) best.set(key, h);
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}
