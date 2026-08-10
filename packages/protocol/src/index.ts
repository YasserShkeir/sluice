// SPDX-License-Identifier: Apache-2.0
/**
 * @sluice/protocol — runtime validation for the runner↔webapp WebSocket.
 *
 * The types for these messages live in `@sluice/core`, where every other
 * contract lives. This is a separate package for one reason: `@sluice/core`
 * depends on `better-sqlite3` and `node:fs`, and the webapp is a browser bundle
 * that imports core with `import type` only, so nothing of it survives to
 * runtime. A zod schema is a VALUE — putting one in core would pull the store,
 * and a native module, into the page.
 *
 * ## What is validated, and what is not
 *
 * CLIENT messages, in full. Those arrive over a socket from a page the runner
 * does not control the contents of, and they are the direction that carries
 * arguments — `replay.run` names an action and hands over a parameter map. That
 * is the only untrusted input the protocol has.
 *
 * SERVER frames are deliberately NOT validated here. They are constructed by the
 * runner, in one process, from typed values, and a schema for them would check
 * that this codebase agrees with itself — at the cost of running a validator
 * over every capture body on the way to the page, which is the hot path.
 * `hello`/`hello.ok` carry the version handshake, and a genuine skew is caught
 * there rather than by re-checking every frame afterwards.
 *
 * ## The check that keeps this honest
 *
 * Inferring the message types FROM the schemas would read the same and enforce
 * nothing: the schema would be definitionally correct, so it could never be
 * found wrong, and a field added to `SubscribeMsg` in core would simply never
 * arrive. So the types stay in core and {@link EXHAUSTIVE} asserts the two
 * agree in BOTH directions at compile time — a field on either side that the
 * other lacks fails the build.
 */
import { z } from 'zod';
import type { ClientMsg } from '@sluice/core';

/**
 * How long a string the protocol will accept in an identifier position.
 *
 * A socket frame is parsed before anything looks at its size, so an unbounded
 * string field is an unbounded allocation reachable from the page. Generous
 * enough that no real id, action or container name comes close.
 */
const MAX_ID = 1024;

/**
 * How many parameters one replay may carry, and how long a value may be.
 *
 * `replay.run` params reach an adapter's request builder and end up in a URL or
 * a request body. The limits are what keeps "the page asked for a replay" from
 * being a way to make the runner build an arbitrarily large outbound request.
 */
const MAX_PARAMS = 64;
const MAX_PARAM_VALUE = 8192;

const id = z.string().min(1).max(MAX_ID);

/**
 * A filter with nothing in it normalizes to `undefined`, so `filter` being set
 * really does mean "this connection is scoped" — which is what the broadcast
 * loop tests, once per frame per subscriber.
 */
const subscribeFilter = z
  .object({ adapterId: id.optional(), tabId: id.optional() })
  .strict()
  .transform((f) => (f.adapterId === undefined && f.tabId === undefined ? undefined : f));

const helloOk = z.object({
  type: z.literal('hello.ok'),
  // Not `.int()`: the point of this field is to detect a peer that does not
  // agree, and a peer sending `1.5` disagrees. Rejecting it here would drop the
  // frame that says so, and the mismatch would go back to being invisible.
  protocolVersion: z.number(),
});

const subscribe = z.object({
  type: z.literal('subscribe'),
  // Non-negative and finite. A NaN or a negative resumes from nowhere, and the
  // server's ring lookup would answer "not in the ring" — a full re-prime
  // dressed up as a resume.
  sinceSeq: z.number().int().nonnegative().optional(),
  filter: subscribeFilter.optional(),
});

const replayRun = z.object({
  type: z.literal('replay.run'),
  requestId: id,
  actionId: id,
  // Values only, and strings only. The handler passes this map straight to an
  // adapter's `buildReplayRequest`, which interpolates it into a URL or a body;
  // an object or an array there is a shape no adapter is written against.
  params: z.record(z.string().max(MAX_PARAM_VALUE)).refine(
    (p) => Object.keys(p).length <= MAX_PARAMS,
    `at most ${MAX_PARAMS} params`,
  ),
  sessionId: id.optional(),
});

const exportMsg = z.object({
  type: z.literal('export'),
  containerId: id.optional(),
});

const sync = z.object({ type: z.literal('sync') });

const captureControl = z.object({
  type: z.literal('capture.control'),
  action: z.enum(['pause', 'resume']),
});

const engineControl = z.object({
  type: z.literal('engine.control'),
  action: z.enum(['start', 'stop']),
  requestId: id,
});

const proxyControl = z.object({
  type: z.literal('proxy.control'),
  action: z.enum(['on', 'off']),
  requestId: id,
});

// Bounds on the numeric fields: a NaN/negative age or count is not a valid
// retention and would otherwise reach the store as a garbage predicate.
const dataPrune = z.object({
  type: z.literal('data.prune'),
  maxAgeDays: z.number().positive().optional(),
  maxRows: z.number().int().nonnegative().optional(),
  vacuum: z.boolean().optional(),
  requestId: id,
});

const dataDeleteCaptures = z.object({
  type: z.literal('data.deleteCaptures'),
  unattributed: z.boolean().optional(),
  host: id.optional(),
  vacuum: z.boolean().optional(),
  requestId: id,
});

const dataRematerialize = z.object({
  type: z.literal('data.rematerialize'),
  adapterId: id.optional(),
  requestId: id,
});

const dataClearApp = z.object({
  type: z.literal('data.clearApp'),
  adapterId: id,
  includeCaptures: z.boolean(),
  requestId: id,
});

const dataVacuum = z.object({ type: z.literal('data.vacuum'), requestId: id });

const dataWipe = z.object({
  type: z.literal('data.wipe'),
  confirm: z.string(),
  requestId: id,
});

/** Every message a client may send, discriminated on `type`. */
export const clientMsgSchema = z.discriminatedUnion('type', [
  helloOk,
  subscribe,
  replayRun,
  exportMsg,
  sync,
  captureControl,
  engineControl,
  proxyControl,
  dataPrune,
  dataDeleteCaptures,
  dataRematerialize,
  dataClearApp,
  dataVacuum,
  dataWipe,
]);

/**
 * Mutual assignability. `[A] extends [B]` is the tuple form, which stops a union
 * from distributing — without it, `ClientMsg` would be checked one member at a
 * time and a missing member would pass.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * The build-time guard, and the whole reason this file is not `z.infer`red.
 *
 * A type-level assertion with no runtime cost: `true` inhabits the type when
 * both sides match and the type is `never` when they do not. Checked by adding
 * a field to `SyncMsg` and watching the build break, rather than assumed.
 *
 * It catches REQUIRED fields, in both directions — one added to a message in
 * core without being added here, and one here with no home in the contract.
 * It does NOT catch an OPTIONAL field added to core, because a schema that
 * omits an optional field still produces a value assignable to the interface,
 * and vice versa. That is a real gap and worth knowing: the round-trip test in
 * index.test.ts is what covers optional fields, by naming each one in a message
 * that must be accepted.
 */
const EXHAUSTIVE: Exact<ClientMsg, z.infer<typeof clientMsgSchema>> = true;
void EXHAUSTIVE;

/**
 * Validate one client frame, or say why not.
 *
 * Returns a result rather than throwing, and rather than the bare `undefined`
 * the old `isClientMsg` gave back. A dropped frame with no reason is the kind of
 * bug that gets diagnosed as "the socket went quiet" — the server logs the
 * reason as a `notice`, so a page sending something malformed finds out from the
 * UI instead of from silence.
 */
export function parseClientMsg(
  raw: unknown,
): { ok: true; msg: ClientMsg } | { ok: false; reason: string } {
  const result = clientMsgSchema.safeParse(raw);
  if (result.success) return { ok: true, msg: result.data };
  const first = result.error.issues[0];
  const path = first?.path.join('.');
  return {
    ok: false,
    reason: first === undefined ? 'not a protocol message' : `${path || 'message'}: ${first.message}`,
  };
}

/**
 * Parse a socket payload end to end: JSON, then schema.
 *
 * One function because the two failures want the same handling and the same
 * message shape — a frame that is not JSON and a frame that is not a protocol
 * message are equally "this peer is not speaking the protocol", and having each
 * caller write the try/catch is how one of them ends up not writing it.
 */
export function parseClientFrame(
  text: string,
): { ok: true; msg: ClientMsg } | { ok: false; reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  return parseClientMsg(raw);
}
