// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @sluice/interceptor — the generic capture engines + replay + auth seed.
 *
 *   MitmEngine            — Engine A: in-process mockttp HTTPS proxy.
 *   CdpEngine             — Engine C: passive browser capture via Chrome DevTools.
 *   runReplay             — execute a ReplayRequest → normalized, redacted Capture.
 *   replayWithRefresh     — runReplay, then re-extract + retry ONCE on an auth failure.
 *   reconstructCredentials — scan a Capture for credential hints (Phase-B seed).
 *
 * Per-service credential extraction lives in the app packages (see
 * `@sluice/app-slack`), not here — the interceptor is app-agnostic.
 */
export { MitmEngine, NEVER_DECRYPT_HOSTS, LAN_LISTEN_HOST } from './mitm-engine.js';
export { CdpEngine } from './cdp-engine.js';
export { launchDebugChrome, defaultChromeProfileDir } from './launch-chrome.js';
export type { LaunchedChrome } from './launch-chrome.js';
export { ensureSluiceCA, sluiceCaCertPath } from './ca.js';
export { runReplay } from './replay.js';
export { runFlowReplay } from './flow-replay.js';
export type { FlowReplayIO, FlowReplayResult } from './flow-replay.js';
export { replayBudget, ReplayDeniedError } from './replay-policy.js';
export { replayWithRefresh } from './replay-refresh.js';
export { reconstructCredentials } from './auth-reconstruct.js';
export { mapAuthFlow } from './auth-flow.js';
export { superviseEngine } from './supervisor.js';
export type { Supervisor } from './supervisor.js';
