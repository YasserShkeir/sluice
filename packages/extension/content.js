// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The ISOLATED-world bridge.
 *
 * The page-world patch (inject.js) can read fetch/XHR but can't reach the
 * extension APIs; this script can reach chrome.runtime but can't see the page's
 * fetch. So it does one thing: relay the exchanges the patch window.postMessages
 * to the background worker.
 *
 * It CANNOT tell the patch's messages from the page's own: both run in the same
 * window, and the tag is public. So it does not pretend to. It copies only the
 * fields inject.js emits, type-checked, so a poster cannot choose a capture's id,
 * host, path or tab; and scope is enforced in background.js against the frame the
 * browser says this script ran in, not against anything in the message. Script
 * running on an in-scope page (including third-party script that page loads) can
 * still forge captures for in-scope hosts — a MAIN-world bridge cannot be
 * authenticated.
 *
 * Bodies are clipped again here as defense-in-depth: inject.js already caps at
 * 512 KiB, but a hostile page can postMessage anything shaped like a capture.
 */
const MAX_BODY = 512 * 1024;
const clip = (s) => (typeof s === 'string' && s.length > MAX_BODY ? s.slice(0, MAX_BODY) : s);
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A header map with only string values; anything else becomes empty. */
function hdrs(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  }
  return out;
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__sluice !== 'sluice-capture') return;
  const entry = data.entry;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
  const method = str(entry.method);
  const url = str(entry.url);
  if (!method || !url) return;
  // Exactly the fields inject.js posts. No id, host, path or tab: the runner
  // mints the id and derives host/path from the URL.
  const safe = {
    method,
    url,
    status: num(entry.status),
    durationMs: num(entry.durationMs),
    reqHeaders: hdrs(entry.reqHeaders),
    resHeaders: hdrs(entry.resHeaders),
    reqBody: clip(str(entry.reqBody)),
    resBody: clip(str(entry.resBody)),
    ts: num(entry.ts),
  };
  try {
    chrome.runtime.sendMessage({ type: 'sluice-capture', entry: safe });
  } catch {
    // The background worker may be mid-restart; a dropped capture is acceptable.
  }
});
