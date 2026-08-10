// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNoBypass, buildClaudeArgv, resolveClaudeBin } from './claude-terminal.js';

test('argv always pins the model, effort, and strict MCP', () => {
  const argv = buildClaudeArgv({ model: 'claude-opus-4-8', effort: 'max' });
  assert.deepEqual(argv, ['--model', 'claude-opus-4-8', '--effort', 'max', '--strict-mcp-config']);
});

test('MCP is opt-in — a config file appears only when provided', () => {
  assert.ok(!buildClaudeArgv({ model: 'opus', effort: 'high' }).includes('--mcp-config'));
  const withMcp = buildClaudeArgv({ model: 'opus', effort: 'high', mcpConfig: '/tmp/mcp.json' });
  const i = withMcp.indexOf('--mcp-config');
  assert.ok(i >= 0 && withMcp[i + 1] === '/tmp/mcp.json');
  // Strict is STILL present with a config — only the named servers load.
  assert.ok(withMcp.includes('--strict-mcp-config'));
});

test('skipPermissions adds --dangerously-skip-permissions and lifts the audit', () => {
  const argv = buildClaudeArgv({ model: 'opus', effort: 'max', skipPermissions: true });
  assert.ok(argv.includes('--dangerously-skip-permissions'), 'the bypass flag is present when opted in');
  assert.ok(argv.includes('--strict-mcp-config'), 'strict MCP is still on');
  // Default (no opt-in) never carries the flag — the audit would refuse it.
  assert.ok(!buildClaudeArgv({ model: 'opus', effort: 'max' }).includes('--dangerously-skip-permissions'));
});

test('an invalid effort is refused before anything launches', () => {
  // @ts-expect-error — deliberately passing a value outside the Effort union.
  assert.throws(() => buildClaudeArgv({ model: 'opus', effort: 'ultracode' }), /Invalid --terminal-effort/);
});

test('the argv audit refuses any permission-bypass token', () => {
  assert.throws(() => assertNoBypass(['--dangerously-skip-permissions']), /permission-bypass/);
  assert.throws(() => assertNoBypass(['--allow-dangerously-skip-permissions']), /permission-bypass/);
  assert.throws(() => assertNoBypass(['--permission-mode', 'bypassPermissions']), /permission-bypass/);
  // A clean argv passes.
  assert.doesNotThrow(() => assertNoBypass(['--model', 'opus', '--effort', 'max', '--strict-mcp-config']));
});

test('resolveClaudeBin honours an explicit executable path', () => {
  // The node binary is guaranteed executable and present on any runner.
  assert.equal(resolveClaudeBin(process.execPath), process.execPath);
});

test('resolveClaudeBin throws a helpful error when nothing is found', () => {
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const savedBin = process.env.SLUICE_CLAUDE_BIN;
  process.env.PATH = '/nonexistent-sluice-dir';
  delete process.env.HOME;
  delete process.env.SLUICE_CLAUDE_BIN;
  try {
    assert.throws(() => resolveClaudeBin(), /Could not find the .?claude.? binary/);
  } finally {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    if (savedHome !== undefined) process.env.HOME = savedHome;
    if (savedBin !== undefined) process.env.SLUICE_CLAUDE_BIN = savedBin;
  }
});
