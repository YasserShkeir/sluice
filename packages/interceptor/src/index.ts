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
export { MitmEngine, tlsInterceptList } from './mitm-engine.js';
export type { MitmEngineOptions } from './mitm-engine.js';
export { CdpEngine } from './cdp-engine.js';
export type { CdpEngineOptions } from './cdp-engine.js';
export { launchDebugChrome, defaultChromePath, defaultChromeProfileDir } from './launch-chrome.js';
export type { LaunchChromeOptions, LaunchedChrome } from './launch-chrome.js';
export { ensureSluiceCA, sluiceCaCertPath } from './ca.js';
export { runReplay } from './replay.js';
export { runFlowReplay, resolveJsonPath, nextPaceWaitMs, FLOW_DELAY_CAP_MS, DEFAULT_FLOW_TIMEOUT_MS } from './flow-replay.js';
export type {
  FlowReplayIO,
  FlowReplayResult,
  FlowStepResult,
  FlowStepStatus,
  FlowBuildContext,
  RunFlowReplayOptions,
} from './flow-replay.js';
export {
  assertReplayAllowed,
  replayBudget,
  ReplayDeniedError,
  withReplaySlot,
} from './replay-policy.js';
export type { ReplayBudgetOptions, ReplayDenialCode } from './replay-policy.js';
export { replayWithRefresh } from './replay-refresh.js';
export type { RefreshableReplay } from './replay-refresh.js';
export { reconstructCredentials } from './auth-reconstruct.js';
export { mapAuthFlow } from './auth-flow.js';
export type { AuthFlow, CredentialIssuer } from './auth-flow.js';
export { superviseEngine, backoffMs } from './supervisor.js';
export type { SupervisedEngine, SuperviseOptions, Supervisor } from './supervisor.js';
