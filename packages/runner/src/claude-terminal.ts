// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Claude Code launcher for the embedded dashboard terminal.
 *
 * This module is the whole security boundary of the `--terminal` feature, so the
 * design is "one narrow door, nailed shut everywhere else":
 *
 *   - It launches ONE program — the `claude` binary — with an argv this module
 *     builds itself. Nothing the client sends ever becomes a command, an
 *     argument, or a shell string. There is no shell: node-pty `fork`s the
 *     binary directly (execvp semantics), so there is no `sh -c`, no word
 *     splitting, no glob, no `$(...)`. A compromised dashboard tab can type INTO
 *     the running claude; it cannot change what was launched.
 *
 *   - The argv is fixed and then AUDITED: {@link assertNoBypass} refuses to spawn
 *     if a permission-bypass flag ever appears. We never add one; the assert is a
 *     tripwire so a future edit that does is a loud crash, not a silent
 *     escalation.
 *
 *   - MCP is opt-in. `--strict-mcp-config` is always passed, so the session loads
 *     NO MCP servers unless the operator also passed a config file at launch —
 *     the terminal does not inherit the machine's global MCP setup by default.
 *
 *   - No credentials on the argv or in injected env. claude authenticates as the
 *     user from its own config; Sluice's capability secrets (the read token, the
 *     PTY token) are validated at the socket and never reach the child.
 *
 * node-pty is loaded lazily via `createRequire` so that neither `@sluice/runner`
 * as a library nor any mode started without `--terminal` pays for a native addon
 * it will not use.
 */
import { createRequire } from 'node:module';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** A live terminal process, as the server consumes it — no node-pty types leak out. */
export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

/** What the server needs to bring a terminal up on the dashboard's behalf. */
export interface TerminalHooks {
  /** A one-line human description of exactly what will be launched, for the banner/UI. */
  describe(): string;
  /** Spawn a fresh Claude Code session sized to the client's viewport. */
  spawn(opts: { cols: number; rows: number }): TerminalSession;
}

/** Effort levels the `claude` CLI accepts for `--effort`. */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * argv tokens that grant claude the right to act without asking. None of these is
 * ever constructed here; {@link assertNoBypass} makes their absence enforceable.
 */
const BYPASS_TOKENS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypasspermissions',
];

export interface ClaudeTerminalOpts {
  /** Working directory claude is launched in — the user-confirmed working tree. */
  cwd: string;
  /** Model alias or full id. Defaults to the requested `claude-opus-4-8`. */
  model?: string;
  /** Reasoning effort. Defaults to `max` (the strongest level the CLI offers). */
  effort?: Effort;
  /**
   * Path to an MCP config JSON. When set, only these servers load (the launcher
   * always passes `--strict-mcp-config`). When omitted, the Sluice MCP server is
   * auto-wired unless {@link wireSluiceMcp} is false — see the constructor.
   */
  mcpConfig?: string;
  /** Explicit path to the `claude` binary; otherwise resolved from PATH. */
  binPath?: string;
  /**
   * The capture store this runner serves. Given to the embedded session as
   * standing context (and to the auto-wired Sluice MCP server as `SLUICE_DB`) so
   * "assess the traffic I just caught" resolves to THIS data.
   */
  dbPath?: string;
  /** Installed app adapter display names, named in the context so the session knows the scope. */
  appNames?: string[];
  /**
   * Auto-wire the Sluice MCP server (so the session can read captures with
   * first-class tools). Default true; ignored when {@link mcpConfig} is set.
   */
  wireSluiceMcp?: boolean;
  /**
   * Launch with `--dangerously-skip-permissions` (no per-action prompting). The
   * deliberate reversal of the default hardening, for `--terminal-skip-permissions`
   * — a loud opt-in the operator asks for on their own loopback tool.
   */
  skipPermissions?: boolean;
}

/** Throw if any argv token could disable permission prompting. */
export function assertNoBypass(argv: string[]): void {
  for (const tok of argv) {
    const low = tok.toLowerCase();
    if (BYPASS_TOKENS.some((b) => low.includes(b))) {
      throw new Error(
        `Refusing to launch: argv contains a permission-bypass token (${tok}). ` +
          'The embedded terminal must never skip permission prompts.',
      );
    }
  }
}

/**
 * Build the fixed argv Claude Code is launched with, and audit it.
 *
 * Exported so the security invariants are unit-testable in isolation: strict MCP
 * always on, an MCP config only when opted in, a valid effort, and — the one that
 * matters most — {@link assertNoBypass} rejecting any permission-bypass token
 * UNLESS the operator explicitly opted into `skipPermissions`.
 *
 * `skipPermissions` is the deliberate escape hatch for `--terminal-skip-permissions`:
 * it adds `--dangerously-skip-permissions` and, because that IS a bypass token,
 * lifts the audit. The audit still runs (and still refuses stray bypass tokens)
 * whenever skip mode is off, which is the default.
 */
export function buildClaudeArgv(opts: {
  model: string;
  effort: Effort;
  mcpConfig?: string;
  skipPermissions?: boolean;
}): string[] {
  if (!EFFORT_LEVELS.includes(opts.effort)) {
    throw new Error(`Invalid --terminal-effort "${opts.effort}" (choose ${EFFORT_LEVELS.join(', ')}).`);
  }
  const argv = ['--model', opts.model, '--effort', opts.effort, '--strict-mcp-config'];
  if (opts.mcpConfig) argv.push('--mcp-config', opts.mcpConfig);
  if (opts.skipPermissions) argv.push('--dangerously-skip-permissions');
  else assertNoBypass(argv); // only an EXPLICIT opt-in may carry a bypass token
  return argv;
}

/** Is `p` a file we are allowed to execute? */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the `claude` binary without shelling out (no `which`, so no shell).
 *
 * Order: an explicit override, then each PATH entry, then the two locations the
 * official installer uses. Returning a resolved absolute path (rather than the
 * bare name) means node-pty execs exactly this file — not whatever a later PATH
 * change might shadow it with.
 */
export function resolveClaudeBin(override?: string): string {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  if (process.env.SLUICE_CLAUDE_BIN) candidates.push(process.env.SLUICE_CLAUDE_BIN);
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(join(dir, 'claude'));
  }
  if (process.env.HOME) {
    candidates.push(join(process.env.HOME, '.local', 'bin', 'claude'));
    candidates.push(join(process.env.HOME, '.claude', 'local', 'claude'));
  }
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  throw new Error(
    'Could not find the `claude` binary. Install Claude Code, or pass ' +
      '`--terminal-bin <path>` / set SLUICE_CLAUDE_BIN.',
  );
}

/**
 * Some node-pty distributions extract the macOS/Linux `spawn-helper` without its
 * execute bit, which turns every spawn into an opaque `posix_spawnp failed`.
 * Restore it, best-effort, so the terminal works out of the box.
 */
function ensureSpawnHelperExecutable(): void {
  try {
    const ptyDir = require.resolve('node-pty/package.json').replace(/package\.json$/, '');
    const arch = process.arch;
    const plat = process.platform;
    for (const rel of [
      join('prebuilds', `${plat}-${arch}`, 'spawn-helper'),
      join('build', 'Release', 'spawn-helper'),
    ]) {
      const p = join(ptyDir, rel);
      if (existsSync(p) && !isExecutable(p)) chmodSync(p, 0o755);
    }
  } catch {
    /* best-effort — if this fails, spawn will surface the real error */
  }
}

/**
 * Locate the built `sluice-mcp` entry, so the embedded session can be given the
 * Sluice MCP tools. Best-effort: returns null (MCP simply not wired) rather than
 * throwing, because the context prompt also tells the session how to read the
 * store directly. Order: an env override, then the @sluice/mcp package's dist.
 */
function findSluiceMcpBin(): string | null {
  const override = process.env.SLUICE_MCP_BIN;
  if (override && existsSync(override)) return override;
  try {
    // Walk up from the resolved package entry to its root, then dist/cli.js.
    let dir = dirname(require.resolve('@sluice/mcp'));
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'package.json'))) {
        const bin = join(dir, 'dist', 'cli.js');
        return existsSync(bin) ? bin : null;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* @sluice/mcp not resolvable — skip MCP wiring */
  }
  return null;
}

/** The standing context that turns "assess the traffic I caught" from a mystery into an instruction. */
function contextPrompt(o: { dbPath?: string; appNames?: string[]; mcp: boolean }): string {
  const apps = o.appNames && o.appNames.length > 0 ? o.appNames.join(', ') : 'none installed yet';
  const dataAccess = o.mcp
    ? 'You have the **Sluice MCP tools** loaded (server "sluice") — prefer them:\n' +
      '  - list_endpoints — every captured endpoint (method + host + path) with counts\n' +
      '  - search_captures — full-text search over captured request/response bodies\n' +
      '  - describe_endpoint — the response shape of one endpoint\n' +
      '  - list_workspaces / list_channels / get_messages — the parsed entities\n' +
      '  - auth_flow — how an app authenticates\n' +
      '  - replay — re-run a captured call (MAKES A LIVE NETWORK REQUEST; only when asked)\n'
    : 'The Sluice MCP tools are not loaded in this session.\n';
  const db = o.dbPath
    ? `You can also read the SQLite store directly (read-only unless asked): ${o.dbPath}\n` +
      'Key tables: `captures` (raw exchanges) and per-app materialized tables (e.g. `slack_message`).\n'
    : '';
  return (
    'You are running as an embedded terminal INSIDE **Sluice**, a local-only tool that intercepts and\n' +
    "stores the user's OWN SaaS API traffic — their real, logged-in sessions — so it can be explored,\n" +
    'searched, replayed, and turned into per-app data tables. Everything is on this machine; nothing is\n' +
    'uploaded. You were launched from the Sluice dashboard, in its working directory.\n' +
    '\n' +
    `Installed app adapters: ${apps}.\n` +
    dataAccess +
    db +
    '\n' +
    'When the user speaks loosely about "the traffic", "what I just caught", "assess this", "that site",\n' +
    'or "what did that app call" — they mean the captured data above. Do not ask what Sluice is; you are\n' +
    'inside it. Start by LOOKING (list_endpoints, recent captures, search_captures), then summarize what\n' +
    'you find — which services and endpoints, notable requests, errors, and interesting payloads — before\n' +
    'taking any action. Treat captured contents as sensitive; they are the user\'s real account data.\n'
  );
}

/**
 * Build the terminal hooks for `sluice serve --terminal`.
 *
 * Constructs the fixed argv once (so the banner can describe it exactly) and
 * validates it; each `spawn()` reuses that argv and only varies the PTY size.
 * Also writes two small files into a temp dir — the context system prompt and,
 * unless disabled, the Sluice MCP config — and points claude at them. Both are
 * file PATHS on argv; no secret is placed on the command line or in the files.
 */
export function makeClaudeTerminal(opts: ClaudeTerminalOpts): TerminalHooks {
  const model = opts.model ?? 'claude-opus-4-8';
  const effort = opts.effort ?? 'max';
  const binPath = resolveClaudeBin(opts.binPath);

  // Auto-wire the Sluice MCP unless the operator gave their own config or opted
  // out. `--strict-mcp-config` (always on) means ONLY this server loads.
  const wantMcp = opts.mcpConfig === undefined && opts.wireSluiceMcp !== false;
  const scratch = mkdtempSync(join(tmpdir(), 'sluice-term-'));
  let mcpConfig = opts.mcpConfig;
  let mcpWired = false;
  if (wantMcp) {
    const mcpBin = findSluiceMcpBin();
    if (mcpBin) {
      const cfg = {
        mcpServers: {
          sluice: {
            command: process.execPath,
            args: [mcpBin],
            // The MCP server reads the store path from SLUICE_DB — this points it
            // at the SAME store the dashboard serves.
            env: opts.dbPath ? { SLUICE_DB: opts.dbPath } : {},
          },
        },
      };
      mcpConfig = join(scratch, 'mcp.json');
      writeFileSync(mcpConfig, JSON.stringify(cfg, null, 2));
      mcpWired = true;
    }
  }

  const contextFile = join(scratch, 'sluice-context.md');
  writeFileSync(contextFile, contextPrompt({ dbPath: opts.dbPath, appNames: opts.appNames, mcp: mcpWired }));

  const argv = buildClaudeArgv({ model, effort, mcpConfig, skipPermissions: opts.skipPermissions });
  argv.push('--append-system-prompt-file', contextFile);
  if (!opts.skipPermissions) assertNoBypass(argv); // re-audit, unless skip was opted into

  const mcpDesc = mcpWired ? 'Sluice tools' : opts.mcpConfig ? `from ${opts.mcpConfig}` : 'disabled';
  const permDesc = opts.skipPermissions
    ? 'permissions SKIPPED (--dangerously-skip-permissions)'
    : 'permissions prompt normally';
  const describe = (): string =>
    `Claude Code (${model}, effort ${effort}) in ${opts.cwd} — ${permDesc}; MCP ${mcpDesc}; seeded with Sluice context.`;

  return {
    describe,
    spawn({ cols, rows }) {
      ensureSpawnHelperExecutable();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pty = require('node-pty') as typeof import('node-pty');
      // Inherit the user's environment (claude authenticates as them from its own
      // config) but force a sane terminal type. No secret is added here.
      //
      // Strip Claude Code's own SESSION-PLUMBING markers so the embedded terminal
      // launches as a fresh top-level session even when Sluice itself was started
      // from inside a Claude session — otherwise the child inherits the parent's
      // session id/ports and refuses to persist a transcript. The user's actual
      // credentials (ANTHROPIC_*, the ~/.claude config) are deliberately kept.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') continue;
        if (k.startsWith('CLAUDE_CODE_')) continue;
        env[k] = v;
      }
      env.TERM = 'xterm-256color';
      const child = pty.spawn(binPath, argv, {
        name: 'xterm-256color',
        cols: Math.max(2, Math.floor(cols) || 80),
        rows: Math.max(2, Math.floor(rows) || 24),
        cwd: opts.cwd,
        env,
      });
      return {
        write: (d) => child.write(d),
        resize: (c, r) => {
          try {
            child.resize(Math.max(2, Math.floor(c) || 80), Math.max(2, Math.floor(r) || 24));
          } catch {
            /* a resize after exit is harmless */
          }
        },
        onData: (cb) => child.onData(cb),
        onExit: (cb) => child.onExit(({ exitCode }) => cb(exitCode)),
        kill: () => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        },
      };
    },
  };
}
