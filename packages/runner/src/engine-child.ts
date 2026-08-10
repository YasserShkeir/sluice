// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The MITM capture engine, run as an ISOLATED child process (§S1).
 *
 * The problem the supervisor could not solve from inside the runner: mockttp
 * terminates TLS and runs attacker-shaped bytes through its stack, and an
 * `uncaughtException` on that path takes down the whole process it runs in —
 * dashboard, store, and all. Here that process is this child. A crash exits only
 * this child; the parent's supervisor sees the port go dead and respawns it, and
 * the store and dashboard never blink.
 *
 * Protocol — kept off mockttp's own stdout so the parent never has to parse it:
 *   - fd 3  → parent: NDJSON frames, one per line: {t:'started'|'status'|'capture'|'error'}
 *   - stdin ← parent: NDJSON control, one per line: {t:'stop'}
 *   - stdout/stderr: inherited, so mockttp's logging stays visible and out of the
 *     data channel.
 *
 * It needs no adapter objects: MitmEngine uses adapters only to build its TLS
 * intercept list, so the parent flattens their hostnames into SLUICE_CHILD_HOSTS
 * and this runs with `adapters: []`. Attribution and parsing happen in the parent
 * on ingest, exactly as they did for the in-process engine.
 */
import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';
import { MitmEngine } from '@sluice/interceptor';

// fd 3 is the clean data channel the parent opened; writing there never collides
// with anything mockttp prints to stdout. Written SYNCHRONOUSLY so a frame is on
// the wire before a following process.exit() — the crash-report frame in the
// uncaughtException handler would be lost to a stream's unflushed buffer. The
// loop handles a pipe that accepts a large capture in more than one write.
function emit(frame: unknown): void {
  const buf = Buffer.from(`${JSON.stringify(frame)}\n`);
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(3, buf, off, buf.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      throw e;
    }
  }
}

const port = Number(process.env.SLUICE_CHILD_PORT ?? '0');
const hosts = (process.env.SLUICE_CHILD_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const allHosts = process.env.SLUICE_CHILD_ALL_HOSTS === '1';
const captureWebSockets = process.env.SLUICE_CHILD_WS !== '0';

const engine = new MitmEngine({
  port,
  adapters: [],
  interceptHosts: hosts,
  interceptAllHosts: allHosts,
  captureWebSockets,
  onCapture: (capture) => emit({ t: 'capture', capture }),
  onStatus: (status) => emit({ t: 'status', status }),
  onError: (e) => emit({ t: 'error', message: e instanceof Error ? e.message : String(e) }),
});

// The reason this file exists: a crash here is contained. Report it, then exit so
// the parent's supervisor can respawn a fresh child.
process.on('uncaughtException', (e) => {
  emit({ t: 'error', message: `uncaughtException: ${e instanceof Error ? e.message : String(e)}` });
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  emit({ t: 'error', message: `unhandledRejection: ${e instanceof Error ? e.message : String(e)}` });
  process.exit(1);
});

async function shutdown(code: number): Promise<void> {
  try {
    await engine.stop();
  } catch {
    /* already down */
  }
  process.exit(code);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof msg === 'object' && msg !== null && (msg as { t?: string }).t === 'stop') {
    void shutdown(0);
  }
});
// If the parent dies, stdin closes — take the engine down rather than orphan it.
process.stdin.on('end', () => void shutdown(0));

engine.start().then(
  ({ port: boundPort, caPath }) => emit({ t: 'started', port: boundPort, caPath }),
  (e) => {
    emit({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  },
);
