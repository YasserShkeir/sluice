// SPDX-License-Identifier: AGPL-3.0-or-later
/** Settings shared by the service worker and the options page. */
export const KEYS = ['endpoint', 'token', 'hosts', 'enabled'];

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:7788';

/** Only loopback runners are allowed — never ship captures off-box. */
export function isLoopbackEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = (u.hostname || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}
