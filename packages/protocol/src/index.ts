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
 */
import { z } from 'zod';
import type { ClientMsg } from '@sluice/core';

/**
 * Frames are parsed before any size check, so an unbounded identifier would be
 * a page-reachable allocation. 1024 is generous for any real id.
 */
const id = z.string().min(1).max(1024);

/**
 * The one parameter map shared by `replay.run`, `flow.run` and the MCP replay
 * tools. Strings only; keys, values and count are bounded because params end up
 * in an outbound URL or body. The empty key is accepted (no min, unlike
 * {@link id}).
 */
export const replayParamsSchema = z
  .record(z.string().max(1024), z.string().max(8192))
  .refine((p) => Object.keys(p).length <= 64, 'at most 64 params');

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
  // Passed straight to an adapter's `buildReplayRequest`.
  params: replayParamsSchema,
  sessionId: id.optional(),
});

const flowRun = z.object({
  type: z.literal('flow.run'),
  requestId: id,
  templateId: id,
  // Same string-only map as replay.run — flow params become URL/path pieces.
  params: replayParamsSchema,
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
  // Bound so a hostile client cannot force huge string compares on wipe path.
  confirm: z.string().max(64),
  requestId: id,
});

/** Every message a client may send, discriminated on `type`. */
export const clientMsgSchema = z.discriminatedUnion('type', [
  helloOk,
  subscribe,
  replayRun,
  flowRun,
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
 * The build-time guard. Types are not `z.infer`red from the schemas, because
 * inferred types are correct by definition and would never catch drift. This
 * type-level assertion has no runtime cost. It catches REQUIRED fields in both
 * directions, but NOT an optional field added to core (a schema omitting it
 * still produces an assignable value); the round-trip test in index.test.ts
 * covers optional fields.
 */
const EXHAUSTIVE: Exact<ClientMsg, z.infer<typeof clientMsgSchema>> = true;
void EXHAUSTIVE;

/** A validated client message, or why the frame was refused. */
export type ClientMsgResult = { ok: true; msg: ClientMsg } | { ok: false; reason: string };

/**
 * Validate one client frame, returning a reason rather than throwing or returning
 * `undefined`, so the server can log a `notice` instead of the socket going silent.
 */
export function parseClientMsg(raw: unknown): ClientMsgResult {
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
 * Parse a socket payload: JSON, then schema. One handling for both failures, so
 * no caller forgets the try/catch.
 */
export function parseClientFrame(text: string): ClientMsgResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  return parseClientMsg(raw);
}
