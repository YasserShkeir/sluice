// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The page-world (MAIN) capture patch — Engine C's eyes.
 *
 * Runs in the page's own JS context, so it sees fetch/XHR the way the app does:
 * the real URL, headers, request body, and — the part a proxy needs a CA to get —
 * the DECRYPTED response body, with no TLS termination required. It never talks to
 * the extension APIs (a MAIN-world script can't); it only window.postMessages each
 * exchange to the ISOLATED-world bridge (content.js), which relays it to the
 * background worker.
 *
 * It captures; it does not decide. What's in scope (which hosts) and where it goes
 * are the background's job, so this stays a dumb, side-effect-free observer that
 * can't leak: with no bridge listening, or no runner configured, nothing leaves.
 */
(() => {
  const TAG = 'sluice-capture';
  // Cap a single body we read into memory. The runner caps the batch too; this
  // just keeps a multi-megabyte response from blocking the page's own JS.
  const MAX_BODY = 512 * 1024;

  function post(entry) {
    try {
      window.postMessage({ __sluice: TAG, entry }, window.location.origin);
    } catch {
      /* postMessage can throw on exotic origins — dropping one capture is fine */
    }
  }

  function headersToObj(h) {
    const o = {};
    try {
      h.forEach((v, k) => {
        o[k] = v;
      });
    } catch {
      /* not a Headers instance */
    }
    return o;
  }

  function parseRawHeaders(raw) {
    const o = {};
    for (const line of (raw || '').trim().split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) o[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return o;
  }

  const clip = (s) => (typeof s === 'string' && s.length > MAX_BODY ? s.slice(0, MAX_BODY) : s);

  // ── fetch ──────────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const started = Date.now();
      let req;
      try {
        req = new Request(input, init);
      } catch {
        return origFetch.apply(this, arguments);
      }
      const reqBody = init && typeof init.body === 'string' ? init.body : null;
      return origFetch.apply(this, arguments).then((res) => {
        try {
          res
            .clone()
            .text()
            .then((text) => {
              post({
                method: req.method,
                url: req.url,
                status: res.status,
                durationMs: Date.now() - started,
                reqHeaders: headersToObj(req.headers),
                resHeaders: headersToObj(res.headers),
                reqBody,
                resBody: clip(text),
                ts: started,
              });
            })
            .catch(() => {});
        } catch {
          /* opaque/no-cors response — nothing readable */
        }
        return res;
      });
    };
  }

  // ── XMLHttpRequest ───────────────────────────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  if (typeof OrigXHR === 'function') {
    const open = OrigXHR.prototype.open;
    const setRequestHeader = OrigXHR.prototype.setRequestHeader;
    const send = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function (method, url) {
      this.__sluice = { method, url, reqHeaders: {}, started: Date.now() };
      return open.apply(this, arguments);
    };
    OrigXHR.prototype.setRequestHeader = function (k, v) {
      if (this.__sluice) this.__sluice.reqHeaders[k] = v;
      return setRequestHeader.apply(this, arguments);
    };
    OrigXHR.prototype.send = function (body) {
      const meta = this.__sluice;
      if (meta) {
        meta.reqBody = typeof body === 'string' ? body : null;
        this.addEventListener('load', () => {
          let resBody = '';
          try {
            if (this.responseType === '' || this.responseType === 'text') resBody = this.responseText;
          } catch {
            /* responseText unavailable for this responseType */
          }
          let url = meta.url;
          try {
            url = new URL(meta.url, window.location.href).href;
          } catch {
            /* keep the raw url */
          }
          post({
            method: meta.method,
            url,
            status: this.status,
            durationMs: Date.now() - meta.started,
            reqHeaders: meta.reqHeaders,
            resHeaders: parseRawHeaders(this.getAllResponseHeaders()),
            reqBody: meta.reqBody,
            resBody: clip(resBody),
            ts: meta.started,
          });
        });
      }
      return send.apply(this, arguments);
    };
  }
})();
