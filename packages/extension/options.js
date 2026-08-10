// SPDX-License-Identifier: AGPL-3.0-or-later
/** Options page: load/save the runner endpoint, ingest token, host allowlist, and on/off. */
const KEYS = ['endpoint', 'token', 'hosts', 'enabled'];
const $ = (id) => document.getElementById(id);

async function load() {
  const c = await chrome.storage.local.get(KEYS);
  $('endpoint').value = c.endpoint || 'http://127.0.0.1:7788';
  $('token').value = c.token || '';
  $('hosts').value = c.hosts || '';
  $('enabled').checked = c.enabled !== false;
}

async function save() {
  await chrome.storage.local.set({
    endpoint: $('endpoint').value.trim(),
    token: $('token').value.trim(),
    hosts: $('hosts').value.trim(),
    enabled: $('enabled').checked,
  });
  const status = $('status');
  status.textContent = 'Saved.';
  setTimeout(() => {
    status.textContent = '';
  }, 1500);
}

$('save').addEventListener('click', () => void save());
void load();
