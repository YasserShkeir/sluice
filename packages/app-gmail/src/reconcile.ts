// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Working out which mailbox a `/u/N/` capture actually belonged to.
 *
 * Gmail addresses accounts by a path slot, and a slot is not an identity: the
 * browser reassigns it whenever the signed-in set changes, so the same `/u/0/`
 * means one mailbox in the morning and another in the afternoon. A single
 * response cannot tell which — `fd` names its mailbox outright, `bv` names
 * nothing at all — so the parser files address-less traffic under a provisional
 * workspace and this module empties it afterwards, when the neighbouring
 * captures are available to answer the question the response could not.
 *
 * The rule is bracketing, not proximity. A capture on slot S sits between the
 * nearest `fd` before it and the nearest `fd` after it, both on S; when those
 * two name the same mailbox, nothing that happened in between could have been a
 * different one, and the capture is resolved. When they disagree, the capture
 * straddles a switch and STAYS unresolved — which is the whole point. A
 * nearest-in-time rule would have answered those too, and answering them is
 * precisely the mistake that merged two mailboxes into one workspace.
 */
import type { ReconcileOutcome, ReconcileStore } from '@sluice/core';
import {
  ADAPTER_ID,
  accountSlotOfWorkspaceId,
  accountWorkspaceId,
  addressOfWorkspaceId,
  gmailAccountAddress,
  gmailAccountSlot,
  gmailCarriesEntities,
  isProvisionalWorkspaceId,
  parseGmailCapture,
} from './gmail-adapter.js';

/** One moment at which a capture proved which mailbox a slot was serving. */
export interface SlotBinding {
  slot: string;
  ts: number;
  address: string;
}

/**
 * Every (slot, moment) → mailbox the store can prove, oldest first.
 *
 * Only `fd` responses can prove one, because only they carry the address. The
 * ledger is therefore sparse — 41 bindings against 391 captures in the recording
 * this was built from — and that sparseness is exactly why the bracketing rule
 * has to tolerate gaps rather than assume a binding is always at hand.
 */
export function slotLedger(store: ReconcileStore, limit = 200_000): SlotBinding[] {
  const out: SlotBinding[] = [];
  for (const capture of store.listCaptures({ adapterId: ADAPTER_ID, limit })) {
    const slot = gmailAccountSlot(capture);
    if (slot === undefined) continue;
    const address = gmailAccountAddress(capture);
    if (address === undefined) continue;
    out.push({ slot, ts: capture.ts, address });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Why a capture could not be attributed to a mailbox. */
export type UnresolvedReason =
  /** No `fd` capture on this slot exists anywhere in the store. */
  | 'no-binding'
  /** The captures either side of it name different mailboxes. */
  | 'straddles-a-switch';

export interface ReconcileReport {
  /** Provisional workspaces that were emptied and removed. */
  removed: string[];
  /** Mailboxes that captures were moved onto, with how many moved. */
  resolved: Array<{ workspaceId: string; captures: number }>;
  /** Captures left where they were, and why. */
  unresolved: Array<{ captureId: string; slot: string; reason: UnresolvedReason }>;
  /**
   * Placeholders kept because they hold mail whose source capture is gone, so
   * nothing can re-read it and nothing can say which mailbox it was.
   */
  stranded: Array<{ workspaceId: string; items: number }>;
}

/**
 * Move every resolvable capture onto the mailbox it belongs to, and clear away
 * the provisional workspaces that end up empty.
 *
 * Re-parses rather than re-points. Container ids embed the workspace id, so
 * "move these rows" means rewriting primary keys and every reference to them,
 * whereas parsing the same capture again with the answer supplied produces the
 * correct rows out of the code path that already runs on every capture. The
 * placeholder is then deleted, and the captures — the evidence — are untouched,
 * so a reconciliation that gets it wrong is undone by running it again.
 *
 * Idempotent. A second run finds no provisional workspaces and does nothing;
 * a run on a store where the answer has not changed rewrites identical rows.
 */
export function reconcileGmailAccounts(store: ReconcileStore, now = Date.now()): ReconcileReport {
  const report: ReconcileReport = { removed: [], resolved: [], unresolved: [], stranded: [] };

  const provisional = store
    .listWorkspaces()
    .filter((w) => w.adapterId === ADAPTER_ID && isProvisionalWorkspaceId(w.id));
  if (provisional.length === 0) return report;

  const slots = new Set(
    provisional.map((w) => accountSlotOfWorkspaceId(w.id)).filter((s): s is string => s !== undefined),
  );
  const ledger = slotLedger(store);
  const moved = new Map<string, number>();

  // Oldest first, so the entities a later capture updates were written by the
  // earlier one — the same order live capture produces them in.
  const captures = store
    .listCaptures({ adapterId: ADAPTER_ID, limit: 200_000 })
    .sort((a, b) => a.ts - b.ts);

  /** Captures whose entities have been re-emitted under a named mailbox. */
  const rehomed = new Set<string>();

  for (const capture of captures) {
    const slot = gmailAccountSlot(capture);
    if (slot === undefined || !slots.has(slot)) continue;
    // Before anything else: most of a Gmail session is shell, heartbeats and
    // telemetry, and none of it yields an entity. Bracketing those would report
    // dozens of "could not attribute" findings about captures that were never
    // going to file mail anywhere.
    if (!gmailCarriesEntities(capture)) continue;

    // A capture that names its own mailbox needs no bracketing — but it DOES
    // need re-parsing, and that is not obvious. A store written before identity
    // moved to the address has its message fetches filed under the slot too, so
    // skipping them here would leave most of the mail exactly where the bug put
    // it and delete the workspace holding it. Re-parsing with no override lets
    // the capture answer for itself, which is the strongest evidence available.
    const declared = gmailAccountAddress(capture);
    let workspaceId: string;
    if (declared !== undefined) {
      workspaceId = accountWorkspaceId(declared);
    } else {
      const verdict = bracket(ledger, slot, capture.ts);
      if (typeof verdict !== 'string') {
        report.unresolved.push({ captureId: capture.id, slot, reason: verdict.reason });
        continue;
      }
      workspaceId = accountWorkspaceId(verdict);
    }

    const parsed = parseGmailCapture(capture, { workspaceId });
    if (parsed.workspaces === undefined) continue; // not a capture this adapter reads
    store.applyParseResult(parsed, capture.ts || now);
    rehomed.add(capture.id);
    moved.set(workspaceId, (moved.get(workspaceId) ?? 0) + 1);
  }

  report.resolved = [...moved].map(([workspaceId, captures]) => ({ workspaceId, captures }));

  // The placeholder's OWN rows are still there, and they are not the same rows
  // the re-parse just wrote: a thread list's items live in a label container, a
  // label container id embeds the workspace id, so `gmail:u0/^i` and
  // `gmail:someone@example.com/^i` are two different primary keys and the upsert
  // wrote the second without touching the first. Left alone, every re-homed
  // thread would be in the store twice — once under a mailbox and once under a
  // placeholder — and every count would be double.
  //
  // So the placeholder is cleared and then REBUILT from whatever could not be
  // attributed. Clearing first is what makes that safe to say: the rows that
  // come back are exactly the ones the unresolved captures produce, rather than
  // whatever happened to be left over.
  const unresolvedBySlot = new Map<string, string[]>();
  for (const u of report.unresolved) {
    unresolvedBySlot.set(u.slot, [...(unresolvedBySlot.get(u.slot) ?? []), u.captureId]);
  }
  const byId = new Map(captures.map((c) => [c.id, c]));

  for (const w of provisional) {
    // A slot still holding mail whose CAPTURE is gone — pruned, or written by a
    // Sluice too old to record which capture it came from — keeps everything it
    // has. Re-parsing cannot re-home what it cannot re-read, so clearing here
    // would delete the only copy. Duplicated-but-present beats gone.
    const stranded = store
      .queryItems({ adapterId: ADAPTER_ID, workspaceId: w.id, limit: STRANDED_SCAN })
      .filter((item) => !(item.sourceCaptureIds ?? []).some((id) => rehomed.has(id)));
    if (stranded.length > 0) {
      report.stranded.push({ workspaceId: w.id, items: stranded.length });
      continue;
    }

    store.deleteWorkspace(w.id);
    const parked = unresolvedBySlot.get(accountSlotOfWorkspaceId(w.id) ?? '') ?? [];
    if (parked.length === 0) {
      report.removed.push(w.id);
      continue;
    }
    // Back under the placeholder, and under nothing else: parsed with no
    // override, an address-less capture keys itself to its slot exactly as it
    // did on the way in.
    for (const captureId of parked) {
      const capture = byId.get(captureId);
      if (capture === undefined) continue;
      store.applyParseResult(parseGmailCapture(capture), capture.ts || now);
    }
  }
  return report;
}

/**
 * How many parked items are looked at before a placeholder is kept regardless.
 *
 * A ceiling, not a page: the question is "is anything stranded here?", one hit
 * settles it, and a store with more than this parked under one slot is not one
 * to delete a workspace from on a scan's say-so.
 */
const STRANDED_SCAN = 50_000;

/**
 * The mailbox a capture on `slot` at `ts` must have belonged to, or why not.
 *
 * Both neighbours agreeing is proof: a mailbox cannot have changed and changed
 * back without an `fd` in between recording it, because a switch reloads the
 * app and the reload is what issues the `fd`. One neighbour is taken as the
 * answer too — a capture before the first binding or after the last one is at
 * the edge of the recording, not at a switch, and the alternative is discarding
 * every capture from a session that ended before Gmail fetched a message.
 */
function bracket(
  ledger: SlotBinding[],
  slot: string,
  ts: number,
): string | { reason: UnresolvedReason } {
  let before: SlotBinding | undefined;
  let after: SlotBinding | undefined;
  for (const binding of ledger) {
    if (binding.slot !== slot) continue;
    if (binding.ts <= ts) before = binding;
    else if (after === undefined) after = binding;
  }
  if (before === undefined && after === undefined) return { reason: 'no-binding' };
  if (before === undefined) return after!.address;
  if (after === undefined) return before.address;
  return before.address === after.address ? before.address : { reason: 'straddles-a-switch' };
}

/**
 * {@link reconcileGmailAccounts} as the adapter contract wants it: a count and
 * a line of prose.
 *
 * The note names what could NOT be settled as well as what could, because the
 * leftovers are the interesting part. Mail parked under a placeholder is mail
 * that `gmail_list_threads` will not return for any account a caller can name,
 * and a report that only counted successes would leave that looking like an
 * empty mailbox rather than an unattributed one.
 */
export function gmailReconcile(store: ReconcileStore): ReconcileOutcome {
  const report = reconcileGmailAccounts(store);
  const changed = report.resolved.length + report.removed.length;
  if (changed === 0 && report.unresolved.length === 0 && report.stranded.length === 0) {
    return { changed: 0 };
  }

  const parts: string[] = [];
  for (const { workspaceId, captures } of report.resolved) {
    parts.push(`${captures} capture${captures === 1 ? '' : 's'} → ${workspaceId}`);
  }
  const straddling = report.unresolved.filter((u) => u.reason === 'straddles-a-switch').length;
  const unbound = report.unresolved.filter((u) => u.reason === 'no-binding').length;
  for (const { workspaceId, items } of report.stranded) {
    parts.push(`${workspaceId} kept: ${items} item${items === 1 ? '' : 's'} whose capture is gone`);
  }
  if (straddling > 0) parts.push(`${straddling} left unattributed (recorded across an account switch)`);
  if (unbound > 0) parts.push(`${unbound} left unattributed (no message fetch names the mailbox)`);
  return { changed, note: parts.join('; ') };
}

/**
 * A one-line account summary for the CLI and the MCP status tool: which
 * mailboxes are known, and how much mail is still parked in a placeholder.
 */
export function describeAccounts(store: ReconcileStore): string {
  const all = store.listWorkspaces().filter((w) => w.adapterId === ADAPTER_ID);
  const named = all.filter((w) => addressOfWorkspaceId(w.id) !== undefined);
  const parked = all.filter((w) => isProvisionalWorkspaceId(w.id));
  const parts = [`${named.length} mailbox${named.length === 1 ? '' : 'es'}`];
  if (parked.length > 0) {
    parts.push(`${parked.length} unidentified (${parked.map((w) => w.id).join(', ')})`);
  }
  return parts.join(', ');
}
