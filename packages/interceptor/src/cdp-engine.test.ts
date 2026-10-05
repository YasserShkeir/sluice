// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CDP resource-type filter. Engine C used to drop Document, so SPA listing
 * HTML that embeds JSON never became a Capture. This is the mechanical gate.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldCaptureCdpResource } from './cdp-engine.js';

test('XHR and Fetch are always captured', () => {
  assert.equal(shouldCaptureCdpResource('XHR', false), true);
  assert.equal(shouldCaptureCdpResource('Fetch', false), true);
  assert.equal(shouldCaptureCdpResource('XHR', true), true);
});

test('Document is captured only when an adapter claims the host', () => {
  assert.equal(shouldCaptureCdpResource('Document', true), true);
  assert.equal(shouldCaptureCdpResource('Document', false), false);
});

test('scripts, images, and CSS stay out', () => {
  for (const type of ['Script', 'Stylesheet', 'Image', 'Font', 'Other']) {
    assert.equal(shouldCaptureCdpResource(type, true), false, type);
    assert.equal(shouldCaptureCdpResource(type, false), false, type);
  }
});
