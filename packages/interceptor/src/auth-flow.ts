// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Auth-flow mapping — how a service issues and refreshes the credential you hold.
 *
 * `reconstructCredentials` looks at ONE capture and reports what credential it
 * carries. That cannot see the thing that actually matters for a long-lived
 * session: which endpoint *issued* the credential, and therefore which endpoint
 * would refresh it when it expires. Answering that needs the whole capture
 * history, correlated.
 *
 * The method is deliberately evidence-based rather than heuristic-by-name:
 *   1. Find responses that MINT a credential (Set-Cookie, or a token-shaped value
 *      in a JSON body). Those endpoints are issuers.
 *   2. Find which credential names later appear on outgoing requests. A minted
 *      credential that is subsequently *used* is a real session credential; one
 *      that is never used again is noise (an analytics id, a CSRF echo).
 *   3. Rank issuers by how much traffic depends on what they mint.
 *
 * Nothing here ever emits a secret value. Names, endpoints, counts and redacted
 * previews only — the same rule as everywhere else in the capture path.
 */
import { previewSecret } from '@sluice/core';
import type { Capture } from '@sluice/core';

const MASK = '«redacted»';

/** An endpoint observed handing out a credential. */
export interface CredentialIssuer {
  /** `${method} ${host}${path}` */
  endpoint: string;
  method: string;
  host: string;
  path: string;
  /** Credential names this endpoint was seen to mint (cookie names / body fields). */
  mints: string[];
  /** How many times we saw it issue something. */
  observations: number;
  /**
   * How many later requests carried a credential this endpoint mints. High means
   * "this is the endpoint your session depends on"; zero means it mints something
   * nothing uses.
   */
  dependentRequests: number;
  /** Best guess at what this endpoint is for, from the evidence above. */
  role: 'login' | 'refresh' | 'issues-unused' | 'unknown';
  /** Redacted preview of a minted value, when the capture predates redaction. */
  sample?: string;
}

export interface AuthFlow {
  adapterId: string | null;
  issuers: CredentialIssuer[];
  /** Credential names seen on outgoing requests but never observed being issued. */
  unexplainedCredentials: string[];
  /** Captures considered. */
  sampleCount: number;
}

/** Cookie names that are never a session credential — don't report them as issuers. */
const BORING_COOKIES = /^(_ga|_gid|_gat|_fbp|__utm|ajs_|amplitude|mp_|optimizely|intercom|hubspot)/i;

function splitSetCookie(header: string): Array<{ name: string; value: string }> {
  // Multiple Set-Cookie headers are usually joined with ", " by header maps, but a
  // cookie value may itself contain a comma inside an Expires date, so split on
  // the boundary that starts a new `name=` pair rather than on every comma.
  const out: Array<{ name: string; value: string }> = [];
  for (const part of header.split(/,\s*(?=[^=;,\s]+=)/)) {
    const first = part.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    out.push({ name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim() });
  }
  return out;
}

function cookieNamesFrom(header: string): string[] {
  return header
    .split(';')
    .map((p) => p.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

/** Token-ish field names in a JSON response body that indicate a credential was issued. */
const TOKEN_FIELD = /"((?:access|refresh|id|session|auth|csrf)[_-]?token|token|jwt)"\s*:\s*"([^"]{8,})"/gi;

/**
 * Correlate the whole capture set into an auth flow.
 *
 * `captures` should be in any order; only `ts` is used for ordering, and a
 * credential counts as "depended upon" when it appears on a request issued at or
 * after the response that minted it.
 */
export function mapAuthFlow(captures: Capture[], adapterId: string | null = null): AuthFlow {
  const scoped = adapterId ? captures.filter((c) => c.adapterId === adapterId) : captures;
  const ordered = [...scoped].sort((a, b) => a.ts - b.ts);

  // ── 1. Who mints what ──────────────────────────────────────────────────────
  const issuers = new Map<string, CredentialIssuer>();
  /** credential name → earliest ts at which it was minted */
  const mintedAt = new Map<string, number>();

  for (const c of ordered) {
    const minted: Array<{ name: string; value: string }> = [];

    const setCookie = headerValue(c.resHeaders ?? {}, 'set-cookie');
    if (setCookie && setCookie !== MASK) {
      for (const ck of splitSetCookie(setCookie)) {
        if (BORING_COOKIES.test(ck.name)) continue;
        minted.push(ck);
      }
    } else if (setCookie === MASK) {
      // Redacted, but its presence still tells us this endpoint issues a cookie.
      minted.push({ name: '«cookie»', value: MASK });
    }

    if (c.resBody) {
      TOKEN_FIELD.lastIndex = 0;
      for (;;) {
        const m = TOKEN_FIELD.exec(c.resBody);
        if (!m) break;
        const name = m[1];
        const value = m[2];
        if (!name || !value) continue;
        minted.push({ name, value });
      }
    }

    if (minted.length === 0) continue;

    const endpoint = `${c.method} ${c.host}${c.path}`;
    let entry = issuers.get(endpoint);
    if (!entry) {
      entry = {
        endpoint,
        method: c.method,
        host: c.host,
        path: c.path,
        mints: [],
        observations: 0,
        dependentRequests: 0,
        role: 'unknown',
      };
      issuers.set(endpoint, entry);
    }
    entry.observations += 1;
    for (const m of minted) {
      if (!entry.mints.includes(m.name)) entry.mints.push(m.name);
      if (!mintedAt.has(m.name)) mintedAt.set(m.name, c.ts);
      if (!entry.sample && m.value !== MASK) entry.sample = previewSecret(m.value);
    }
  }

  // ── 2. What later traffic actually depends on ──────────────────────────────
  /** credential name → how many requests carried it after it was minted */
  const used = new Map<string, number>();
  const seenOnRequests = new Set<string>();

  for (const c of ordered) {
    const cookie = headerValue(c.reqHeaders ?? {}, 'cookie');
    const names = cookie && cookie !== MASK ? cookieNamesFrom(cookie) : cookie === MASK ? ['«cookie»'] : [];
    if (headerValue(c.reqHeaders ?? {}, 'authorization')) names.push('authorization');
    for (const n of names) {
      seenOnRequests.add(n);
      const at = mintedAt.get(n);
      if (at !== undefined && c.ts >= at) used.set(n, (used.get(n) ?? 0) + 1);
    }
  }

  for (const entry of issuers.values()) {
    entry.dependentRequests = entry.mints.reduce((n, name) => n + (used.get(name) ?? 0), 0);
    if (entry.dependentRequests === 0) {
      entry.role = 'issues-unused';
    } else if (entry.observations > 1) {
      // Issued repeatedly AND depended upon: that is a refresh endpoint. A login
      // happens once per session; a refresh recurs.
      entry.role = 'refresh';
    } else {
      entry.role = 'login';
    }
  }

  const explained = new Set([...issuers.values()].flatMap((i) => i.mints));
  const unexplained = [...seenOnRequests].filter((n) => !explained.has(n)).sort();

  return {
    adapterId,
    issuers: [...issuers.values()].sort((a, b) => b.dependentRequests - a.dependentRequests),
    unexplainedCredentials: unexplained,
    sampleCount: ordered.length,
  };
}
