<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Sluice Capture (MV3 browser extension — "Engine C")

A passive capture path that needs no proxy and no CA. It runs a small patch in
each page's own JavaScript context, sees `fetch`/`XMLHttpRequest` the way the app
does — real URL, headers, string request bodies, and the already-decrypted
response body — and POSTs each exchange to a local Sluice runner's `/api/ingest`.

It is the counterpart to the MITM engine (Engine A): the proxy decrypts at the
network layer and needs a trusted CA; this reads inside the page and needs
neither. It only ever captures traffic your browser was already making.

## Why you might use it

- No system proxy, no CA install — nothing about your machine's networking
  changes.
- Captures exactly what the page's JS sees, including SPA `fetch` calls that a
  transparent proxy would still get but that some corporate setups make awkward
  to intercept.

## Privacy model

- **Default-deny.** Nothing is sent until you configure a runner endpoint, an
  ingest token, **and** at least one in-scope host. An unconfigured extension is
  inert.
- **Scoped.** Only requests to the hosts you list (and their subdomains) are
  forwarded — "capture my Slack" does not ship your bank.
- **Loopback only.** It can reach `127.0.0.1` / `localhost` and nothing else.
- **Its own secret.** The ingest token is separate from the dashboard read token
  and from the terminal's pty token, is minted only with `sluice serve --ingest`,
  and gates the one POST the API accepts. The runner still re-redacts every
  exchange on the way in.

## Install (unpacked)

1. Start the runner with ingest enabled:

   ```sh
   sluice serve --ingest
   ```

   Note the `Ingest token:` and the runner URL it prints.

2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and select this `packages/extension/` directory.

3. Open the extension's **Options** (or click its toolbar icon), then set:
   - **Runner endpoint** — the loopback URL Sluice printed (e.g.
     `http://127.0.0.1:7788`).
   - **Ingest token** — the token from step 1.
   - **In-scope hosts** — one per line, e.g. `slack.com`, `trello.com`.

4. Browse those sites. Captured exchanges appear in the Sluice dashboard's
   traffic table with source `ext`.

## How it fits together

```
page world (inject.js)  ──window.postMessage──▶  isolated world (content.js)
  patches fetch/XHR                                validates the message,
  clips bodies at 512 KiB                          re-clips bodies, then
                                                   chrome.runtime.sendMessage
                                                            │
                                                            ▼
                                            background.js  ──POST /api/ingest──▶  Sluice runner
                                              (batches, scopes by host,           (redact → attribute →
                                               authenticates with the token)       parse → store → stream)
```

`content.js` is a validator, not a relay: it checks `event.source === window`
and the `__sluice` tag, rejects null / array / non-object entries, and re-clips
both bodies — a hostile page can `postMessage` anything shaped like a capture.

## Limitations

Most of these lose data *silently*, which looks identical to "the extension
isn't working".

- **A failed POST drops the whole batch.** `flush()` splices the queue before
  the fetch and does not retry or re-queue: a stopped runner, the wrong port, or
  a rejected ingest token all just lose those captures, with nothing shown to
  you. The queue is bounded that way on purpose — a service worker can be
  suspended at any moment.
- **A non-loopback endpoint only warns.** `console.warn` in the service worker,
  then it returns; nothing is sent, and the options page says nothing.
- **A paused dashboard discards.** The runner honours its global pause switch on
  `/api/ingest`: while capture is paused it answers `200 {ingested: 0, paused: true}`
  and writes nothing.
- **Runner caps return 413.** 32 MiB per POST and 500 captures per batch. The
  extension already flushes at most 500 per batch, so size is the one you can
  hit.
- The service worker batches in memory; if Chrome suspends it between flushes, a
  few of the most recent exchanges can be lost. Captures during active browsing
  (when the worker stays alive) are unaffected.
- **Request and response bodies are each clipped at 512 KiB**, in `inject.js` and
  again in `content.js`.
- **Only string request bodies are captured.** `init.body` is recorded only when
  it is a plain string, so a `FormData`, `Blob`, `URLSearchParams`,
  `ArrayBuffer` or `ReadableStream` body — or one carried on a `Request` object
  passed as `input` — arrives as `null`. Same on the XHR path.
- **XHRs with an exotic `responseType` capture no body.** The response is read
  only when `responseType` is `''` or `'text'`; `json`, `blob` and
  `arraybuffer` produce a capture with an empty `resBody`.
- WebSocket frames are not captured by this engine (the MITM and CDP engines do,
  text frames only).

## Capture completeness

See the engine matrix in [`packages/interceptor/README.md`](../interceptor/README.md)
(F0): this extension covers `fetch`/XHR on allowlisted hosts only — not WebSockets,
beacons, or document navigations.
