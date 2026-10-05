// SPDX-License-Identifier: Apache-2.0
/**
 * Resolving a session's `CredentialInjection` into the values that go on the
 * wire.
 *
 * Each `injection.headers` / `.query` / `.cookies` entry maps a wire NAME to the
 * KEY in `credentials.values` that holds its secret, falling back to the ref
 * itself as a literal so a pre-baked value still works. Reading it the other
 * way round emits the key — the string `sidValue` as a cookie value, or
 * `cookieHeader` as a header — producing a request that looks correct and is
 * unauthenticated. cartographer's flow-build reads the same NAME→KEY maps but is
 * stricter: it has no literal fallback.
 *
 * Every result is SECRET: it is built only to send, never to log or store.
 */
import type { Session } from '@sluice/core';

function resolveMap(
  map: Record<string, string> | undefined,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, ref] of Object.entries(map ?? {})) {
    // Own keys only: a ref of `constructor` is a literal, not Object.prototype's.
    const value = Object.hasOwn(values, ref) ? values[ref] : ref;
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

/**
 * `injection.headers` resolved to header name → value; empty values skipped.
 *
 * @example
 * Object.assign(headers, injectedHeaders(session));
 */
export function injectedHeaders(session: Session): Record<string, string> {
  return resolveMap(session.credentials.injection.headers, session.credentials.values);
}

/** `injection.query` resolved to param name → value; empty values skipped. */
export function injectedQuery(session: Session): Record<string, string> {
  return resolveMap(session.credentials.injection.query, session.credentials.values);
}

/**
 * `injection.cookies` resolved and joined as one `Cookie` header value
 * (`a=1; b=2`), or undefined when it resolves to nothing — so a caller can fall
 * back to a pre-assembled `values.cookieHeader`.
 *
 * @example
 * const cookie = injectedCookieHeader(session) ?? session.credentials.values.cookieHeader;
 * if (cookie) headers.Cookie = cookie;
 */
export function injectedCookieHeader(session: Session): string | undefined {
  const pairs = Object.entries(
    resolveMap(session.credentials.injection.cookies, session.credentials.values),
  ).map(([name, value]) => `${name}=${value}`);
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}
