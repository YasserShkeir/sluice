// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How a replay is chosen, sent, and whose session it acts as — shared by the
 * dashboard (server.ts) and the CLI (cli.ts), so the two cannot disagree about
 * which action an id names, what request it becomes, or whose account it goes
 * out as.
 *
 * The session rule (`pickSession`): an explicit session that does not match is
 * an error, and several signed-in sessions with nothing saying which one is an
 * error too. Never a silent `sessions[0]` — on a machine signed in to two
 * workspaces that sends the request authenticated as the WRONG ACCOUNT.
 */
import type { Adapter, Capture, FlowTemplate, ReplayAction, Session, SqliteStore } from '@sluice/core';
import { runReplay } from '@sluice/interceptor';
import type { FlowReplayIO } from '@sluice/interceptor';
import { faithfulReplayRequest, flowStepBuilder } from '@sluice/cartographer';

export { anonymousSession } from '@sluice/core';

/** An action's declared defaults, as params. A null/undefined default is not a value; `''` and `'0'` are. */
export function defaultParams(action: ReplayAction): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of action.params) if (p.default != null) out[p.name] = p.default;
  return out;
}

/** The no-argument "structure" actions (conversations.list, users.list, …) that `sync` replays. */
export function structureActions(adapter: Adapter): ReplayAction[] {
  return adapter.listReplayActions().filter((a) => !a.params.some((p) => p.required));
}

/** The first adapter declaring `actionId`, with that action. */
export function findReplayAction<A extends Adapter>(
  adapters: readonly A[],
  actionId: string,
): { adapter: A; action: ReplayAction } | undefined {
  for (const adapter of adapters) {
    const action = adapter.listReplayActions().find((a) => a.id === actionId);
    if (action) return { adapter, action };
  }
  return undefined;
}

/**
 * Build one action's request as `session` and send it. The ONLY send path is
 * runReplay, which enforces the method / operation / host / budget rails below
 * this layer, so no caller can route around them. Async, so a builder that
 * throws becomes a rejection with nothing sent.
 */
export async function runReplayAction(
  store: SqliteStore,
  adapter: Adapter,
  action: ReplayAction,
  params: Record<string, string>,
  session: Session,
): Promise<Capture> {
  const req = faithfulReplayRequest(store, adapter.buildReplayRequest(action, params, session));
  return runReplay(req, { allowedHosts: adapter.hosts }); // normalized, secret-redacted
}

/**
 * The flow-replay IO for one of `app`'s templates: flowStepBuilder (the app's
 * host and read-action rails) → runReplay (the same rails again, at send time)
 * → `record` for every step capture. No `refresh`: see the dashboard's
 * `onFlowRun` for why neither caller re-extracts mid-flow.
 */
export function flowReplayIo(
  tmpl: FlowTemplate,
  app: Pick<Adapter, 'hosts' | 'listReplayActions'>,
  record: (c: Capture) => void,
): FlowReplayIO {
  return {
    build: flowStepBuilder(tmpl, app),
    run: (req) => runReplay(req, { allowedHosts: app.hosts }),
    record: (c) => record(c), // not bare `record`: the engine passes the step as a 2nd argument
  };
}

type SessionChoice = { ok: true; session: Session } | { ok: false; error: string };

/**
 * Pick the one session a request may go out as, or say why there is none.
 *
 * - `sessionId`: exactly that session, or an error — never a substitute.
 * - `workspaceId` (read off the request; see `workspaceOfParams` in
 *   @sluice/core): the session for that workspace, when one is signed in.
 * - otherwise the sole session, or an error naming the choices. A workspace no
 *   signed-in session owns (a synthetic or unreconciled id) says nothing about
 *   which account to use, so it falls through to the same rule rather than
 *   stranding a single-workspace user's requests.
 */
export function pickSession(
  sessions: readonly Session[],
  want: { sessionId?: string; workspaceId?: string },
  appLabel: string,
): SessionChoice {
  if (want.sessionId !== undefined) {
    const s = sessions.find((x) => x.id === want.sessionId);
    return s
      ? { ok: true, session: s }
      : { ok: false, error: `No ${appLabel} session "${want.sessionId}" — it may have signed out; reload.` };
  }
  const owner = want.workspaceId === undefined ? undefined : sessions.find((s) => s.workspaceId === want.workspaceId);
  if (owner) return { ok: true, session: owner };
  const [only] = sessions;
  if (sessions.length === 1 && only) return { ok: true, session: only };
  if (sessions.length === 0) return { ok: false, error: `No signed-in ${appLabel} workspace found.` };
  const have = sessions.map((s) => `${s.label} (${s.workspaceId ?? 'workspace unknown'})`).join(', ');
  return {
    ok: false,
    error: `${sessions.length} ${appLabel} workspaces are signed in and nothing says which one to act as. Have: ${have}.`,
  };
}

/**
 * The session one drained work item goes out as. A page owned by a signed-in
 * workspace (`workspaceId`, looked up in the whole `pool`) goes out as that
 * workspace or not at all — never as whichever session the `--workspace` scope
 * left, which would send A's page with B's token. A page no session owns needs
 * the scope to leave exactly one candidate.
 */
export function sessionForItem(
  pool: readonly Session[],
  scoped: readonly Session[],
  workspaceId: string | undefined,
  appLabel: string,
): SessionChoice {
  const owner = workspaceId === undefined ? undefined : pool.find((s) => s.workspaceId === workspaceId);
  if (!owner) return pickSession(scoped, {}, appLabel);
  return scoped.includes(owner)
    ? { ok: true, session: owner }
    : { ok: false, error: `It belongs to ${owner.label}, outside --workspace.` };
}
