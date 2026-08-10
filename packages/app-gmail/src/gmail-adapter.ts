// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Gmail Adapter.
 *
 * Gmail's web client does not talk to `gmail.googleapis.com` at all. It talks to
 * `mail.google.com` with POSITIONAL ARRAYS — no field names anywhere — over four
 * endpoints:
 *
 *   POST /sync/u/{n}/i/bv    batch view: the label list plus one page of threads
 *   POST /sync/u/{n}/i/fd    fetch data: thread/message detail
 *   POST /sync/u/{n}/i/s     incremental sync, and a monotonic history id
 *   POST /mail/u/{n}/?ui=2   the legacy XHR channel
 *
 * Everything else on the host is `/_/scs/mail-static/…` bundles, the app shell,
 * and telemetry.
 *
 * Two envelope rules, both load-bearing. `/sync/…` answers with a BARE JSON
 * array; `/mail/u/{n}/?ui=2` answers with `)]}'\n\n` in front of one, and that
 * prefix must come off before anything tries to parse it. Even then not every
 * body is JSON — one shape on the legacy channel is a length-prefixed chunk
 * stream — so decoding stays total and an unrecognized body yields nothing.
 *
 * `bv` and `fd` are parsed; `s` and the legacy channel are not. The two parsed
 * endpoints describe DIFFERENT things and neither subsumes the other — `bv`
 * answers "which threads are in this label", `fd` answers "what is in this
 * thread" — so they emit at different grains and are kept apart deliberately.
 * See {@link parseBatchView} and {@link parseFetchData}.
 *
 * `matchRequest`, `classify`, `parse` and `nextCursors` are all held to the same
 * rule as every other adapter: they run in the ingest funnel for every capture,
 * so an unrecognized shape yields an empty result and never an exception.
 */
import type {
  Actor,
  Adapter,
  Capture,
  CaptureClass,
  Container,
  CursorSeed,
  Edge,
  Item,
  ParseContext,
  ParseResult,
  ReplayAction,
  ReplayRequest,
  Session,
  Workspace,
} from '@sluice/core';
import { arr, num, safeJson, str } from '@sluice/adapter-sdk';
import { MAX_BODY_CHARS, htmlToText } from './html-to-text.js';

export const ADAPTER_ID = 'gmail';

/** A real Chrome macOS User-Agent. Google serves a different client to anything else. */
export const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// ── Ids ──────────────────────────────────────────────────────────────────────────

/**
 * The workspace id for one signed-in mailbox — `gmail:someone@example.com`.
 *
 * **The address is the identity; `/u/N/` is not.** This used to be keyed on the
 * URL's account index, on the reasoning that the index is the only thing every
 * capture carries. The reasoning was fine and the premise was false, and a real
 * two-account recording is what settled it: 391 captures over two mailboxes,
 * 2.5 hours apart, and EVERY ONE of them was `/u/0/`. Switching accounts in the
 * browser does not move you to `/u/1/` — it leaves the slot alone and changes
 * which mailbox is behind it. So a slot-keyed id merged two people's mail into
 * one workspace, labelled it with whichever address parsed first, and nothing
 * anywhere reported a conflict.
 *
 * The address sits at `record[11][1]` of an `fd` message record (105 of 114 in
 * the first recording, every one of the 41 `fd` responses in the second). That
 * makes it absent from `bv` — which is the price, and {@link provisionalWorkspaceId}
 * is how it is paid: address-less traffic gets its own visibly-unresolved
 * workspace rather than being guessed into somebody's mailbox.
 */
export function accountWorkspaceId(address: string): string {
  return `${ADAPTER_ID}:${address.trim().toLowerCase()}`;
}

/**
 * Where traffic lands when it names an account SLOT but not the mailbox behind
 * it — `gmail:u0`.
 *
 * `bv` carries no address anywhere. Its body is arity 19 and every slot has been
 * looked at: `[1]` labels, `[2]` threads, `[6]` per-label counts, `[4]`/`[18]` a
 * mailbox-wide sync number, `[11]` a page cursor. None of them names the
 * account, and neither does the request — the only identifying header is the
 * cookie, which is a secret and is redacted before a capture is ever stored.
 *
 * So a `bv` response genuinely cannot say whose mailbox it describes, and the
 * honest thing is to say so. A provisional workspace is a holding pen: it is
 * never merged with a resolved one, it is named so the UI reads as unresolved
 * rather than as a mailbox, and {@link reconcileAccounts} empties it by
 * re-parsing its captures once a neighbouring `fd` has named the slot.
 *
 * It is deliberately the SAME string the slot-keyed scheme used to mint, so rows
 * in a store written before this change keep exactly the meaning they had —
 * "some account's slot 0" — and are reconcilable rather than stranded.
 */
export function provisionalWorkspaceId(slot: string): string {
  return `${ADAPTER_ID}:u${slot}`;
}

/**
 * The account slot back out of a PROVISIONAL workspace id — `gmail:u1` → `1`.
 *
 * Undefined for a resolved id, and that is not a gap: a mailbox's slot is a fact
 * about one browser at one moment, so `gmail:someone@example.com` is right not
 * to claim one. Callers that need a slot (only replay does, because Gmail
 * addresses accounts by path segment) take it as an argument.
 *
 * The `\d+` anchor is what keeps the two spellings apart. An address-keyed id
 * for `u0@example.com` is `gmail:u0@example.com`, which does not match, because
 * the pattern requires the digits to run to the end of the string.
 */
export function accountSlotOfWorkspaceId(workspaceId: string): string | undefined {
  const prefix = `${ADAPTER_ID}:u`;
  if (!workspaceId.startsWith(prefix)) return undefined;
  const slot = workspaceId.slice(prefix.length);
  return /^\d+$/.test(slot) ? slot : undefined;
}

/** Whether this workspace is the holding pen rather than a named mailbox. */
export function isProvisionalWorkspaceId(workspaceId: string): boolean {
  return accountSlotOfWorkspaceId(workspaceId) !== undefined;
}

/**
 * A label Container's id: the account's workspace id, then Gmail's own label id —
 * `gmail:you@example.com/^i`.
 *
 * REGRESSION: this used to be the bare label id, and `containers.id` is a PRIMARY
 * KEY. Gmail's label vocabulary is per-account — every signed-in account has an
 * `^i`, an `^all`, an `^f`, its own `^smartlabel_*` — so the second account's
 * Inbox overwrote the first's row, took its `workspace_id` with it, and both
 * mailboxes' threads were then filed in one container. Nothing reported a
 * conflict, because at the store's grain nothing was wrong.
 *
 * Thread containers are deliberately NOT scoped. A thread id is minted per
 * mailbox and never collides across accounts, so scoping it would only make the
 * same thread unreachable under the id every capture names it by.
 */
export function labelContainerId(workspaceId: string, labelId: string): string {
  return `${workspaceId}/${labelId}`;
}

/**
 * Where a thread lands when the request did not say which view it came from.
 *
 * Scoped for the same reason a label is: one shared `gmail:unknown` would merge
 * exactly the threads whose view is already unknown, which is the pair hardest to
 * pull apart afterwards.
 */
export function unknownContainerId(workspaceId: string): string {
  return `${workspaceId}/unknown`;
}

/** A label Container id taken apart: which account, and which Gmail label. */
export interface LabelRef {
  /** Absent on a row written before ids were scoped — see {@link labelRef}. */
  workspaceId?: string;
  /** The bare Gmail id, `^i`. What `gmail_list_labels` shows and a human types. */
  labelId: string;
}

/**
 * Read a Container id as a label view, or undefined when it is not one.
 *
 * A bare `^i` is still accepted: the store is a persistent artifact and nothing
 * re-parses a mailbox, so rows written before ids were scoped keep the unscoped
 * id forever. They read as "some account's Inbox", which is exactly what they
 * are — the account they belonged to was never written down.
 */
export function labelRef(containerId: string): LabelRef | undefined {
  if (containerId.startsWith('^')) return { labelId: containerId };
  const slash = containerId.indexOf('/');
  if (slash === -1) return undefined;
  const labelId = containerId.slice(slash + 1);
  if (!labelId.startsWith('^')) return undefined;
  return { workspaceId: containerId.slice(0, slash), labelId };
}

/**
 * What {@link unknownContainerId} builds, under any workspace id it has ever
 * been given — the bare `gmail:unknown` from before ids were scoped, the
 * `gmail:u0/unknown` from the slot-keyed era, and `gmail:you@example.com/unknown`
 * now. Rows outlive the parser that wrote them and are still not conversations.
 *
 * Matching on the suffix rather than on a workspace-id pattern is what makes
 * that work without a list of historical spellings to keep up to date. A thread
 * id cannot be mistaken for one: Gmail mints those as hex, so none of them
 * carries the `gmail:` prefix this insists on.
 */
function isUnrecoveredContainerId(containerId: string): boolean {
  if (!containerId.startsWith(`${ADAPTER_ID}:`)) return false;
  return containerId === `${ADAPTER_ID}:unknown` || containerId.endsWith('/unknown');
}

/**
 * Which of the three things a Gmail Container id names.
 *
 * The three are counted separately and must not be told apart by guessing at
 * prefixes at each call site: a label view is not a conversation, and the
 * "label not recovered" bucket is neither — counting it as a fetched thread
 * claims the mailbox holds a conversation that does not exist.
 */
export function containerKind(containerId: string): 'label' | 'thread' | 'unrecovered' {
  if (labelRef(containerId) !== undefined) return 'label';
  return isUnrecoveredContainerId(containerId) ? 'unrecovered' : 'thread';
}

// ── Matching ─────────────────────────────────────────────────────────────────────

/**
 * Exact host equality, and only this one host.
 *
 * `mail.google.com` has no subdomains a Gmail client uses, so there is nothing
 * for a suffix rule to buy — and a suffix rule would claim `mail.google.com.evil.test`
 * while a substring rule would claim `mail.google.comevil.com`.
 *
 * `googleusercontent.com` is deliberately NOT claimed even though it serves
 * Gmail's inline images (`ci3.googleusercontent.com/meips/…`). It is a shared
 * origin for every Google product — Drive, Photos, Docs, avatars — so claiming it
 * would attribute other products' traffic to this adapter, and `hosts` seeds the
 * proxy's TLS-intercept list, so it would also put Sluice in the middle of
 * traffic no adapter here parses. It carries images and nothing structural.
 */
function matchesGmail(host: string): boolean {
  return host === 'mail.google.com';
}

// ── Path shapes ──────────────────────────────────────────────────────────────────

/**
 * The two path families that mean anything, written down once so `classify`,
 * `parse` and the account-index lookup cannot drift about what they match.
 *
 * No `g` flags: `.test()`/`.exec()` on a global regex is stateful, and a table
 * walked twice would skip matches on alternate calls.
 */
const P = {
  /** `/sync/u/0/i/bv` — captures the account index and the operation letter(s). */
  sync: /^\/sync\/u\/(\d+)\/i\/([a-z]+)$/,
  /** `/mail/u/0/…` — the legacy XHR channel, the app shell and its telemetry. */
  mail: /^\/mail\/u\/(\d+)\//,
} as const;

/**
 * Which account this call was for. `u/0` is the first signed-in account, `u/1`
 * the second; Gmail keeps them completely separate, so it is the workspace key —
 * and a slot rather than an identity, which {@link accountWorkspaceId} spells out.
 */
function accountIndex(path: string): string | undefined {
  return P.sync.exec(path)?.[1] ?? P.mail.exec(path)?.[1];
}

// ── Envelope ─────────────────────────────────────────────────────────────────────

/** Google's anti-JSON-hijacking preamble: `)]}'` and whatever whitespace follows. */
const HIJACK_PREFIX = /^\)\]\}'\s*/;

/**
 * Decode a Gmail body: strip the preamble if it is there, then parse.
 *
 * Applied unconditionally rather than per-endpoint. The `/sync/…` responses are
 * bare arrays and the strip is a no-op on them, but which endpoints carry the
 * preamble is Google's choice and not a stable one — and getting it wrong is
 * silent, because `JSON.parse(")]}'\n[0,0]")` just throws into a hook that is not
 * allowed to throw. Returns undefined for anything that is not JSON underneath,
 * which includes the length-prefixed chunk stream the legacy channel sometimes
 * answers with.
 */
export function decodeGmailBody(body: string | null | undefined): unknown {
  const text = str(body);
  if (text === undefined || text.length === 0) return undefined;
  return safeJson(text.replace(HIJACK_PREFIX, ''));
}

// ── The `bv` layout ──────────────────────────────────────────────────────────────

/**
 * Indices into the batch-view RESPONSE, which is a bare array of arity 19.
 *
 * `[1]` is the account's label list and `[2]` is one page of threads. `[2]` is
 * `null` — not an empty array — for a view with no threads in it, which is why
 * every read here goes through `arr()`.
 */
const BV = { labels: 1, threads: 2, counts: 6 } as const;

/**
 * `[6]` — the per-label counts, wrapped one deep: `[[["^i", 2859, 14061], …]]`.
 *
 * Which of the two numbers is which was measured, not assumed, because the
 * tail on a LABEL ROW is a different number that reads exactly like a count and
 * is not one (see {@link LABEL}). Across 118 rows from two mailboxes:
 *
 *   - `[1] <= [2]` holds 118/118 times, with no exceptions;
 *   - `^all` reports 2860/14114 against `^i`'s 2859/14061, so the both-ways
 *     superset relation between all-mail and the inbox holds on both numbers.
 *
 * That fixes `[1]` as unread and `[2]` as the total. Rows of arity 1 — the id
 * alone, 4 of the 118 — are a real shape and yield nothing rather than zero: a
 * label Gmail declined to count is not a label with no mail in it.
 *
 * The id set does NOT match the label list's, in either direction (9–13 counted
 * ids the list never names, 3 named ids never counted), so this is a lookup that
 * is allowed to miss and never a source of labels in its own right.
 */
function labelCounts(node: unknown): Map<string, { unread?: number; total?: number }> {
  const out = new Map<string, { unread?: number; total?: number }>();
  for (const row of arr(arr(node)?.[0]) ?? []) {
    const cells = arr(row);
    const id = str(cells?.[0]);
    if (cells === undefined || id === undefined || id.length === 0) continue;
    const unread = num(cells[1]);
    const total = num(cells[2]);
    if (unread === undefined && total === undefined) continue;
    out.set(id, {
      ...(unread === undefined ? {} : { unread }),
      ...(total === undefined ? {} : { total }),
    });
  }
  return out;
}

/**
 * A label row is `[record, tail]`.
 *
 * `record[1]` is the DISPLAY NAME for a user label (`^x_1` → "Notes") and a
 * repeat of the id for a system one.
 *
 * `tail` is NOT a member count and is never exposed as one. Verified against the
 * recording it was derived from: `^all` reported 374 for a mailbox holding 14,055
 * threads, and `^x_2` reported 1,859,506. It is an opaque version/sync number.
 * A `memberCount` in the UI is read as a fact about the account, so a wrong one
 * is strictly worse than an absent one.
 */
const LABEL = { id: 0, name: 1 } as const;

/**
 * Indices into a thread record — `threads[i][0]`, arity 25, nulls omitted.
 *
 * Which of `[0]` and `[1]` is the subject was the one thing worth measuring, and
 * four independent structural facts over all 86 thread records in the recording
 * agree:
 *
 *   1. `[1]` is hard-capped: max length 201, 43 of 86 values land in [195, 205],
 *      NONE above. `[0]` reaches 841, 10 of 86 exceed 205, and clusters at no cap.
 *      A snippet is a fixed-width truncated preview; a subject is not.
 *   2. In all 29 multi-message threads, `[1]` is exactly one of the per-message
 *      previews at `message[9]` (29/29) and `[0]` is none of them (0/29). `[1]` is
 *      the thread-level copy of one message's preview; `[0]` is thread-scoped.
 *   3. `message[9]` carries the same 201 cap across all 127 message records,
 *      corroborating that it — and therefore `[1]` — is the snippet.
 *   4. `Re:`/`Fwd:` appears on `[0]` and never on `[1]`. Reply-prefixing is a
 *      property of a subject line.
 *
 * `[3]` is the thread id, and it is NOT always `thread-f:<digits>`: the same
 * recording holds `thread-a:r<digits>` and `thread-a:r-<digits>` as well. It is
 * taken as an opaque string for exactly that reason.
 */
const THREAD = { subject: 0, snippet: 1, ts: 2, id: 3, messages: 4 } as const;

/**
 * Indices into a `bv` thread's message row — `threads[i][0][4][j]`.
 *
 * Labels are recorded PER MESSAGE, not on the thread record. All 168 message
 * records in the recording carry their label ids at `message[10]`, and no other
 * index anywhere in a thread record holds a `^`-prefixed string at all — so a
 * thread's labels are the union across its messages.
 *
 * `[1]` is the SENDER, in the same `[1, EMAIL, name?]` shape as an entry in an
 * `fd` address list — present in 168/168 rows, address-shaped at slot 1 in
 * 168/168, arity 3 in 158 and 2 in the 10 with no display name. That it is From
 * rather than To is settled twice over. Join the 23 messages that also appear in
 * a captured `fd` body: `[1][1]` equals that message's From (`record[10][16]`) in
 * 23/23 and appears in its To in 0/23. And split by label: it is the account's own
 * address on 66 of 70 `^f` (sent) rows and on 3 of 100 `^i` (inbox) ones, which is
 * the asymmetry "from" has and "to" does not.
 *
 * Rows are oldest-first, so the LAST one is the newest message — `[17]` (equal to
 * `fd`'s date field in 23/23 joined messages) ascends in all 29 multi-message
 * threads in the recording. That is what makes "who is this thread from" the last
 * row's sender rather than the first's.
 */
const MESSAGE = { from: 1, labels: 10 } as const;

/** The Gmail search query in a `bv` REQUEST: `body[0][3]`. */
const BV_REQUEST_QUERY = 3;

// ── The `fd` layout ──────────────────────────────────────────────────────────────

/**
 * Indices into the fetch-data RESPONSE, `[0, threads[], null, null, [int]]` —
 * arity 5 in all 25 recorded responses, `[0] === 0` in 25/25.
 */
const FD = { threads: 1 } as const;

/**
 * A thread wrapper: `[THREAD_ID, summary|null, messages[]]` (arity 3, 79/94) or
 * the same with two trailing fields (arity 5, 15/94).
 *
 * `summary` is `[threadHead, messageSummaries[]]` and is present on only 15 of
 * the 94 recorded wrappers. It is what the thread-list UI renders and is not
 * needed to read a message — but it is the ONLY carrier of label ids in an `fd`
 * body. There is not one `^`-prefixed string anywhere in any of the 114 full
 * message records, so a parser that looked for labels on the record would find
 * nothing, silently, on every message.
 */
const FD_THREAD = { id: 0, summary: 1, messages: 2 } as const;
const FD_SUMMARY = { rows: 1 } as const;
const FD_SUMMARY_ROW = { id: 0, labels: 3 } as const;

/** `messages[j] = [MSG_ID, record]` — arity 2 in 114/114. */
const FD_MESSAGE = { id: 0, record: 1 } as const;

/**
 * Indices into a message record. Arity 55, with 35 of the 55 null in all 114
 * records — these are the ones that carry anything this parser wants.
 *
 * `[0]` is **To** and `[10][16]` is **From**, and that pairing is the one thing
 * here worth being sure of, because getting it backwards inverts every message
 * and nothing in the data complains. Two anchors settle it. The account's own
 * address is `record[11][1]` — the same value in 105/105 records that have it,
 * and the same address Gmail's own identity list at `GET /mail/u/{n}/data`
 * reports. And the thread summary's `[1]` is From: split the 29 summary-joined
 * messages by label and `summary[1]` is the account on 9/9 `^f` (sent) messages
 * and 0/19 `^i` (inbox) ones, which is what "from" means. `record[10][16]` then
 * equals `summary[1]`'s address in 29/29, while `record[0]` does so in 0/29 —
 * and `record[0]` holds the account on 81/114 records and on 0/9 sent ones,
 * which is what "to" means.
 *
 * `[1]` is **Cc**: present 26/114, never more than 3 addresses, disjoint from
 * `[0]` (1 overlap in 114) and from `[3]`. Bcc is ruled out by visibility — Bcc
 * is not rendered on received mail and 24 of the 26 are received.
 *
 * `[3]` is **Reply-To** and is deliberately NOT read here. It is where a reply
 * would go, not somebody who took part: it is absent on all 9 sent messages,
 * never the account, and 37 of its 74 values are `reply…`/`no-reply…` addresses
 * that neither sent nor received anything. Turning it into an Actor would put
 * mailer daemons in the address book.
 */
const REC = {
  to: 0,
  cc: 1,
  subject: 4,
  body: 5,
  snippet: 6,
  sender: 10,
  /**
   * `[1, ACCOUNT_EMAIL]` — whose mailbox this is. The same address in all 105 of
   * the 114 records that carry it, and the same one Gmail's own identity list at
   * `GET /mail/u/{n}/data` reports. It is the only place the account is named:
   * the URL yields `u/0`, which is a slot number, not an identity.
   */
  account: 11,
  date: 16,
} as const;

/**
 * `record[10]` — the sender card. `[16]` is the address (an address in 114/114).
 *
 * `[14]` is the display name. The evidence is narrow but it is a positive test
 * and it has no counter-example: of the 29 messages that can be joined to a
 * thread summary, 9 have both `[14]` and a display name on `summary[1]`, and all
 * 9 agree. `[14]` is never an address and never a URL in the 58 records that
 * have it. The rest of `record[10]` — `[7]`, `[8]`, `[11]`, `[12]`, `[13]` — is
 * display-name-shaped strings and an https URL whose meaning is unknown, and is
 * left alone rather than guessed at.
 */
const SENDER = { name: 14, address: 16 } as const;

/**
 * One entry in an address list: `[1, EMAIL]` or `[1, EMAIL, DISPLAY_NAME]`. The
 * leading `1` is `1` in all 234 entries across `[0]`, `[1]` and `[3]`; it is not
 * read, because a constant carries no information and a parser that required it
 * would drop every address the day Google sends a 2.
 */
const ADDRESS = { address: 1, name: 2 } as const;

/**
 * `record[5]` — the body block:
 *
 *   `[null, htmlParts[], clipped, clippedUrl|null, plainAlt|null, id|null, …]`
 *
 * Type here is POSITIONAL. There is not a single content-type or charset marker
 * anywhere in `record[5]` — zero strings match `type/subtype`, zero match the
 * charset family — so anything grepping for `text/plain` finds nothing on every
 * message. Slot `[1]` is HTML and slot `[4][6]` is text, and that is the only
 * thing that says so.
 */
const BODY = { parts: 1, clipped: 2, clippedUrl: 3, plain: 4 } as const;

/** `htmlParts[k] = [kind, null, [null, HTML], id]` — exact in 169/169 parts. */
const PART = { content: 2 } as const;
const PART_HTML = 1;

/** `record[5][4] = [null ×6, TEXT]` — arity 7 in 51/51 where it is present. */
const PLAIN_TEXT = 6;

// ── Reading a message record ─────────────────────────────────────────────────────

/** An address and, when the wire carried one, the name in front of it. */
export interface AddressRef {
  address: string;
  name?: string;
}

/** One entry of an address list, or undefined when the slot is not an address. */
function addressRef(fields: unknown[] | undefined): AddressRef | undefined {
  const address = str(fields?.[ADDRESS.address]);
  if (address === undefined || !address.includes('@')) return undefined;
  const name = str(fields?.[ADDRESS.name]);
  return name !== undefined && name.length > 0 ? { address, name } : { address };
}

/**
 * `[[1, EMAIL, name?], …]` → the addresses in it.
 *
 * An entry whose address slot is not an address is dropped rather than kept as
 * prose: the address IS the Actor's id, and a row keyed by a display name would
 * upsert onto whatever else that string names.
 */
function addressList(v: unknown): AddressRef[] {
  const out: AddressRef[] = [];
  for (const entry of arr(v) ?? []) {
    const ref = addressRef(arr(entry));
    if (ref !== undefined) out.push(ref);
  }
  return out;
}

/** The message's From, from the sender card. */
function senderOf(record: unknown[]): AddressRef | undefined {
  const card = arr(record[REC.sender]);
  const address = str(card?.[SENDER.address]);
  if (address === undefined || !address.includes('@')) return undefined;
  const name = str(card?.[SENDER.name]);
  return name !== undefined && name.length > 0 ? { address, name } : { address };
}

/** Every HTML part, in array order, concatenated. `''` when there are none. */
function htmlBody(block: unknown[] | undefined): string {
  let html = '';
  for (const part of arr(block?.[BODY.parts]) ?? []) {
    html += str(arr(arr(part)?.[PART.content])?.[PART_HTML]) ?? '';
  }
  return html;
}

/**
 * What Gmail says when it has truncated a message itself.
 *
 * `record[5][2] === 1` on 9 of 114 messages, and those 9 STILL carry parts
 * (9/9, median 7 315 bytes) — the URL is an escape hatch for the tail, not a
 * replacement for the body. Saying so in the text is the point: a reader that is
 * handed two thirds of a message with no sign of it answers confidently from the
 * part it got. The length cap in html-to-text.ts gets no such marker, and
 * deliberately — it clips nothing in the whole recording.
 */
function clippedNote(block: unknown[] | undefined): string {
  if (num(block?.[BODY.clipped]) !== 1) return '';
  const url = str(block?.[BODY.clippedUrl]);
  return url === undefined || url.length === 0
    ? '\n\n[message clipped by Gmail]'
    : `\n\n[message clipped by Gmail; full text at ${url}]`;
}

/**
 * The message body, preferring the form that indexes best.
 *
 * The plain-text alternative first (`record[5][4][6]`, 51/114 — no HTML tags and
 * no MIME header lines in 51/51, so it is a genuine alternative and not a raw
 * part), then the HTML flattened, then the snippet. Nothing here may assume the
 * result is non-empty: one message in the recording has a 34-byte body.
 *
 * The snippet is the last resort rather than an equal: it is hard-capped at 160
 * characters (103 of 114 are exactly 160), so preferring it would throw away the
 * message on every long one.
 */
function messageBody(record: unknown[]): string {
  const block = arr(record[REC.body]);
  const note = clippedNote(block);
  const plain = (str(arr(block?.[BODY.plain])?.[PLAIN_TEXT]) ?? '').trim();
  const html = htmlToText(htmlBody(block));

  // The `[4][6]` slot is NOT reliably plain text, and preferring it blindly was
  // wrong. A real message in the recording — a marketing mail whose HTML part is
  // 44 724 characters — carries 882 characters of raw CSS there, with no <style>
  // wrapper for the stripper to catch, so the whole rendered body came out as
  // `.msg-123 u+.m_123body img~div div{display:none}…`. Whatever that slot is, it
  // is not "the text alternative" on every message.
  //
  // So the slot is used only when it looks like prose. That is cheap to test and
  // fails safe in the direction that matters: mistaking prose for CSS costs the
  // stripped HTML, which is a fine body; mistaking CSS for prose costs the reader
  // the entire message.
  if (plain.length > 0 && !looksLikeCss(plain)) return clamp(plain) + note;
  if (html.length > 0) return html + note;
  if (plain.length > 0) return clamp(plain) + note; // CSS beats nothing at all
  return (str(record[REC.snippet]) ?? '') + note;
}

function clamp(text: string): string {
  return (text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text).trim();
}

/**
 * Does this look like a stylesheet rather than something someone wrote?
 *
 * Two signals, both cheap and neither fooled by prose that merely contains
 * punctuation: a CSS rule opening near the start (`.cls{`, `#id {`, `@media`),
 * and a high density of `{};:` — real prose runs well under 1%, a stylesheet
 * well over it. Requiring BOTH keeps a message that happens to quote a snippet
 * of CSS from being thrown away.
 */
function looksLikeCss(text: string): boolean {
  const head = text.slice(0, 400);
  const opensARule = /(^|\s)[.#@]?[\w-]+[^{}\n]{0,80}\{[^}]*[:;]/.test(head);
  if (!opensARule) return false;
  const punctuation = (text.match(/[{};:]/g) ?? []).length;
  return punctuation / text.length > 0.02;
}

/**
 * `Item.text` — the subject, then the body.
 *
 * `Item` has no subject field and is not getting one: a `subject` column in
 * `@sluice/core` would be a Gmail field in the spine that Slack, Trello and
 * fast.com have no answer for. Of the two places a generic consumer could still
 * find it, `text` is the one that works. `text` is what `items_fts` indexes and
 * what every reader — the webapp, `gmail_search`, an MCP client — renders; a
 * well-known key in `raw` would be searchable by nothing and rendered by
 * nothing, and `raw` is already lossless anyway (the subject is at index 4 of
 * the record sitting in it). The cost is that `text` is no longer purely a body,
 * which is exactly how every mail client on earth displays a message.
 *
 * {@link threadText} does the same for `bv` thread rows, and for the same
 * reasons. They used to carry the snippet alone, which is what Gmail renders as
 * the preview LINE — but it is not what Gmail renders as the thread's title, so
 * a generic reader listing items by their text showed every conversation by its
 * first few words of body and never by its subject. It also kept subjects out
 * of the FTS index for exactly the half of the mailbox that has no bodies
 * captured, which is the half a search is most needed for.
 */
function threadText(thread: unknown[]): string {
  const subject = (str(thread[THREAD.subject]) ?? '').trim();
  const snippet = (str(thread[THREAD.snippet]) ?? '').trim();
  if (subject.length === 0) return snippet;
  return snippet.length === 0 ? subject : `${subject}\n\n${snippet}`;
}

function messageText(record: unknown[]): string {
  const subject = (str(record[REC.subject]) ?? '').trim();
  const body = messageBody(record);
  if (subject.length === 0) return body;
  return body.length === 0 ? subject : `${subject}\n\n${body}`;
}

/**
 * Label ids per message id, read off the thread summary.
 *
 * Empty for the 79 of 94 thread wrappers that have no summary, and that is the
 * normal case — see {@link FD_THREAD}. Absent labels cost the message its
 * `in-label` edges and nothing else, which is why the container is the thread.
 */
function summaryLabels(summary: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of arr(arr(summary)?.[FD_SUMMARY.rows]) ?? []) {
    const fields = arr(row);
    const id = str(fields?.[FD_SUMMARY_ROW.id]);
    if (id === undefined || id.length === 0) continue;
    const labels: string[] = [];
    for (const label of arr(fields?.[FD_SUMMARY_ROW.labels]) ?? []) {
      const value = str(label);
      if (value !== undefined && value.startsWith('^')) labels.push(value);
    }
    if (labels.length > 0) out.set(id, labels);
  }
  return out;
}

// ── Reading a STORED record back ─────────────────────────────────────────────────

/**
 * The fields of one message, read back out of a stored `Item.raw`.
 *
 * `Item` flattens a message to `text` — for `fd` items, the subject and the body
 * joined (see {@link messageText}) — because that is the column `items_fts`
 * indexes and the one every generic reader renders. A mail client needs them
 * apart again, and `raw` is lossless, so this reads the record a second time
 * rather than trying to unpick the flattened string. Splitting `text` back on its
 * first blank line would guess wrong on every message whose body opens with one.
 *
 * Total, like everything else that touches a record: `raw` comes off a JSON
 * column that a truncated write or a hand-edited `--db` can leave malformed, and
 * an MCP tool that throws on one bad row answers nothing for the whole page.
 */
export interface GmailMessageView {
  subject: string;
  body: string;
  from?: AddressRef;
  to: AddressRef[];
  cc: AddressRef[];
  /** Epoch ms, absent when the record carried no date. */
  date?: number;
}

export function gmailMessageView(raw: unknown): GmailMessageView {
  const record = arr(raw);
  if (record === undefined) return { subject: '', body: '', to: [], cc: [] };
  const view: GmailMessageView = {
    subject: (str(record[REC.subject]) ?? '').trim(),
    body: messageBody(record),
    to: addressList(record[REC.to]),
    cc: addressList(record[REC.cc]),
  };
  const from = senderOf(record);
  if (from !== undefined) view.from = from;
  const date = num(record[REC.date]);
  if (date !== undefined) view.date = date;
  return view;
}

/**
 * The fields of one thread, read back out of a `bv` thread Item's `raw`.
 *
 * `from` is the NEWEST message's sender — see {@link MESSAGE} for why that is the
 * last row. `messageCount` is what Gmail said the thread holds, which is not the
 * number of messages Sluice has: `bv` names a thread's messages without carrying
 * their bodies, so a two-message thread here may have zero fetched messages in
 * the store.
 */
export interface GmailThreadView {
  subject: string;
  snippet: string;
  messageCount: number;
  from?: AddressRef;
}

export function gmailThreadView(raw: unknown): GmailThreadView {
  const thread = arr(raw);
  if (thread === undefined) return { subject: '', snippet: '', messageCount: 0 };
  const messages = arr(thread[THREAD.messages]) ?? [];
  const view: GmailThreadView = {
    subject: (str(thread[THREAD.subject]) ?? '').trim(),
    snippet: str(thread[THREAD.snippet]) ?? '',
    messageCount: messages.length,
  };
  const from = addressRef(arr(arr(messages[messages.length - 1])?.[MESSAGE.from]));
  if (from !== undefined) view.from = from;
  return view;
}

// ── Labels ───────────────────────────────────────────────────────────────────────

/**
 * Friendly names for Gmail's internal label vocabulary.
 *
 * A Map rather than an object literal: the key comes straight off the wire, so
 * `^constructor` against a plain object returns a function — truthy, and then
 * read as a name.
 *
 * Deliberately incomplete. `^b`, `^t_z`, `^wc_tb_ready`, `^assistive_*` and the
 * `^io_lr*` read-receipt signals are all in the recording and all absent here:
 * a label displayed under a confidently-wrong name is worse than one displayed
 * under its raw id, which at least reads as "internal" and can be looked up.
 */
const SYSTEM_LABEL_NAMES = new Map<string, string>([
  ['^all', 'All Mail'],
  ['^i', 'Inbox'],
  ['^f', 'Sent'],
  ['^r', 'Drafts'],
  ['^t', 'Starred'],
  ['^s', 'Spam'],
  ['^k', 'Trash'],
  ['^io_im', 'Important'],
  ['^io_unim', 'Unimportant'],
  ['^scheduled', 'Scheduled'],
  ['^smartlabel_promo', 'Promotions'],
  ['^smartlabel_social', 'Social'],
  ['^smartlabel_notification', 'Updates'],
  ['^smartlabel_group', 'Forums'],
  ['^smartlabel_finance', 'Finance'],
  ['^smartlabel_receipt', 'Receipts'],
  ['^smartlabel_travel', 'Travel'],
]);

/** Display name, friendly name, raw id — in that order of preference. */
function labelName(id: string, display: string | undefined): string {
  if (display !== undefined && display.length > 0 && display !== id) return display;
  return SYSTEM_LABEL_NAMES.get(id) ?? id;
}

/**
 * `in:^i` — a Gmail search term naming a label, with its optional negation.
 *
 * The leading `(^|[\s(])` is what makes the negation readable: a query nests
 * terms in parentheses (`((in:^f) OR (in:^pfg))`), so `-` has to be recognised
 * where it actually sits rather than assumed to follow a space.
 */
const IN_LABEL = /(^|[\s(])(-?)in:(\^[a-z0-9_]+)/gi;

/**
 * The label a query is asking FOR, ignoring the ones it excludes.
 *
 * Across the four captured views the first non-negated term is always the view
 * itself: `in:^t` → `^t`, `in:^t_z -in:^i …` → `^t_z`,
 * `((in:^f) OR (in:^pfg) OR (in:^f_clns))` → `^f`, `in:^r -in:^f_clns -in:^cr` → `^r`.
 */
function firstIncludedLabel(query: string | undefined): string | undefined {
  if (query === undefined) return undefined;
  for (const m of query.matchAll(IN_LABEL)) {
    if (m[2] === '' && m[3] !== undefined) return m[3];
  }
  return undefined;
}

/**
 * Which label a `bv` response answered for — recovered from the REQUEST.
 *
 * The response does not say. This is the same problem Slack's
 * `conversations.history` has with `channel`: the answer exists only in the call,
 * and a parser that cannot read the call silently files every thread under
 * nothing at all.
 *
 * The indexed read is the verified one; the whole-body scan behind it is there
 * because the request frame is a positional array whose arity has no contract,
 * and the query is the only part of it whose SHAPE is self-describing.
 */
function bvLabelFromRequest(capture: Capture): string | undefined {
  const frame = arr(arr(safeJson(capture.reqBody))?.[0]);
  return (
    firstIncludedLabel(str(frame?.[BV_REQUEST_QUERY])) ?? firstIncludedLabel(str(capture.reqBody))
  );
}

// ── Classification ───────────────────────────────────────────────────────────────

/** The operation names, spelled once. Never the raw path — `u/0` must not fragment them. */
const OP = { bv: 'sync.bv', fd: 'sync.fd', s: 'sync.s', xhr: 'mail.xhr', asset: 'asset' } as const;

/**
 * A Map, not an object literal: the key is a path segment off the wire, and
 * `/sync/u/0/i/constructor` against a plain object returns a function rather than
 * undefined — truthy, and then read for a `.class` that is not there.
 */
const SYNC_CLASSES = new Map<string, CaptureClass>([
  ['bv', 'structure'],
  ['fd', 'messages'],
  ['s', 'structure'],
]);

/**
 * What a path is, ignoring status. Total: it reads only the path.
 *
 * Everything under `/mail/u/{n}/` collapses to ONE operation deliberately. The
 * legacy XHR channel, the app shell, `checkbuild`, `logstreamz` and the service
 * worker all share that prefix, none of them is parsed, and naming them
 * individually would bury the handful of calls that matter under the dozens that
 * never will — the same trade `asset` makes for the static bundles.
 */
function gmailRoute(path: string): { class: CaptureClass; operation: string } {
  const sync = P.sync.exec(path);
  if (sync) {
    const op = sync[2] ?? '';
    // An `i/` endpoint that is not one of the three known ones is still worth
    // naming: "which calls does Gmail make that we do not handle?" is precisely
    // the question the traffic table is being asked.
    return { class: SYNC_CLASSES.get(op) ?? 'unknown', operation: `sync.${op}` };
  }
  if (P.mail.test(path)) return { class: 'unknown', operation: OP.xhr };
  return { class: 'asset', operation: OP.asset };
}

/**
 * What kind of exchange this is, without parsing it. Never throws.
 *
 * A 4xx/5xx keeps the operation it would otherwise have had: the traffic table
 * still has to say WHICH call failed, and `error` on its own does not.
 */
export function classifyGmailCapture(capture: Capture): {
  class: CaptureClass;
  operation?: string;
} {
  const route = gmailRoute(str(capture.path) ?? '');
  const status = capture.status;
  if (typeof status === 'number' && status >= 400) {
    return { class: 'error', operation: route.operation };
  }
  return route;
}

// ── Parser ───────────────────────────────────────────────────────────────────────

/** Every `^`-prefixed label id on any of a thread's messages, de-duplicated. */
function threadLabels(thread: unknown[]): string[] {
  const out = new Set<string>();
  for (const message of arr(thread[THREAD.messages]) ?? []) {
    for (const label of arr(arr(message)?.[MESSAGE.labels]) ?? []) {
      const id = str(label);
      if (id !== undefined && id.startsWith('^')) out.add(id);
    }
  }
  return [...out];
}

/**
 * Turn one capture into normalized entities. `bv` and `fd` are parsed; `s`, the
 * legacy channel, the shell and a malformed body all yield an empty result.
 */
export function parseGmailCapture(capture: Capture, ctx?: ParseContext): ParseResult {
  const path = str(capture.path) ?? '';
  const route = gmailRoute(path);
  if (route.operation !== OP.bv && route.operation !== OP.fd) return {};

  const slot = accountIndex(path);
  const body = arr(decodeGmailBody(capture.resBody));
  if (slot === undefined || body === undefined) return {};

  // Identity, in the order of how much it can be trusted.
  //
  //   1. What the CALLER resolved. Only `reconcileAccounts` sets this, and only
  //      after reading the slot's address off a neighbouring capture — which is
  //      strictly more than this response knows about itself.
  //   2. What this response SAYS. An `fd` body names the mailbox outright.
  //   3. The slot, as a provisional id that claims nothing.
  //
  // The address scan runs before any entity is built, because every id in the
  // result hangs off the workspace and the address is buried three levels down
  // in the message records.
  const declared = route.operation === OP.fd ? accountAddressOf(body) : undefined;
  const workspaceId =
    str(ctx?.workspaceId) ??
    (declared === undefined ? provisionalWorkspaceId(slot) : accountWorkspaceId(declared));

  const workspace = accountWorkspace(workspaceId, slot);
  return route.operation === OP.bv
    ? parseBatchView(capture, body, workspace)
    : parseFetchData(capture, body, workspace);
}

/**
 * The mailbox an `fd` response belongs to, or undefined when it does not say.
 *
 * Every message record carries it at `record[11]` as `[1, "you@example.com"]`,
 * and every record in a response agrees — so the first sighting is the answer
 * and the walk stops there. The 9 of 114 records in the first recording that
 * lacked it were drafts, which have no delivery envelope to carry it.
 *
 * Reached by walking rather than by indexing the documented path, because this
 * runs BEFORE the entity loop has established which shape the body took, and a
 * missed address is not a cosmetic failure here — it is a mailbox filed in the
 * holding pen. The walk is depth-limited so a hostile body cannot spin it.
 */
function accountAddressOf(body: unknown[]): string | undefined {
  const seen = (node: unknown, depth: number): string | undefined => {
    const list = arr(node);
    if (list === undefined || depth > FD_SCAN_DEPTH) return undefined;
    const address = addressRef(arr(list[REC.account]))?.address;
    if (address !== undefined && address.length > 0) return address;
    for (const child of list) {
      const found = seen(child, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return seen(body, 0);
}

/**
 * How deep {@link accountAddressOf} will look. An `fd` body reaches a message
 * record in five hops (`[1] → thread → [2] → [message] → record`); the slack is
 * for a shape Google changes, and the ceiling is for one it never sends.
 */
const FD_SCAN_DEPTH = 8;

/**
 * The `/u/N/` slot a capture was made against — `0`, `1` — or undefined when the
 * path names no account at all.
 *
 * Deliberately broader than the two parsed operations: it answers for the app
 * shell and the legacy XHR channel too, because reconciling a mailbox means
 * knowing which slot EVERY capture in a window belonged to, not just the two
 * that yield entities.
 */
export function gmailAccountSlot(capture: Capture): string | undefined {
  return accountIndex(str(capture.path) ?? '');
}

/**
 * The mailbox a capture names, or undefined when it names none.
 *
 * Only an `fd` response ever does. This is the atom the whole account-identity
 * scheme rests on, so it is one function rather than a rule each caller applies:
 * the parser keys the workspace with it, and the reconciler builds its ledger of
 * (slot, moment) → mailbox out of it.
 */
export function gmailAccountAddress(capture: Capture): string | undefined {
  const path = str(capture.path) ?? '';
  if (gmailRoute(path).operation !== OP.fd) return undefined;
  const body = arr(decodeGmailBody(capture.resBody));
  return body === undefined ? undefined : accountAddressOf(body);
}

/**
 * Whether parsing this capture would produce anything at all.
 *
 * The two parsed operations, and a body that decodes. Everything else on
 * `mail.google.com` — the app shell, the `s` heartbeat, the legacy XHR channel,
 * the telemetry beacons — is a capture this adapter has no reading of, and
 * three quarters of a Gmail session is exactly that.
 *
 * Reconciliation is what needs the distinction. "I could not tell which mailbox
 * this belonged to" is a real finding about a thread list and pure noise about a
 * heartbeat, and reporting the heartbeats too turns a report a person should
 * read into one they will not.
 */
export function gmailCarriesEntities(capture: Capture): boolean {
  const operation = gmailRoute(str(capture.path) ?? '').operation;
  if (operation !== OP.bv && operation !== OP.fd) return false;
  return arr(decodeGmailBody(capture.resBody)) !== undefined;
}

/**
 * The account itself, emitted by both parsers so nothing is ever orphaned.
 *
 * Everything here is a pure function of the WORKSPACE ID, and that is the whole
 * design. `name` is ASSIGNED on upsert rather than coalesced, so whichever parse
 * ran last wins — and a name derived from anything the id does not already carry
 * would therefore flicker between what two endpoints each happened to see. An id
 * that is the address answers both fields on its own, so every parse of every
 * capture of one mailbox produces byte-identical rows and order stops mattering.
 *
 * That is also why the provisional name says what it is. It reads as "we have
 * mail from slot 0 and do not yet know whose", because that is true, and a
 * workspace list is exactly where a person should find that out. Calling it
 * `Gmail (u0)` was the old spelling and it read as a mailbox — which is how two
 * accounts merged into one row without anyone noticing.
 */
function accountWorkspace(workspaceId: string, slot: string): Workspace {
  const address = addressOfWorkspaceId(workspaceId);
  if (address === undefined) {
    return {
      id: workspaceId,
      adapterId: ADAPTER_ID,
      name: `Gmail (u${slot} — mailbox not identified)`,
    };
  }
  return { id: workspaceId, adapterId: ADAPTER_ID, name: address, domain: address };
}

/**
 * The mailbox address a resolved workspace id is built from, or undefined for a
 * provisional one. The inverse of {@link accountWorkspaceId}.
 */
export function addressOfWorkspaceId(workspaceId: string): string | undefined {
  const prefix = `${ADAPTER_ID}:`;
  if (!workspaceId.startsWith(prefix) || isProvisionalWorkspaceId(workspaceId)) return undefined;
  const address = workspaceId.slice(prefix.length);
  return address.includes('@') ? address : undefined;
}

/**
 * `bv` — the label list plus one page of threads, and the edges between them.
 *
 * One Item per THREAD, filed under the label the REQUEST asked for. `fd` emits
 * one per MESSAGE under the thread; see {@link parseFetchData} for why the two
 * grains cannot collide.
 */
function parseBatchView(capture: Capture, body: unknown[], workspace: Workspace): ParseResult {
  const workspaceId = workspace.id;
  const workspaces: Workspace[] = [workspace];
  const counts = labelCounts(body[BV.counts]);

  const containers: Container[] = [];
  for (const row of arr(body[BV.labels]) ?? []) {
    const record = arr(arr(row)?.[0]);
    const id = str(record?.[LABEL.id]);
    if (id === undefined || id.length === 0) continue;
    const count = counts.get(id);
    containers.push({
      // Scoped: `^i` is every account's Inbox, and the id is a primary key.
      id: labelContainerId(workspaceId, id),
      workspaceId,
      adapterId: ADAPTER_ID,
      kind: 'other',
      // The NAME keeps the bare id, which is what Gmail calls the label and what
      // a reader recognises; the account is on `workspaceId` already.
      name: labelName(id, str(record?.[LABEL.name])),
      ...(count?.total === undefined ? {} : { itemCount: count.total }),
      ...(count?.unread === undefined ? {} : { unreadCount: count.unread }),
      raw: record,
    });
  }

  // A thread whose view could not be recovered is filed under a named container
  // rather than dropped: the capture is evidence the thread exists, and losing it
  // to a request we failed to read is a worse answer than an honest placeholder.
  const label = bvLabelFromRequest(capture);
  const containerId =
    label === undefined ? unknownContainerId(workspaceId) : labelContainerId(workspaceId, label);
  const items: Item[] = [];
  const edges: Edge[] = [];
  for (const row of arr(body[BV.threads]) ?? []) {
    const thread = arr(arr(row)?.[0]);
    const id = str(thread?.[THREAD.id]);
    if (thread === undefined || id === undefined || id.length === 0) continue;
    items.push({
      id,
      containerId,
      workspaceId,
      adapterId: ADAPTER_ID,
      kind: 'message',
      ts: num(thread[THREAD.ts]) ?? 0,
      text: threadText(thread),
      sourceCaptureIds: [capture.id],
      raw: thread,
    });
    // Unfiltered on purpose. Most of these (`^io_lr30s`, `^eclicks_msg`, `^sq_ig_*`)
    // never appear in the label list and so point at a Container that will not
    // exist — which the edges table is explicitly built to allow. Filtering to the
    // labels seen in THIS response would instead drop a real user label the moment
    // a response carried a partial list.
    for (const labelId of threadLabels(thread)) {
      edges.push({
        srcKind: 'item',
        srcId: id,
        rel: 'in-label',
        dstKind: 'container',
        // The same scoped id the container carries. An edge pointing at the bare
        // `^i` would resolve to whichever account happened to write that row.
        dstId: labelContainerId(workspaceId, labelId),
        adapterId: ADAPTER_ID,
        workspaceId,
      });
    }
  }
  if (label === undefined && items.length > 0) {
    containers.push({
      id: containerId,
      workspaceId,
      adapterId: ADAPTER_ID,
      kind: 'other',
      name: 'Gmail (label not recovered)',
    });
  }

  const result: ParseResult = { workspaces };
  if (containers.length > 0) result.containers = containers;
  if (items.length > 0) result.items = items;
  if (edges.length > 0) result.edges = edges;
  return result;
}

/**
 * An Actor's id: the account's workspace id, then the address lowercased —
 * `gmail:you@example.com/alice@example.com`.
 *
 * The address is the only identifier Gmail gives a correspondent (there is no
 * user id anywhere in `fd`) and the same person appears with different
 * capitalisation across headers, so lowering it is what makes one person one
 * actor.
 *
 * SCOPED for the same reason a label container is, and the bug was the same
 * shape: `actors.id` is a PRIMARY KEY, and two signed-in accounts that both
 * correspond with the same person — which is the ordinary case, not the corner
 * one — wrote one row whose `workspace_id` flipped to whichever mailbox parsed
 * last. Every `authored` edge from the other account then pointed at an actor
 * filed under a mailbox it was not in.
 */
function actorId(workspaceId: string, address: string): string {
  return `${workspaceId}/${address.toLowerCase()}`;
}

/** Remember one address as an Actor, upgrading it if this sighting has a name. */
function rememberActor(actors: Map<string, Actor>, ref: AddressRef, workspaceId: string): string {
  const id = actorId(workspaceId, ref.address);
  const existing = actors.get(id);
  if (existing === undefined) {
    const actor: Actor = { id, workspaceId, adapterId: ADAPTER_ID, handle: ref.address };
    if (ref.name !== undefined) actor.displayName = ref.name;
    actors.set(id, actor);
    return id;
  }
  // A later sighting only ever ADDS a name. Most address lists carry none (101 of
  // the 234 entries in the recording), so letting a nameless one win would erase
  // a name the same response had already supplied.
  if (existing.displayName === undefined && ref.name !== undefined) existing.displayName = ref.name;
  return id;
}

/**
 * `fd` — one Item per MESSAGE, the people on it as Actors, and the thread it
 * belongs to as its Container.
 *
 * **Why the thread is the container.** The alternative was the label, with the
 * thread on `Item.threadId` the way app-slack files a threaded reply under its
 * channel. Slack can do that because its response names the channel for every
 * message it returns; Gmail's `fd` names the thread for all 114 messages and the
 * label for the 29 that happen to arrive with a thread summary. Filing on the
 * label would therefore put 85 of 114 messages in a "label not recovered"
 * bucket — and worse, it would make a message's container depend on WHICH
 * capture parsed it. Items upsert by `(container_id, id)`, so the same message
 * seen once without a summary and once with one lands in the store TWICE, under
 * two containers, and nothing anywhere reports a conflict. The rule that
 * survives both adapters is not "the container is the channel" but "the
 * container is the innermost place the response actually names".
 *
 * `threadId` is set anyway, to the same value. It is redundant here by
 * construction and it is what makes "group this conversation" one query across
 * adapters instead of a Gmail special case.
 *
 * A thread's labels still reach the store, as `in-label` edges from each
 * message — the same relation `bv` emits for a thread. That is what the edges
 * table is for, and it is the honest shape: in Gmail a label is a property of a
 * message, not a folder it was moved into.
 */
function parseFetchData(capture: Capture, body: unknown[], workspace: Workspace): ParseResult {
  const workspaceId = workspace.id;
  const actors = new Map<string, Actor>();
  const containers: Container[] = [];
  const items: Item[] = [];
  const edges: Edge[] = [];

  for (const wrapper of arr(body[FD.threads]) ?? []) {
    const thread = arr(wrapper);
    const threadId = str(thread?.[FD_THREAD.id]);
    if (thread === undefined || threadId === undefined || threadId.length === 0) continue;

    const labels = summaryLabels(thread[FD_THREAD.summary]);
    let threadName: string | undefined;
    let messagesInThread = 0;

    for (const entry of arr(thread[FD_THREAD.messages]) ?? []) {
      const pair = arr(entry);
      const id = str(pair?.[FD_MESSAGE.id]);
      const record = arr(pair?.[FD_MESSAGE.record]);
      if (id === undefined || id.length === 0 || record === undefined) continue;
      messagesInThread += 1;

      // Messages arrive oldest-first (12/12 multi-message threads in the
      // recording), so the first subject that is not empty is the one the thread
      // was started with — which is what Gmail titles a thread by. One message in
      // the recording has an empty subject, hence "first non-empty" rather than
      // "first".
      const subject = str(record[REC.subject]);
      if (threadName === undefined && subject !== undefined && subject.length > 0) {
        threadName = subject;
      }

      const from = senderOf(record);
      const recipients = [...addressList(record[REC.to]), ...addressList(record[REC.cc])];

      const item: Item = {
        id,
        containerId: threadId,
        workspaceId,
        adapterId: ADAPTER_ID,
        kind: 'message',
        ts: num(record[REC.date]) ?? 0,
        text: messageText(record),
        threadId,
        sourceCaptureIds: [capture.id],
        raw: record,
      };
      if (from !== undefined) item.authorId = rememberActor(actors, from, workspaceId);
      items.push(item);

      if (from !== undefined) {
        edges.push({
          srcKind: 'actor',
          // The SAME id `rememberActor` minted, not a second derivation of it.
          // These two spellings drifted apart the moment actor ids became
          // account-scoped, and an edge pointing at an actor row that does not
          // exist fails silently — the edges table permits dangling endpoints
          // by design, so nothing would have reported it.
          srcId: actorId(workspaceId, from.address),
          rel: 'authored',
          dstKind: 'item',
          dstId: id,
          adapterId: ADAPTER_ID,
          workspaceId,
        });
      }
      for (const ref of recipients) {
        edges.push({
          srcKind: 'item',
          srcId: id,
          rel: 'sent-to',
          dstKind: 'actor',
          dstId: rememberActor(actors, ref, workspaceId),
          adapterId: ADAPTER_ID,
          workspaceId,
        });
      }
      // Same rule as `bv`: unfiltered, because most of these label ids never
      // appear in any label list and so point at a Container that will not
      // exist, which the edges table is explicitly built to allow.
      for (const labelId of labels.get(id) ?? []) {
        edges.push({
          srcKind: 'item',
          srcId: id,
          rel: 'in-label',
          dstKind: 'container',
          // Scoped, like `bv`'s: the same message in two accounts must not point
          // both mailboxes at one label row.
          dstId: labelContainerId(workspaceId, labelId),
          adapterId: ADAPTER_ID,
          workspaceId,
        });
      }
    }

    // No container for a wrapper that yielded no message: an empty thread is a
    // shape this parser did not understand, and a named row for it would claim
    // the mailbox holds something it does not.
    //
    // No `raw` either, unlike the label containers. The only record a thread has
    // is the wrapper, and the wrapper CONTAINS every message — storing it here
    // would write a second copy of every body next to the items that already
    // hold them.
    if (messagesInThread > 0) {
      containers.push({
        id: threadId,
        workspaceId,
        adapterId: ADAPTER_ID,
        // Not `other`: one of these exists per conversation, so a reader that
        // cannot tell them from the label views has 94 threads interleaved
        // alphabetically with 24 labels and no structure left to navigate.
        kind: 'thread',
        name: threadName ?? threadId,
      });
    }
  }

  const result: ParseResult = { workspaces: [workspace] };
  if (actors.size > 0) result.actors = [...actors.values()];
  if (containers.length > 0) result.containers = containers;
  if (items.length > 0) result.items = items;
  if (edges.length > 0) result.edges = edges;
  return result;
}

// ── Pagination ───────────────────────────────────────────────────────────────────

/**
 * Always `[]`. Never throws.
 *
 * Gmail pages `bv` somehow — one captured view returned 51 threads while the
 * response's own `[3]` flipped to 1 and `[11]` read `[1, 201]`, which is what a
 * has-more flag next to a larger total looks like. But knowing that more exist is
 * not knowing how to ASK for them, and nothing in the capture identifies the
 * field that would advance:
 *
 *   - the request carries no opaque token, and the response carries no string
 *     that is not either a label id or a view name;
 *   - the one number that varies between requests, `body[0][4][4]`, tracks the
 *     VIEW (0, 2, 5, 4 for four different labels) and not an offset;
 *   - every captured response was a SHORT page against a requested 2000, so no
 *     two requests differ by a page step and there is nothing to difference.
 *
 * A guessed offset does not fail loudly — it re-fetches page one forever, and
 * `sluice replay --all` drains that against a live account. `[]` is the honest
 * answer until a recording exists that scrolls a label past its first page.
 */
export function gmailNextCursors(): CursorSeed[] {
  return [];
}

// ── Replay ───────────────────────────────────────────────────────────────────────

/** The `bv` request frame's arity, and the constants the client fills it with. */
const BV_FRAME_ARITY = 33;
const BV_MAX_THREADS = 2000;

const GMAIL_REPLAY_ACTIONS: ReplayAction[] = [
  {
    id: 'gmail.threads.list',
    adapterId: ADAPTER_ID,
    label: 'Threads in a label',
    method: 'POST',
    urlTemplate: 'https://mail.google.com/sync/u/{account}/i/bv',
    params: [
      { name: 'account', label: 'Account index', kind: 'string', default: '0' },
      { name: 'label', label: 'Label id', kind: 'containerId', required: true, default: '^i' },
      { name: 'viewType', label: 'View type', kind: 'number', default: '0' },
      { name: 'max', label: 'Max threads', kind: 'number', default: String(BV_MAX_THREADS) },
    ],
  },
];

/**
 * The positional frame a `bv` call is made of, rebuilt from the shape the real
 * client sends. Every index set here was non-null in all four captured requests,
 * and every index left null was null in all four.
 *
 * `viewType` appears twice by design — `[0]` and the `(N)` inside `[5]` were
 * equal in every captured request (4, 9, 10 and 46), so they are tied here rather
 * than offered as two params that can disagree. The mapping FROM a label TO its
 * view type was not recovered, which is why it is a parameter at all; `[3]` is
 * what actually selects the label.
 *
 * `[32]` is a `[clientTimestamp, null, null, N]` tuple in a real request and is
 * left null: its meaning is unknown, and inventing a plausible timestamp is how a
 * replay starts lying about when it was made.
 */
function bvRequestBody(label: string, viewType: number, max: number): string {
  const frame: unknown[] = new Array(BV_FRAME_ARITY).fill(null);
  frame[0] = viewType;
  frame[1] = 51;
  frame[BV_REQUEST_QUERY] = `in:${label}`;
  frame[4] = [null, null, null, null, 0];
  frame[5] = `itemlist-ViewType(${viewType})-0`;
  frame[6] = 1;
  frame[7] = max;
  frame[9] = 0;
  frame[13] = 1;
  frame[18] = 0;
  frame[19] = 1;
  frame[27] = 0;
  frame[28] = 0;
  frame[29] = '';
  return JSON.stringify([frame, null, [0, 5, null, null, 1, 1, 1]]);
}

/**
 * Google's cookie set (`SID`/`HSID`/`SSID`/`APISID`/`SAPISID`) as one header.
 *
 * Each `injection.cookies` entry maps a cookie NAME to the KEY in `values` that
 * holds its secret, falling back to a literal — reading it the other way round
 * emits the string `sidValue` as the cookie value, producing a request that looks
 * correct and is unauthenticated. `values.cookieHeader` behind it is the
 * pre-assembled form a Chrome-cookie provider hands over.
 */
function cookieHeader(session: Session): string | undefined {
  const creds = session.credentials;
  const pairs: string[] = [];
  for (const [name, ref] of Object.entries(creds.injection.cookies ?? {})) {
    const value = creds.values[ref] ?? ref;
    if (value) pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : creds.values.cookieHeader;
}

/** `{account}` in a urlTemplate — Gmail scopes by path segment, not by query. */
const PATH_PARAM = /\{(\w+)\}/g;

/**
 * Build the concrete request: the account index goes in the PATH, everything else
 * goes in the JSON body, and the session's cookies go in the `Cookie` header.
 *
 * No action param is ever appended to the query string. `bv` takes its arguments
 * positionally in the body and answers a query-only call with a frame it cannot
 * read; `hl` and `rt` are the client's own (locale, response encoding) and are
 * pinned rather than exposed.
 *
 * A missing path param THROWS by name rather than substituting `''`. The `''`
 * fallback builds `https://mail.google.com/sync/u//i/bv`, and `onReplayRun` in
 * packages/runner passes the UI's params through with no `required` check — so a
 * one-click replay comes back as an opaque 404 that names nothing.
 */
function buildReplayRequest(
  action: ReplayAction,
  params: Record<string, string>,
  session: Session,
): ReplayRequest {
  const value = (name: string): string | undefined =>
    params[name] ?? action.params.find((p) => p.name === name)?.default;

  // `label` is `kind: 'containerId'`, so the UI hands over whatever a Container
  // row is keyed by — a scoped label id like `gmail:you@example.com/^i`. The bare
  // `^i` has to be recovered from it, because `in:gmail:you@example.com/^i`
  // selects nothing on Gmail's side.
  //
  // The SLOT cannot be recovered from it, and deliberately does not try to be.
  // A resolved workspace id names a mailbox, and a mailbox does not have a
  // `/u/N/` — the browser does, one per sign-in session, reassigned whenever the
  // signed-in set changes. Guessing 0 and calling it the account's slot is how
  // two mailboxes merged in the first place. So: an explicit `account` param
  // wins; a PROVISIONAL label id still yields its slot, because that id is a
  // slot and nothing more; and the last resort is the documented default.
  // Callers that hold a store resolve the current slot from the ledger
  // (`slotLedger`) and pass it — see reconcile.ts.
  const label = value('label') ?? '^i';
  const ref = labelRef(label);
  const labelSlot =
    ref?.workspaceId === undefined ? undefined : accountSlotOfWorkspaceId(ref.workspaceId);
  const account = params.account ?? labelSlot ?? value('account') ?? '0';

  const template = action.urlTemplate.replace(PATH_PARAM, (_match, name: string) => {
    const v = name === 'account' ? account : value(name);
    if (v === undefined || v === '') {
      throw new Error(
        `Gmail replay action "${action.id}" needs a value for "${name}" — it is a path segment, not a query param.`,
      );
    }
    return encodeURIComponent(v);
  });

  const u = new URL(template);
  u.searchParams.set('hl', 'en');
  u.searchParams.set('rt', 'r');

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    Accept: '*/*',
    'User-Agent': CHROME_UA,
    Origin: 'https://mail.google.com',
    Referer: `https://mail.google.com/mail/u/${account}/`,
  };
  for (const [k, v] of Object.entries(session.credentials.injection.headers ?? {})) headers[k] = v;
  const cookie = cookieHeader(session);
  if (cookie) headers.Cookie = cookie;

  return {
    method: action.method,
    url: u.toString(),
    headers,
    body: bvRequestBody(
      ref?.labelId ?? label,
      num(value('viewType')) ?? 0,
      num(value('max')) ?? BV_MAX_THREADS,
    ),
  };
}

// ── The adapter ──────────────────────────────────────────────────────────────────

export const gmailAdapter: Adapter = {
  id: ADAPTER_ID,
  displayName: 'Gmail',
  hosts: ['mail.google.com'],
  matchRequest(input) {
    return matchesGmail(input.host);
  },
  parse(capture, ctx) {
    return parseGmailCapture(capture, ctx);
  },
  classify(capture) {
    return classifyGmailCapture(capture);
  },
  nextCursors() {
    return gmailNextCursors();
  },
  listReplayActions() {
    return GMAIL_REPLAY_ACTIONS;
  },
  buildReplayRequest,
};
