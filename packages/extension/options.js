// SPDX-License-Identifier: AGPL-3.0-or-later
/** Options page: load/save the runner endpoint, ingest token, host allowlist, and on/off. */
const KEYS = ['endpoint', 'token', 'hosts', 'enabled'];
const $ = (id) => document.getElementById(id);

/** Only loopback runners are allowed — never ship captures off-box. */
function isLoopbackEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = (u.hostname || '').toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

async function load() {
  const c = await chrome.storage.local.get(KEYS);
  $('endpoint').value = c.endpoint || 'http://127.0.0.1:7788';
  $('token').value = c.token || '';
  $('hosts').value = c.hosts || '';
  $('enabled').checked = c.enabled !== false;
}

async function save() {
  const endpoint = $('endpoint').value.trim();
  if (!isLoopbackEndpoint(endpoint)) {
    const status = $('status');
    status.textContent =
      'Endpoint must be loopback (127.0.0.1, localhost, or [::1]).';
    return;
  }
  await chrome.storage.local.set({
    endpoint,
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
