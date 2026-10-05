// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The HTTP API client. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTable } from './api.js';

test('the HTTP API sends the session token as a Bearer header, never in the URL', async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  // No sessionStorage/history: ws.ts's try/catch falls back to reading the hash.
  g.window = {};
  g.location = { hash: '#k=synthetic-tok', search: '', pathname: '/' };
  let url = '';
  let init: RequestInit | undefined;
  g.fetch = async (u: string, i?: RequestInit) => {
    url = u;
    init = i;
    return new Response('{}');
  };
  await fetchTable('t', 10, 0);
  assert.ok(!url.includes('synthetic-tok') && !url.includes('token='), url);
  assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, 'Bearer synthetic-tok');
});
