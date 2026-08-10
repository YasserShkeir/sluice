// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The background service worker — batches captured exchanges and POSTs them to a
 * local Sluice runner's /api/ingest.
 *
 * Two rules keep this privacy-safe by construction:
 *   - It sends NOTHING until the user has configured a runner endpoint + ingest
 *     token AND at least one in-scope host. An unconfigured extension is inert.
 *   - It only forwards exchanges whose host matches the user's allowlist, so
 *     "capture my Slack" never quietly ships your bank. Scope lives here, not in
 *     the page patch, which stays a dumb observer.
 *
 * The token is the runner's ingest secret (printed by `sluice serve --ingest`);
 * host_permissions for loopback let this fetch bypass CORS.
 */
const KEYS = ['endpoint', 'token', 'hosts', 'enabled'];

/** Only loopback runners are allowed — never ship captures off-box. */
function isLoopbackEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = (u.hostname || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

const FLUSH_MS = 2000;
const FLUSH_AT = 50;
const MAX_BATCH = 500;

let queue = [];
let flushTimer = null;

async function config() {
  const c = await chrome.storage.local.get(KEYS);
  return {
    endpoint: (c.endpoint || 'http://127.0.0.1:7788').replace(/\/+$/, ''),
    token: c.token || '',
    hosts: String(c.hosts || '')
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    enabled: c.enabled !== false,
  };
}

function hostAllowed(url, hosts) {
  if (hosts.length === 0) return false; // default-deny until scoped
  let host;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'sluice-capture') void enqueue(msg.entry);
});

async function enqueue(entry) {
  const cfg = await config();
  if (!cfg.enabled || !cfg.token) return;
  if (!hostAllowed(entry.url, cfg.hosts)) return;
  queue.push(entry);
  if (queue.length >= FLUSH_AT) void flush();
  else scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => void flush(), FLUSH_MS);
}

async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  const cfg = await config();
  if (!cfg.token) return;
  if (!isLoopbackEndpoint(cfg.endpoint)) {
    console.warn('[sluice] refusing non-loopback endpoint', cfg.endpoint);
    return;
  }
  try {
    await fetch(`${cfg.endpoint}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ captures: batch }),
    });
  } catch {
    // The runner is down or unreachable. Drop the batch rather than let the queue
    // grow without bound in a service worker that may be suspended at any moment.
  }
}
