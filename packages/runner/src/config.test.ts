// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureSluiceHome, resolveInterceptScope, writePrivateFile } from './config.js';

test('resolveInterceptScope defaults to all hosts when nothing is set', () => {
  const s = resolveInterceptScope({ config: {} });
  assert.deepEqual(s, { interceptHosts: [], interceptAllHosts: true });
});

test('resolveInterceptScope scopes when --host is passed', () => {
  const s = resolveInterceptScope({ config: {}, cliHosts: ['linkedin.com'] });
  assert.equal(s.interceptAllHosts, false);
  assert.deepEqual(s.interceptHosts, ['linkedin.com']);
});

test('resolveInterceptScope scopes when config.interceptHosts is set', () => {
  const s = resolveInterceptScope({ config: { interceptHosts: ['*.example.com'] } });
  assert.equal(s.interceptAllHosts, false);
  assert.deepEqual(s.interceptHosts, ['*.example.com']);
});

test('resolveInterceptScope merges config hosts with CLI hosts', () => {
  const s = resolveInterceptScope({
    config: { interceptHosts: ['a.com'] },
    cliHosts: ['b.com'],
  });
  assert.equal(s.interceptAllHosts, false);
  assert.deepEqual(s.interceptHosts, ['a.com', 'b.com']);
});

test('resolveInterceptScope respects interceptAllHosts: false with empty hosts', () => {
  const s = resolveInterceptScope({ config: { interceptAllHosts: false } });
  assert.deepEqual(s, { interceptHosts: [], interceptAllHosts: false });
});

test('resolveInterceptScope --all-hosts wins over a host list', () => {
  const s = resolveInterceptScope({
    config: { interceptHosts: ['only.this'] },
    cliHosts: ['also.this'],
    cliAllHosts: true,
  });
  assert.equal(s.interceptAllHosts, true);
  assert.deepEqual(s.interceptHosts, ['only.this', 'also.this']);
});

test('resolveInterceptScope config interceptAllHosts: true wins over host list', () => {
  const s = resolveInterceptScope({
    config: { interceptHosts: ['x.com'], interceptAllHosts: true },
  });
  assert.equal(s.interceptAllHosts, true);
});

// ── ~/.sluice permissions ─────────────────────────────────────────────────────
// A temp HOME per test: the real ~/.sluice must never be touched by a test run.

function withTempHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'sluice-home-'));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    fn(home);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

const posix = process.platform !== 'win32';

test('ensureSluiceHome creates ~/.sluice owner-only', { skip: !posix }, () => {
  withTempHome((home) => {
    const dir = ensureSluiceHome();
    assert.equal(dir, join(home, '.sluice'));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

test('ensureSluiceHome tightens an existing world-readable ~/.sluice', { skip: !posix }, () => {
  // The state every existing install is in: created by an older runner at 0755.
  withTempHome((home) => {
    const dir = join(home, '.sluice');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensureSluiceHome();
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

test('writePrivateFile writes 0600 and tightens a file that already exists', { skip: !posix }, () => {
  withTempHome((home) => {
    const file = join(home, 'state.json');
    writeFileSync(file, '{}', { mode: 0o644 });
    chmodSync(file, 0o644);
    writePrivateFile(file, '{"pid":1}');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, 'utf8'), '{"pid":1}');
  });
});
