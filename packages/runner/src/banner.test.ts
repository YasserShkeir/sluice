// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import { printSecretLines, type SecretOutput } from './banner.js';

const TOKEN = 'a'.repeat(64);
const PTY = 'b'.repeat(64);
const LINES = [`  Open:   http://127.0.0.1:7788/#k=${TOKEN}&p=${PTY}`, `  Token:  ${TOKEN}`];

function fakeOutput(isTTY: boolean, terminal: boolean): SecretOutput & { stdout: string[]; tty: string[] } {
  const stdout: string[] = [];
  const tty: string[] = [];
  return {
    isTTY,
    stdout,
    tty,
    out: (line) => stdout.push(line),
    toTerminal: (text) => {
      if (!terminal) return false;
      tty.push(text);
      return true;
    },
  };
}

test('on a terminal the banner prints the token as it is', () => {
  const io = fakeOutput(true, true);
  assert.equal(printSecretLines(LINES, [TOKEN, PTY], io), 'plain');
  assert.deepEqual(io.stdout, LINES);
  assert.deepEqual(io.tty, [], 'nothing is written twice');
});

test('redirected stdout never receives a token; the terminal gets the full lines', () => {
  // `sluice start > ~/.sluice/runner.log` is how a background runner is launched,
  // and that log outlives the process.
  const io = fakeOutput(false, true);
  assert.equal(printSecretLines(LINES, [TOKEN, PTY], io), 'terminal');
  const log = io.stdout.join('\n');
  assert.ok(!log.includes(TOKEN), 'the dashboard token must not reach a file');
  assert.ok(!log.includes(PTY), 'nor the pty token');
  assert.match(log, /«redacted»/);
  assert.match(log, /went to your terminal/);
  assert.ok(io.tty.join('').includes(TOKEN), 'the person at the terminal still gets the link');
});

test('with no terminal at all the token is masked and the log says how to get it', () => {
  const io = fakeOutput(false, false);
  assert.equal(printSecretLines(LINES, [TOKEN, PTY], io), 'hidden');
  const log = io.stdout.join('\n');
  assert.ok(!log.includes(TOKEN));
  assert.match(log, /run this command in a terminal/);
});

test('an empty secret (no pty token) does not mangle the lines', () => {
  const io = fakeOutput(false, false);
  printSecretLines([`  Token:  ${TOKEN}`], [TOKEN, ''], io);
  assert.equal(io.stdout[0], '  Token:  «redacted»');
});
