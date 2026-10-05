// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared helpers the capture engines (and replay) use to attribute and build
 * Captures: one body cap and the ONE place their output is redacted, so the
 * engines cannot drift apart on either. Attribution is core's `matchAdapter`.
 */
import { matchAdapter, newId, redactCapture, splitUrl } from '@sluice/core';
import type { Adapter, Capture, FrameDirection } from '@sluice/core';

/** Cap a single body at ~5 MB so a pathological payload can't OOM the runner. */
export const MAX_CAPTURE_BODY = 5_000_000;

/** Truncate a body to {@link MAX_CAPTURE_BODY}, saying how much was cut. */
export function capBody(s: string): string {
  return s.length > MAX_CAPTURE_BODY
    ? `${s.slice(0, MAX_CAPTURE_BODY)}…[truncated ${s.length - MAX_CAPTURE_BODY} chars]`
    : s;
}

/** What an engine observed, un-redacted; id/pid/processName are filled by redactedCapture. */
export type RawCapture = Omit<Capture, 'id' | 'pid' | 'processName'>;

/**
 * Core `redactCapture` (headers, bodies, every URL-like field), as the runner
 * ingest funnel applies. Cap bodies with capBody first: truncate, then redact.
 */
export function redactedCapture(raw: RawCapture): Capture {
  return redactCapture({ ...raw, id: newId('cap'), pid: null, processName: null });
}

/**
 * One text WebSocket frame → one Capture. The payload goes in reqBody for a sent
 * frame and resBody for a received one, so the inspector renders it without
 * special-casing; `direction` is from the page's point of view.
 */
export function wsFrameCapture(f: {
  adapters: readonly Adapter[];
  url: string;
  wsId: string;
  direction: FrameDirection;
  text: string;
  tabId?: string;
  tabUrl?: string;
  onError?: (e: unknown) => void;
}): Capture {
  const { host, path } = splitUrl(f.url || 'https://unknown/');
  const body = capBody(f.text);
  return redactedCapture({
    ts: Date.now(),
    source: 'ws',
    adapterId: matchAdapter(f.adapters, { host, path, method: 'WS', url: f.url }, f.onError)?.id ?? null,
    method: 'WS',
    url: f.url,
    host,
    path,
    status: null,
    durationMs: null,
    reqHeaders: {},
    reqBody: f.direction === 'sent' ? body : null,
    resHeaders: {},
    resBody: f.direction === 'received' ? body : null,
    ...(f.tabId !== undefined ? { tabId: f.tabId, tabUrl: f.tabUrl } : {}),
    direction: f.direction,
    wsId: f.wsId,
  });
}
