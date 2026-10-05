// SPDX-License-Identifier: Apache-2.0
/**
 * These exist because the bug they replace was not a wrong result — it was a
 * dead process. `fs.cpSync` on a directory whose read comes back EINTR raises a
 * C++ `filesystem_error` that never becomes a JS exception, so the runner
 * aborted mid-startup with no port bound and no banner printed.
 *
 * The contract worth pinning is therefore: a failure here is a catchable JS
 * error, and the caller lives.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyDirSafe, copyFileSafe, isRegularFile, sweepStaleTempDirs } from './safe-copy.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'sluice-safecopy-test-'));
}

test('copyDirSafe copies the regular files of a leveldb-shaped directory', () => {
  const root = scratch();
  try {
    const src = join(root, 'leveldb');
    mkdirSync(src);
    writeFileSync(join(src, 'CURRENT'), 'MANIFEST-000001\n');
    writeFileSync(join(src, '000003.log'), 'entries');
    writeFileSync(join(src, 'LOCK'), '');

    const dst = join(root, 'work');
    assert.equal(copyDirSafe(src, dst), 3);
    assert.equal(readFileSync(join(dst, 'CURRENT'), 'utf8'), 'MANIFEST-000001\n');
    assert.equal(readFileSync(join(dst, '000003.log'), 'utf8'), 'entries');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copyDirSafe creates the destination and skips subdirectories', () => {
  const root = scratch();
  try {
    const src = join(root, 'src');
    mkdirSync(join(src, 'nested'), { recursive: true });
    writeFileSync(join(src, 'flat'), 'a');
    writeFileSync(join(src, 'nested', 'deep'), 'b');

    const dst = join(root, 'a', 'b', 'work'); // does not exist yet
    assert.equal(copyDirSafe(src, dst), 1);
    assert.ok(existsSync(join(dst, 'flat')));
    assert.ok(!existsSync(join(dst, 'nested')), 'the walk is flat by design');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('copyDirSafe does not follow a symlink out of the source directory', () => {
  // The source is a directory another application owns. A link planted there
  // must not redirect the copy — or, worse, be followed into somewhere large.
  const root = scratch();
  try {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret'), 'do not copy me');

    const src = join(root, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'real'), 'ok');
    symlinkSync(join(outside, 'secret'), join(src, 'link'));

    const dst = join(root, 'work');
    assert.equal(copyDirSafe(src, dst), 1);
    assert.ok(existsSync(join(dst, 'real')));
    assert.ok(!existsSync(join(dst, 'link')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing source is a catchable error, not a process abort', () => {
  const root = scratch();
  try {
    assert.throws(
      () => copyDirSafe(join(root, 'does-not-exist'), join(root, 'work')),
      (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
    );
    assert.throws(
      () => copyFileSafe(join(root, 'nope'), join(root, 'out')),
      (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the DT_UNKNOWN fallback does not follow a symlink to a regular file', () => {
  const root = scratch();
  try {
    const target = join(root, 'target');
    writeFileSync(target, 'outside');
    const link = join(root, 'link');
    symlinkSync(target, link);
    assert.equal(isRegularFile(target), true);
    assert.equal(isRegularFile(link), false, 'lstat, not stat: the link itself is not a regular file');
    assert.equal(isRegularFile(join(root, 'missing')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── stale temp-copy sweep ─────────────────────────────────────────────────────
// Everything happens in a private temp root passed as `root`; the real $TMPDIR
// is never listed or touched.

test('sweepStaleTempDirs removes only an old, real, sluice-named copy; fresh ones, links and strangers stay', () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
  const outside = mkdtempSync(join(tmpdir(), 'sweep-target-'));
  try {
    const old = new Date(Date.now() - 60 * 60_000);
    const dir = (name: string, mtime?: Date): string => {
      const path = join(root, name);
      mkdirSync(path);
      writeFileSync(join(path, '000003.log'), 'synthetic leveldb bytes');
      if (mtime) utimesSync(path, mtime, mtime);
      return path;
    };
    const staleLdb = dir('sluice-ldb-Ab12Cd', old);
    const staleCookies = dir('sluice-cookies-Zz9Yy8', old);
    const fresh = dir('sluice-ldb-Fresh1');
    const stranger = dir('other-ldb-Ab12Cd', old);
    const longName = dir('sluice-ldb-Ab12Cd-extra', old);
    // An old link named like ours, pointing at a directory we do not own.
    writeFileSync(join(outside, 'keep.txt'), 'not ours');
    const link = join(root, 'sluice-ldb-Link01');
    symlinkSync(outside, link);
    lutimesSync(link, old, old);

    const removed = sweepStaleTempDirs({ root, maxAgeMs: 10 * 60_000 });

    assert.deepEqual(removed.sort(), [staleCookies, staleLdb].sort());
    assert.equal(existsSync(staleLdb), false);
    assert.equal(existsSync(staleCookies), false);
    for (const kept of [fresh, stranger, longName, link]) {
      assert.ok(existsSync(kept), `${kept} is kept`);
    }
    assert.ok(existsSync(join(outside, 'keep.txt')), 'a link is never followed');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('sweepStaleTempDirs on an unreadable root sweeps nothing and does not throw', () => {
  assert.deepEqual(sweepStaleTempDirs({ root: join(tmpdir(), 'sluice-sweep-does-not-exist') }), []);
});
