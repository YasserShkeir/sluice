// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The ISOLATED-world bridge.
 *
 * The page-world patch (inject.js) can read fetch/XHR but can't reach the
 * extension APIs; this script can reach chrome.runtime but can't see the page's
 * fetch. So it does one thing: relay the exchanges the patch window.postMessages
 * to the background worker. It validates the shape and the origin so an arbitrary
 * page can't post fake captures straight through us.
 *
 * Bodies are clipped again here as defense-in-depth: inject.js already caps at
 * 512 KiB, but a hostile page can postMessage anything shaped like a capture.
 */
const MAX_BODY = 512 * 1024;
const clip = (s) => (typeof s === 'string' && s.length > MAX_BODY ? s.slice(0, MAX_BODY) : s);

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__sluice !== 'sluice-capture') return;
  const entry = data.entry;
  // Reject null / non-object entries — a bare null used to pass `typeof === 'object'`.
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return;
  const safe = {
    ...entry,
    reqBody: clip(entry.reqBody ?? null),
    resBody: clip(entry.resBody ?? null),
  };
  try {
    chrome.runtime.sendMessage({ type: 'sluice-capture', entry: safe });
  } catch {
    // The background worker may be mid-restart; a dropped capture is acceptable.
  }
});
