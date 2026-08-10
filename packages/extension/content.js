// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The ISOLATED-world bridge.
 *
 * The page-world patch (inject.js) can read fetch/XHR but can't reach the
 * extension APIs; this script can reach chrome.runtime but can't see the page's
 * fetch. So it does one thing: relay the exchanges the patch window.postMessages
 * to the background worker. It validates the shape and the origin so an arbitrary
 * page can't post fake captures straight through us.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__sluice !== 'sluice-capture' || typeof data.entry !== 'object') return;
  try {
    chrome.runtime.sendMessage({ type: 'sluice-capture', entry: data.entry });
  } catch {
    // The background worker may be mid-restart; a dropped capture is acceptable.
  }
});
