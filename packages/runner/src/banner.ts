// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Printing the lines that carry a capability secret — the dashboard token, the
 * `/pty` token, the ingest token — without leaving them in a file.
 *
 * The banner is the one way into the dashboard, so it has to show the token.
 * But a background launch sends stdout to a file (`sluice start > runner.log`),
 * and a token written there outlives the process, readable by anything that can
 * read the file. So the full lines go only to a terminal.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { MASK } from '@sluice/core';

/** Where banner output can go. Injected so the masking is testable. */
export interface SecretOutput {
  /** Is stdout an interactive terminal? */
  isTTY: boolean;
  /** Write one line to stdout. */
  out: (line: string) => void;
  /** Write text to the controlling terminal directly; false when there is none. */
  toTerminal: (text: string) => boolean;
}

/** The real process: stdout, plus `/dev/tty` when a terminal controls this process. */
function processOutput(): SecretOutput {
  return {
    isTTY: process.stdout.isTTY === true,
    out: (line) => console.log(line),
    toTerminal: (text) => {
      if (process.platform === 'win32') return false;
      try {
        const fd = openSync('/dev/tty', 'w');
        try {
          writeSync(fd, text);
        } finally {
          closeSync(fd);
        }
        return true;
      } catch {
        return false; // no controlling terminal (a daemon, a CI job)
      }
    },
  };
}

/**
 * Print lines that contain secrets.
 *
 * On a terminal they print as they are. Anywhere else each secret is replaced
 * with {@link MASK} in what stdout gets, the full lines are written straight to
 * the controlling terminal when there is one, and stdout is told which of the
 * two happened — so a log never holds a live token and still says why not.
 */
export function printSecretLines(
  lines: readonly string[],
  secrets: readonly string[],
  io: SecretOutput = processOutput(),
): 'plain' | 'terminal' | 'hidden' {
  if (io.isTTY) {
    for (const line of lines) io.out(line);
    return 'plain';
  }
  const live = secrets.filter((s) => s.length > 0);
  for (const line of lines) io.out(live.reduce((acc, s) => acc.split(s).join(MASK), line));
  if (io.toTerminal(`${lines.join('\n')}\n`)) {
    io.out('  (Tokens are masked here because this output is not a terminal; the full lines went to your terminal.)');
    return 'terminal';
  }
  io.out('  Note:   tokens are masked because this output is not a terminal and none is attached —');
  io.out('          run this command in a terminal to get the dashboard link.');
  return 'hidden';
}
