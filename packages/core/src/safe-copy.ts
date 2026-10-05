// SPDX-License-Identifier: Apache-2.0
/**
 * Copy-then-read helpers for live app state (Slack's LevelDB dir, Chromium's
 * Cookies triplet) inside macOS app containers, where another process holds the
 * files and a syscall can return EINTR on a healthy machine. Not `fs.cpSync`: on
 * Node 22 it is native, and a `directory_iterator` EINTR there calls
 * `terminate()` — an abort no try/catch can intercept. These walk in JS, where a
 * failure is a catchable Error, and retry EINTR.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Interrupted-syscall retries. EINTR is transient by definition; a few is plenty. */
const EINTR_RETRIES = 5;

/** Run `fn`, retrying only while it fails with EINTR. Any other error propagates. */
function retryEintr<T>(fn: () => T): T {
  let last: unknown;
  for (let attempt = 0; attempt <= EINTR_RETRIES; attempt++) {
    try {
      return fn();
    } catch (e) {
      if ((e as NodeJS.ErrnoException | undefined)?.code !== 'EINTR') throw e;
      last = e;
    }
  }
  throw last;
}

/** Copy one file, tolerating an interrupted syscall. Throws a normal JS error. */
export function copyFileSafe(src: string, dst: string): void {
  retryEintr(() => copyFileSync(src, dst));
}

/**
 * Copy the regular files directly inside `src` into `dst` (created if needed);
 * returns how many. Flat on purpose (every caller points at a LevelDB dir), and
 * non-regular files are skipped so a symlink in a directory we do not own cannot
 * redirect the copy.
 */
export function copyDirSafe(src: string, dst: string): number {
  mkdirSync(dst, { recursive: true });
  const entries = retryEintr(() => readdirSync(src, { withFileTypes: true }));
  let copied = 0;
  for (const entry of entries) {
    const from = join(src, entry.name);
    if (entry.isSymbolicLink()) continue;
    // `withFileTypes` can report UNKNOWN on some filesystems; lstat (never stat —
    // it follows links) settles it.
    if (!entry.isFile() && !isRegularFile(from)) continue;
    copyFileSafe(from, join(dst, entry.name));
    copied++;
  }
  return copied;
}

/** @internal test seam — true only for a regular file, never for a link to one. */
export function isRegularFile(path: string): boolean {
  try {
    return retryEintr(() => lstatSync(path)).isFile();
  } catch {
    return false;
  }
}

/** A temp copy Slack's reader (`sluice-ldb-`) or withCopiedSqliteDb (`sluice-cookies-`) made. */
const STALE_COPY = /^sluice-(ldb|cookies)-[A-Za-z0-9]{6}$/;

/** Old enough that no read still in progress can own it; a read takes seconds. */
const STALE_COPY_AGE_MS = 10 * 60_000;

/**
 * Remove temp store copies (`sluice-ldb-*`, `sluice-cookies-*`) a killed run left
 * behind: `finally` does not run on SIGKILL or a native abort, and a Slack LevelDB
 * copy holds every workspace token in plaintext. Only own-uid real directories
 * (never symlinks) named exactly as our `mkdtemp` names them and idle 10 minutes
 * by default, so a concurrent reader keeps its copy. Returns the paths removed;
 * never throws.
 */
export function sweepStaleTempDirs(opts: { root?: string; maxAgeMs?: number; now?: number } = {}): string[] {
  const root = opts.root ?? tmpdir();
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? STALE_COPY_AGE_MS);
  const uid = process.getuid?.();
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!STALE_COPY.test(name)) continue;
    const path = join(root, name);
    try {
      const st = lstatSync(path);
      const ours = st.isDirectory() && (uid === undefined || st.uid === uid);
      if (!ours || st.mtimeMs >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      /* gone already, or not ours to remove */
    }
  }
  return removed;
}
