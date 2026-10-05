// SPDX-License-Identifier: AGPL-3.0-or-later
/** Options page: load/save the runner endpoint, ingest token, host allowlist, and on/off. */
import { DEFAULT_ENDPOINT, KEYS, isLoopbackEndpoint } from './shared.js';

const $ = (id) => document.getElementById(id);

async function load() {
  const c = await chrome.storage.local.get(KEYS);
  $('endpoint').value = c.endpoint || DEFAULT_ENDPOINT;
  $('token').value = c.token || '';
  $('hosts').value = c.hosts || '';
  $('enabled').checked = c.enabled !== false;
}

async function save() {
  const status = $('status');
  const endpoint = $('endpoint').value.trim();
  if (!isLoopbackEndpoint(endpoint)) {
    status.textContent = 'Endpoint must be loopback (127.0.0.1, localhost, or [::1]).';
    return;
  }
  await chrome.storage.local.set({
    endpoint,
    token: $('token').value.trim(),
    hosts: $('hosts').value.trim(),
    enabled: $('enabled').checked,
  });
  status.textContent = 'Saved.';
  setTimeout(() => {
    status.textContent = '';
  }, 1500);
}

$('save').addEventListener('click', () => void save());
void load();
