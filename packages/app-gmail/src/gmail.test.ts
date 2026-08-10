// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * app-gmail tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * Two kinds of input, and the split matters.
 *
 * `fixtures/gmail.ndjson` is a SCRUBBED recording of a real mailbox —
 * `scrubCaptures(recording, { salt: 'app-gmail' })` — so array lengths, nesting,
 * types, string lengths and `^label` ids survive and every character of content
 * is synthetic. It is what pins the layout claims, because a hand-written
 * fixture only proves this file agrees with itself.
 *
 * Two consequences of scrubbing that this file leans on. The scrubber replaces
 * any string that does not START with `^`, so the `bv` request's search query —
 * `in:^f`, the one place the answered label is written down — comes back as
 * prose; the fixture therefore exercises the label-not-recovered path, and label
 * RECOVERY is pinned on hand-built synthetic exchanges below (see `bv(...)`).
 * And a message BODY comes back as prose of the same length, with no tags left
 * in it, so the fixture pins WHERE the body is read from and the HTML flattening
 * is pinned on synthetic input (see the `htmlToText` block).
 *
 * The shared invariants (never-throws, host lookalikes, seed ownership, secrets
 * resolved by value) come from `runConformance` at the bottom.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeCapture, parseNdjson, runConformance } from '@sluice/adapter-sdk';
import type { Capture, Container, Item, Session } from '@sluice/core';
import { MAX_BODY_CHARS, htmlToText } from './html-to-text.js';
import {
  accountWorkspaceId,
  addressOfWorkspaceId,
  isProvisionalWorkspaceId,
  classifyGmailCapture,
  containerKind,
  decodeGmailBody,
  gmailAdapter,
  gmailApp,
  gmailMessageView,
  gmailNextCursors,
  gmailThreadView,
  labelRef,
  parseGmailCapture,
} from './index.js';

// ── The scrubbed recording ───────────────────────────────────────────────────────

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/gmail.ndjson', import.meta.url));
const { captures: FIXTURES, skipped } = parseNdjson(readFileSync(FIXTURE_PATH, 'utf8'));

/** The FIRST capture of a given path shape. Fails loudly rather than silently skipping. */
function fixture(match: string): Capture {
  const found = FIXTURES.find((c) => c.path.includes(match));
  assert.ok(found, `precondition: the fixture has a ${match} capture`);
  return found;
}

/** Every capture of a path shape — there are four `fd` exchanges, not one. */
function allFixtures(match: string): Capture[] {
  const found = FIXTURES.filter((c) => c.path.includes(match));
  assert.ok(found.length > 0, `precondition: the fixture has ${match} captures`);
  return found;
}

/** One `fd` capture by id, so a test can name the shape it is actually about. */
function fdFixture(id: string): Capture {
  const found = FIXTURES.find((c) => c.id === id);
  assert.ok(found, `precondition: the fixture has ${id}`);
  return found;
}

/** Every item across the four recorded `fd` exchanges. */
function recordedMessages(): Item[] {
  return allFixtures('/i/fd').flatMap((c) => parseGmailCapture(c).items ?? []);
}

test('the fixture loads cleanly', () => {
  assert.deepEqual(skipped, [], 'a scrubbed fixture with an unreadable line is not a fixture');
  assert.equal(FIXTURES.length, 8, 'four endpoint kinds, and four fd exchanges among them');
});

// ── Synthetic exchanges ──────────────────────────────────────────────────────────

const BV_FRAME_ARITY = 33;
const THREAD_ARITY = 25;
const MESSAGE_ARITY = 84;

/**
 * One `bv` message row, carrying only the fields the parser reads: the sender at
 * `[1]` and the label ids at `[10]`.
 */
function message(labels: string[], from?: [string, string?]): unknown[] {
  const m: unknown[] = new Array(MESSAGE_ARITY).fill(null);
  if (from) m[1] = address(from);
  m[10] = labels;
  return m;
}

/**
 * One thread record: `[subject, snippet, ts, id, messages, …]`, arity 25.
 *
 * `senders` become one message row each, in wire order — oldest first — so a test
 * can pin that the thread's sender is the LAST of them and not the first.
 */
function thread(
  id: string,
  ts: number,
  subject: string,
  snippet: string,
  labels: string[],
  senders: Array<[string, string?]> = [],
): unknown[] {
  const t: unknown[] = new Array(THREAD_ARITY).fill(null);
  t[0] = subject;
  t[1] = snippet;
  t[2] = ts;
  t[3] = id;
  t[4] = senders.length > 0 ? senders.map((s) => message(labels, s)) : [message(labels)];
  return t;
}

/**
 * A synthetic `bv` exchange. `query` is the client's search query — the only
 * place the answered label exists — and rides in the REQUEST, at `body[0][3]`.
 *
 * `account` is the `/u/{n}/` segment: which of the signed-in accounts this call
 * was for. It is a parameter because the whole label vocabulary (`^i`, `^all`,
 * `^smartlabel_*`) repeats verbatim in every account, so the account is the only
 * thing that tells two otherwise identical exchanges apart.
 */
function bv(
  query: string,
  threads: unknown[][],
  labels: unknown[][] = [],
  account = '0',
): Capture {
  const frame: unknown[] = new Array(BV_FRAME_ARITY).fill(null);
  frame[0] = 9;
  frame[3] = query;
  const res: unknown[] = new Array(19).fill(null);
  res[1] = labels.map((l) => [l, 7]);
  res[2] = threads.map((t) => [t, 1]);
  return makeCapture({
    adapterId: 'gmail',
    method: 'POST',
    host: 'mail.google.com',
    path: `/sync/u/${account}/i/bv`,
    url: `https://mail.google.com/sync/u/${account}/i/bv?hl=en&c=9&rt=r&pt=ji`,
    reqBody: JSON.stringify([frame, null, [0, 5, null, null, 1, 1, 1]]),
    resBody: JSON.stringify(res),
  });
}

const FD_RECORD_ARITY = 55;
const FD_SENDER_ARITY = 20;
const FD_SUMMARY_ROW_ARITY = 57;

interface MessageSpec {
  id: string;
  /** `[address, displayName?]` — the sender card, `record[10]`. */
  from?: [string, string?];
  to?: Array<[string, string?]>;
  cc?: Array<[string, string?]>;
  subject?: string;
  /** One string per HTML part; they are concatenated in array order. */
  html?: string[];
  plain?: string;
  snippet?: string;
  ts?: number;
  /** Set to make `record[5][2]` the clipped flag with this follow-up URL. */
  clippedUrl?: string;
  /** Label ids, which ride the thread SUMMARY and never the record. */
  labels?: string[];
  /** `record[11]` — whose mailbox this is. The only place an account is named. */
  accountAddress?: string;
}

/** `[1, EMAIL]` or `[1, EMAIL, DISPLAY_NAME]` — the only address shape `fd` uses. */
function address([addr, name]: [string, string?]): unknown[] {
  return name === undefined ? [1, addr] : [1, addr, name];
}

/** One arity-55 message record, carrying only the fields the parser reads. */
function messageRecord(spec: MessageSpec): unknown[] {
  const r: unknown[] = new Array(FD_RECORD_ARITY).fill(null);
  if (spec.to) r[0] = spec.to.map(address);
  if (spec.cc) r[1] = spec.cc.map(address);
  r[4] = spec.subject ?? '';
  r[5] = [
    null,
    (spec.html ?? []).map((html, i) => [0, null, [null, html], i]),
    spec.clippedUrl === undefined ? 0 : 1,
    spec.clippedUrl ?? null,
    spec.plain === undefined ? null : [null, null, null, null, null, null, spec.plain],
    spec.plain === undefined ? null : 'part-id',
    0,
    0,
    null,
  ];
  r[6] = spec.snippet ?? '';
  if (spec.from) {
    const card: unknown[] = new Array(FD_SENDER_ARITY).fill(null);
    card[14] = spec.from[1] ?? null;
    card[16] = spec.from[0];
    r[10] = card;
  }
  if (spec.accountAddress !== undefined) r[11] = address([spec.accountAddress]);
  r[16] = spec.ts ?? 1_700_000_000_000;
  return r;
}

/**
 * A synthetic `fd` exchange: `[0, threads[], null, null, [int]]`.
 *
 * The thread summary — the only carrier of label ids — is emitted only when a
 * message asks for labels, which is the wire's own behaviour: 79 of the 94
 * recorded thread wrappers have `null` there.
 */
function fd(
  threads: Array<{ id: string; messages: MessageSpec[] }>,
  account = '0',
): Capture {
  const wrappers = threads.map((t) => {
    const labelled = t.messages.some((m) => m.labels !== undefined);
    const summaries = t.messages.map((m) => {
      const row: unknown[] = new Array(FD_SUMMARY_ROW_ARITY).fill(null);
      row[0] = m.id;
      row[3] = m.labels ?? null;
      return row;
    });
    return [
      t.id,
      labelled ? [null, summaries] : null,
      t.messages.map((m) => [m.id, messageRecord(m)]),
    ];
  });
  return makeCapture({
    adapterId: 'gmail',
    method: 'POST',
    host: 'mail.google.com',
    path: `/sync/u/${account}/i/fd`,
    url: `https://mail.google.com/sync/u/${account}/i/fd?hl=en&c=9&rt=r&pt=ji`,
    reqBody: JSON.stringify([threads.map((t) => [t.id, null, t.messages.map((m) => m.id)]), 2]),
    resBody: JSON.stringify([0, wrappers, null, null, [1]]),
  });
}

const SESSION: Session = {
  id: 's1',
  adapterId: 'gmail',
  label: 'Gmail (u0)',
  credentials: {
    kind: 'google-cookies',
    // The key names are deliberately NOT the cookie names: an implementation that
    // reads `injection.cookies` literally would emit "sidValue" as the cookie
    // value, which is exactly what the conformance secret check looks for.
    values: {
      sidValue: 'g.a000REAL_SID_VALUE',
      hsidValue: 'REAL_HSID_VALUE',
      ssidValue: 'REAL_SSID_VALUE',
    },
    injection: {
      cookies: { SID: 'sidValue', HSID: 'hsidValue', SSID: 'ssidValue' },
      headers: { 'x-framework-xsrf-token': 'synthetic-xsrf:1700000000000' },
    },
  },
  discoveredAt: 0,
  source: 'local-store',
};

// ── matchRequest ─────────────────────────────────────────────────────────────────

test('matchRequest claims mail.google.com and nothing that merely looks like it', () => {
  const hit = (host: string) =>
    gmailAdapter.matchRequest({ host, path: '/sync/u/0/i/bv', method: 'POST', url: '' });
  assert.ok(hit('mail.google.com'));
  for (const impostor of [
    'mail.google.com.evil.test',
    'mail.google.comevil.com',
    'mail-google-com.evil.test',
    'evil.test',
  ]) {
    assert.equal(hit(impostor), false, `must not claim ${impostor}`);
  }
});

test('googleusercontent.com is not claimed', () => {
  // It serves Gmail's inline images (ci3.googleusercontent.com/meips/…) and is
  // still not ours: it is a shared origin for every Google product, `hosts` seeds
  // the proxy's TLS-intercept scope, and it carries no structure to parse.
  assert.ok(!gmailAdapter.hosts.some((h) => h.includes('googleusercontent')));
  assert.equal(
    gmailAdapter.matchRequest({
      host: 'ci3.googleusercontent.com',
      path: '/meips/abc',
      method: 'GET',
      url: '',
    }),
    false,
  );
});

// ── classify ─────────────────────────────────────────────────────────────────────

test('classify names each of the recorded exchange kinds', () => {
  const expected: Array<[match: string, cls: string, operation: string]> = [
    ['/sync/u/0/i/bv', 'structure', 'sync.bv'],
    ['/sync/u/0/i/fd', 'messages', 'sync.fd'],
    ['/sync/u/0/i/s', 'structure', 'sync.s'],
    ['/_/scs/', 'asset', 'asset'],
    ['/mail/u/0/checkbuild', 'unknown', 'mail.xhr'],
  ];
  for (const [match, cls, operation] of expected) {
    const got = classifyGmailCapture(fixture(match));
    assert.equal(got.class, cls, match);
    assert.equal(got.operation, operation, match);
  }
});

test('the account index does not fragment an operation name', () => {
  // `u/0` and `u/3` are the same call against two signed-in accounts. A traffic
  // table that splits them into two operations is unreadable on a multi-account
  // mailbox, and `op:sync.bv` would match only one of them.
  for (const account of ['0', '3', '17']) {
    const got = classifyGmailCapture(makeCapture({ path: `/sync/u/${account}/i/bv` }));
    assert.equal(got.operation, 'sync.bv');
  }
});

test('classify names a /sync/ endpoint it has never seen', () => {
  const got = classifyGmailCapture(makeCapture({ path: '/sync/u/0/i/xyz' }));
  assert.equal(got.class, 'unknown');
  assert.equal(got.operation, 'sync.xyz', 'an unhandled endpoint is still worth naming');
});

test('classify reports a failure as an error but keeps the operation', () => {
  const got = classifyGmailCapture({ ...fixture('/sync/u/0/i/bv'), status: 401 });
  assert.equal(got.class, 'error');
  assert.equal(got.operation, 'sync.bv', "'error' alone cannot say WHICH call failed");
});

// ── the `)]}'` envelope ──────────────────────────────────────────────────────────

test("decodeGmailBody strips Google's )]}' preamble", () => {
  const checkbuild = fixture('checkbuild');
  assert.ok(checkbuild.resBody?.startsWith(")]}'"), 'precondition: the recording has the preamble');
  assert.deepEqual(decodeGmailBody(checkbuild.resBody), [0, 0]);
  // The /sync/ responses are bare arrays; the strip has to be a no-op on them.
  assert.ok(Array.isArray(decodeGmailBody(fixture('/sync/u/0/i/bv').resBody)));
  // And a preamble over something that is not JSON underneath yields nothing
  // rather than throwing — the legacy channel answers that way.
  assert.equal(decodeGmailBody(")]}'\n\n463\n[["), undefined);
});

// ── parse: labels → containers ───────────────────────────────────────────────────

/** The recorded page's containers, keyed by the BARE label id they carry. */
function recordedLabels(): Map<string, Container> {
  const containers = parseGmailCapture(fixture('/sync/u/0/i/bv')).containers ?? [];
  return new Map(containers.map((c) => [labelRef(c.id)?.labelId ?? c.id, c]));
}

test('bv labels become containers under the account workspace', () => {
  const r = parseGmailCapture(fixture('/sync/u/0/i/bv'));
  assert.deepEqual(r.workspaces, [{ id: 'gmail:u0', adapterId: 'gmail', name: 'Gmail (u0 — mailbox not identified)' }]);
  const byId = recordedLabels();
  assert.equal(byId.size, 25, '24 labels in the recording, plus the not-recovered placeholder');
  for (const [id, name] of [
    ['^all', 'All Mail'],
    ['^i', 'Inbox'],
    ['^f', 'Sent'],
    ['^r', 'Drafts'],
    ['^t', 'Starred'],
    ['^s', 'Spam'],
    ['^k', 'Trash'],
    ['^io_im', 'Important'],
    ['^smartlabel_promo', 'Promotions'],
  ] as const) {
    assert.equal(byId.get(id)?.name, name, id);
    assert.equal(byId.get(id)?.id, `gmail:u0/${id}`, 'the id is scoped to the account');
    assert.equal(byId.get(id)?.workspaceId, 'gmail:u0');
    assert.equal(byId.get(id)?.kind, 'other');
  }
});

test('a system label with no friendly name keeps its raw id', () => {
  // A confidently-wrong name is worse than an internal-looking id: `^b` and
  // `^wc_tb_ready` are in the recording and neither has a documented meaning.
  const byId = recordedLabels();
  assert.equal(byId.get('^b')?.name, '^b');
  assert.equal(byId.get('^wc_tb_ready')?.name, '^wc_tb_ready');
});

test('a user label uses its display name, not its id', () => {
  // `record[1]` is the display name for `^x_N` and a repeat of the id for a
  // system label — the only thing that tells the two kinds apart.
  const userLabel = recordedLabels().get('^x_1');
  assert.ok(userLabel);
  assert.equal(userLabel.name, 'Vzc q', 'the scrubbed stand-in for the real label name');
  assert.notEqual(userLabel.name, userLabel.id);
});

test('no container carries a fabricated memberCount', () => {
  // The number beside each label row reads like a count and is not one: `^all`
  // reported 374 for a mailbox of 14,055 threads, and `^x_2` reported 1,859,506.
  const r = parseGmailCapture(fixture('/sync/u/0/i/bv'));
  for (const c of r.containers ?? []) {
    assert.equal(c.memberCount, undefined, `${c.id} must not claim a member count`);
  }
  // …and the raw row is still there, so nothing was thrown away in the process.
  const raw = recordedLabels().get('^all')?.raw;
  assert.ok(Array.isArray(raw) && raw[0] === '^all');
});

// ── parse: threads → items ───────────────────────────────────────────────────────

test('bv threads become items with the thread id and its epoch-ms timestamp', () => {
  const r = parseGmailCapture(fixture('/sync/u/0/i/bv'));
  assert.equal(r.items?.length, 34);
  const first = r.items?.[0];
  assert.equal(first?.id, 'thread-f:2942556809216331240');
  assert.equal(first?.ts, 1755397200866, 'index 2 is epoch MILLISECONDS, not seconds');
  assert.equal(first?.kind, 'message');
  assert.equal(first?.workspaceId, 'gmail:u0');
  assert.deepEqual(first?.sourceCaptureIds, [fixture('/sync/u/0/i/bv').id]);
});

test('a thread item leads with its subject, then its snippet', () => {
  // Index 1 is hard-capped at 201 characters and index 0 is not — a snippet is a
  // truncated preview, a subject is not. See THREAD in gmail-adapter.ts.
  //
  // Both go in `text`, subject first, the same shape a MESSAGE item takes. The
  // snippet alone is what Gmail renders as the preview line and not what it
  // renders as the title, so a generic reader listing items by their text showed
  // every conversation by its first few words of body — and the subjects of a
  // mailbox whose bodies were never captured reached the search index nowhere.
  const item = parseGmailCapture(fixture('/sync/u/0/i/bv')).items?.[0];
  const raw = item?.raw;
  assert.ok(Array.isArray(raw));
  assert.equal(item?.text, `${String(raw[0])}\n\n${String(raw[1])}`);
  assert.ok(String(raw[1]).length <= 201);
  // The first line is the subject, which is what every list renders.
  assert.equal(item?.text.split('\n')[0], String(raw[0]));
});

test('a thread item with only one of the two carries that one alone', () => {
  // No stray blank lines to make a subject-less row look like it has an empty
  // title, and no leading separator on a snippet-less one.
  const subjectOnly = parseGmailCapture(bv('in:^i', [thread('thread-f:1', 5, 'Subject', '', [])]));
  assert.equal(subjectOnly.items?.[0]?.text, 'Subject');
  const snippetOnly = parseGmailCapture(bv('in:^i', [thread('thread-f:2', 5, '', 'Preview', [])]));
  assert.equal(snippetOnly.items?.[0]?.text, 'Preview');
});

test('a thread id is taken as an opaque string, not assumed to be thread-f:', () => {
  // The recording holds `thread-a:r<digits>` and `thread-a:r-<digits>` alongside
  // `thread-f:<digits>`; a parser that validated the prefix would drop 13 of 86.
  const r = parseGmailCapture(bv('in:^i', [thread('thread-a:r-99', 5, 'S', 'p', [])]));
  assert.equal(r.items?.[0]?.id, 'thread-a:r-99');
});

// ── parse: the container comes from the REQUEST ──────────────────────────────────

test('the container is recovered from the request query, not the response', () => {
  // The bv RESPONSE never says which view it answered. A query mixes inclusions
  // with exclusions, and the first NON-negated `in:^…` is the view itself.
  const cases: Array<[query: string, label: string]> = [
    ['in:^t', '^t'],
    ['in:^t_z -in:^i ((in:^t_recx) OR (-in:^t_rec))', '^t_z'],
    ['((in:^f) OR (in:^pfg) OR (in:^f_clns))', '^f'],
    ['in:^r -in:^f_clns -in:^cr', '^r'],
  ];
  for (const [query, label] of cases) {
    const r = parseGmailCapture(bv(query, [thread('thread-f:1', 5, 'S', 'p', [])]));
    assert.equal(r.items?.[0]?.containerId, `gmail:u0/${label}`, query);
  }
});

test('an excluded label is never mistaken for the view', () => {
  const r = parseGmailCapture(bv('-in:^i in:^s', [thread('thread-f:1', 5, 'S', 'p', [])]));
  assert.equal(r.items?.[0]?.containerId, 'gmail:u0/^s');
});

test('a thread whose view cannot be recovered is kept, not dropped', () => {
  // What the scrubbed recording produces: its query is synthetic prose with no
  // `in:^…` in it. Dropping 34 threads because the request was unreadable would
  // lose evidence the capture plainly contains.
  const r = parseGmailCapture(fixture('/sync/u/0/i/bv'));
  assert.equal(r.items?.length, 34);
  for (const item of r.items ?? []) assert.equal(item.containerId, 'gmail:u0/unknown');
  const placeholder = r.containers?.find((c) => c.id === 'gmail:u0/unknown');
  assert.ok(placeholder, 'the fallback container exists so the items are not orphaned');
  assert.equal(placeholder.name, 'Gmail (label not recovered)');
  assert.equal(containerKind(placeholder.id), 'unrecovered', 'it is not a label and not a thread');
});

test('the placeholder container is not invented when there is nothing to hold', () => {
  const r = parseGmailCapture(bv('no labels here', []));
  assert.equal(r.containers?.some((c) => c.id === 'gmail:u0/unknown'), undefined);
});

// ── parse: edges ─────────────────────────────────────────────────────────────────

test('a thread emits one in-label edge per label id on its messages', () => {
  const r = parseGmailCapture(
    bv('in:^i', [
      thread('thread-f:1', 5, 'S', 'p', ['^all', '^i', '^smartlabel_promo']),
      thread('thread-f:2', 6, 'S', 'p', ['^all']),
    ]),
  );
  assert.deepEqual(r.edges, [
    { srcKind: 'item', srcId: 'thread-f:1', rel: 'in-label', dstKind: 'container', dstId: 'gmail:u0/^all', adapterId: 'gmail', workspaceId: 'gmail:u0' },
    { srcKind: 'item', srcId: 'thread-f:1', rel: 'in-label', dstKind: 'container', dstId: 'gmail:u0/^i', adapterId: 'gmail', workspaceId: 'gmail:u0' },
    { srcKind: 'item', srcId: 'thread-f:1', rel: 'in-label', dstKind: 'container', dstId: 'gmail:u0/^smartlabel_promo', adapterId: 'gmail', workspaceId: 'gmail:u0' },
    { srcKind: 'item', srcId: 'thread-f:2', rel: 'in-label', dstKind: 'container', dstId: 'gmail:u0/^all', adapterId: 'gmail', workspaceId: 'gmail:u0' },
  ]);
});

test("a thread's labels are the union across its messages, de-duplicated", () => {
  // Labels are recorded per MESSAGE (message[10]), never on the thread record, so
  // a two-message thread that shares `^all` must not emit it twice — the edges
  // table's primary key would collapse the pair anyway, silently.
  const t = thread('thread-f:1', 5, 'S', 'p', ['^all', '^i']);
  t[4] = [message(['^all', '^i']), message(['^all', '^x_1'])];
  const r = parseGmailCapture(bv('in:^i', [t]));
  assert.deepEqual(r.edges?.map((e) => e.dstId), [
    'gmail:u0/^all',
    'gmail:u0/^i',
    'gmail:u0/^x_1',
  ]);
});

test('the recorded page emits edges for every thread that has labels', () => {
  const r = parseGmailCapture(fixture('/sync/u/0/i/bv'));
  assert.ok((r.edges?.length ?? 0) > 0);
  const sources = new Set(r.edges?.map((e) => e.srcId));
  assert.equal(sources.size, 34, 'all 34 threads in the page are labelled');
  for (const e of r.edges ?? []) {
    assert.equal(e.rel, 'in-label');
    assert.equal(e.srcKind, 'item');
    assert.equal(e.dstKind, 'container');
    assert.equal(
      labelRef(e.dstId)?.workspaceId,
      'gmail:u0',
      'an edge points at THIS account\'s label container, never at prose or a shared id',
    );
  }
});

// ── parse: fd → messages ─────────────────────────────────────────────────────────

/**
 * The mailbox the recording belongs to, as the scrubber renamed it.
 *
 * A literal rather than something read back out of the parser, because a
 * derived expectation would agree with whatever the parser did and prove
 * nothing. The test below is the one that pins it to the recording.
 */
const RECORDED_MAILBOX = 'user5857x@example.test';
const RECORDED_MAILBOX_WS = `gmail:${RECORDED_MAILBOX}`;

test('an fd response is filed under the mailbox it names, not the slot it came from', () => {
  // The bug this replaced: `/u/0/` was the workspace key, so browsing a second
  // account — which Gmail serves from the SAME slot after a switch — filed two
  // people's mail under one workspace, named after whichever parsed first.
  const r = parseGmailCapture(fdFixture('cap_unWtwNnKD_7b0Bwc'));
  assert.deepEqual(r.workspaces, [
    { id: RECORDED_MAILBOX_WS, adapterId: 'gmail', name: RECORDED_MAILBOX, domain: RECORDED_MAILBOX },
  ]);
  assert.equal(accountWorkspaceId(RECORDED_MAILBOX), RECORDED_MAILBOX_WS);
  assert.equal(addressOfWorkspaceId(RECORDED_MAILBOX_WS), RECORDED_MAILBOX);
  assert.equal(isProvisionalWorkspaceId(RECORDED_MAILBOX_WS), false);
});

test('the same mailbox reached through two different slots is one workspace', () => {
  // The converse of the bug, and the reason the address is the key rather than a
  // label on top of one: adding an account shifts an existing mailbox from
  // `/u/0/` to `/u/1/`, and a slot-keyed store would call that a new mailbox and
  // duplicate every thread in it.
  const one = parseGmailCapture(
    fd([{ id: 'thread-f:1', messages: [{ id: 'msg-f:1', accountAddress: 'same@example.test' }] }], '0'),
  );
  const other = parseGmailCapture(
    fd([{ id: 'thread-f:2', messages: [{ id: 'msg-f:2', accountAddress: 'same@example.test' }] }], '1'),
  );
  assert.deepEqual(one.workspaces, other.workspaces);
  assert.equal(one.items?.[0]?.workspaceId, 'gmail:same@example.test');
  assert.equal(other.items?.[0]?.workspaceId, 'gmail:same@example.test');
});

test('a caller that already resolved the mailbox overrides what the response says', () => {
  // How reconcile.ts moves a `bv` off its placeholder: the same parse, told the
  // answer the response could not carry. The workspace it emits has to be the
  // resolved one COMPLETE — name and domain included — or the re-parse would
  // rename a real mailbox back to a placeholder on its way past.
  const r = parseGmailCapture(bv('in:^i', [], SHARED_LABELS, '0'), {
    workspaceId: 'gmail:resolved@example.test',
  });
  assert.deepEqual(r.workspaces, [
    {
      id: 'gmail:resolved@example.test',
      adapterId: 'gmail',
      name: 'resolved@example.test',
      domain: 'resolved@example.test',
    },
  ]);
  assert.equal(r.containers?.[0]?.workspaceId, 'gmail:resolved@example.test');
  assert.ok(r.containers?.every((c) => c.id.startsWith('gmail:resolved@example.test/')));
});

test('every recorded fd message becomes an item under its own thread', () => {
  const messages = recordedMessages();
  assert.equal(messages.length, 17, 'the four recorded fd exchanges hold 17 messages');
  for (const item of messages) {
    assert.equal(item.kind, 'message');
    assert.equal(item.workspaceId, RECORDED_MAILBOX_WS);
    assert.equal(item.containerId, item.threadId, 'a message lives in its thread');
    assert.ok(item.threadId?.length, 'threading is what makes a conversation queryable');
    assert.ok(item.ts > 0, 'index 16 is the message date in epoch ms');
    assert.ok(Array.isArray(item.raw) && item.raw.length === 55, 'raw is the whole record');
  }
});

test('a thread becomes the container its messages live in, named by its subject', () => {
  const r = parseGmailCapture(fdFixture('cap_unWtwNnKD_7b0Bwc'));
  const byId = new Map(r.containers?.map((c) => [c.id, c]));
  assert.equal(byId.size, 4, 'four threads in the exchange, four containers');
  for (const c of r.containers ?? []) {
    // `thread`, not `other`: one exists per conversation, and a reader that
    // cannot tell them from the label views has no structure left to navigate.
    assert.equal(c.kind, 'thread');
    assert.equal(c.workspaceId, RECORDED_MAILBOX_WS);
  }
  // Messages arrive oldest-first, so a thread is named by the subject it started
  // with — the seven-message thread here is named by the first of the seven and
  // not by the last.
  assert.equal(
    byId.get('thread-f:3638008845505828947')?.name,
    'Hruzwvng gwatv adw xennd acpamd rd',
  );
  // …and one message in the recording has an EMPTY subject, which is why the
  // rule is "first non-empty" and why there is a fallback at all.
  assert.equal(
    byId.get('thread-f:3683462193688953455')?.name,
    'thread-f:3683462193688953455',
    'a thread with nothing but empty subjects keeps its id rather than an empty name',
  );
});

test('a thread container carries no raw copy of its own messages', () => {
  // The only record a thread has is the wrapper, and the wrapper contains every
  // message — `raw` here would be a second copy of every body in the exchange.
  for (const c of parseGmailCapture(fdFixture('cap_unWtwNnKD_7b0Bwc')).containers ?? []) {
    assert.equal(c.raw, undefined, c.id);
  }
});

test('From, To and Cc become actors keyed by the account and the lowercased address', () => {
  // The id is SCOPED, like a label container's and for the same reason:
  // `actors.id` is a primary key, and two signed-in accounts corresponding with
  // the same person is the ordinary case. Unscoped, they shared one row whose
  // workspace flipped to whichever mailbox parsed last.
  const r = parseGmailCapture(fdFixture('cap_pMTm_k0XSBBvhc28'));
  const w = RECORDED_MAILBOX_WS;
  assert.deepEqual(
    r.actors?.map((a) => [a.id, a.handle, a.displayName]),
    [
      // From — the address is record[10][16] and the name record[10][14].
      [`${w}/user4130xxx@example.test`, 'user4130xxx@example.test', 'Xbsnr a'],
      // To — record[0].
      [`${w}/user3293xxxxxxxx@example.test`, 'user3293xxxxxxxx@example.test', 'Okpl ecn jlvbw ctqa ssqlbjb'],
      // Cc — record[1], two addresses on this message.
      [`${w}/user5857x@example.test`, 'user5857x@example.test', 'Hqwnk ehxlmvw'],
      [`${w}/user8768xxxx@example.test`, 'user8768xxxx@example.test', 'Rhngfb'],
    ],
  );
  for (const a of r.actors ?? []) assert.equal(a.workspaceId, RECORDED_MAILBOX_WS);
});

test('one person is one actor however many messages they are on', () => {
  // The account itself is From on 7 of these 12 messages and To or Cc on most of
  // the rest. An actor per sighting would put the mailbox owner in the store a
  // dozen times.
  const r = parseGmailCapture(fdFixture('cap_unWtwNnKD_7b0Bwc'));
  assert.equal(r.items?.length, 12);
  assert.equal(r.actors?.length, 9);
  assert.equal(new Set(r.actors?.map((a) => a.id)).size, 9);
  // …and the name is picked up from whichever sighting carried one: this address
  // is nameless everywhere it is From and named where it is a recipient.
  const account = r.actors?.find((a) => a.id === `${RECORDED_MAILBOX_WS}/user5857x@example.test`);
  assert.equal(account?.displayName, 'Hqwnk ehxlmvw');
});

test('Reply-To is not an actor', () => {
  // record[3] is where a reply would GO. It is absent on every sent message,
  // never the account, and 37 of its 74 recorded values are `reply…`/`no-reply…`
  // addresses that neither sent nor received anything.
  const capture = fdFixture('cap_MaWFh80XGBkInHjV');
  const replyTo = (
    (JSON.parse(capture.resBody ?? '') as unknown[])[1] as [unknown, unknown, unknown[][]][]
  )[0]?.[2]?.[0]?.[1] as unknown[];
  const address = ((replyTo[3] as unknown[])[0] as unknown[])[1];
  assert.equal(typeof address, 'string', 'precondition: this recorded message has a Reply-To');
  const actors = parseGmailCapture(capture).actors ?? [];
  assert.equal(actors.length, 2, 'From and the one To address, and nothing else');
  assert.ok(!actors.some((a) => a.id === String(address).toLowerCase()));
});

test('the subject is prefixed onto the item text', () => {
  // `Item` has no subject field and is not getting a Gmail-shaped one. `text` is
  // what items_fts indexes and what every reader renders, so that is where a
  // subject has to be for a generic consumer to find it at all.
  const item = parseGmailCapture(fdFixture('cap_pMTm_k0XSBBvhc28')).items?.[0];
  assert.ok(item);
  const subject = (item.raw as unknown[])[4];
  assert.equal(typeof subject, 'string');
  assert.ok(item.text.startsWith(`${String(subject)}\n\n`), 'subject, blank line, then the body');
  assert.ok(item.text.length > String(subject).length + 2, 'and the body is actually there');
});

test('an empty subject leaves the body alone rather than a leading blank line', () => {
  const item = recordedMessages().find((i) => i.id === 'msg-f:2695723465941038141');
  assert.ok(item, 'precondition: the recording has a message with no subject');
  assert.equal((item.raw as unknown[])[4], '');
  assert.equal(item.text, 'Nwzaq dosgbu bmyc qzb ncxwm qznq x');
});

test('the plain-text alternative is preferred over the HTML', () => {
  // record[5][4][6] carries no tags and no MIME header lines in 51/51, so it is a
  // genuine text alternative; the HTML is for display and indexes worse.
  const item = recordedMessages().find((i) => i.id === 'msg-f:1067381307707530930');
  assert.ok(item);
  const block = (item.raw as unknown[])[5] as unknown[];
  const plain = ((block[4] as unknown[])[6] as string).trim();
  const html = (block[1] as unknown[][]).map((p) => (p[2] as unknown[])[1] as string).join('');
  assert.ok(html.length > plain.length, 'precondition: this message has both, and more HTML');
  assert.ok(item.text.endsWith(plain), 'the text ends with the plain part, verbatim');
});

test('a Gmail-clipped body says so instead of passing for the whole message', () => {
  // record[5][2] === 1 on 9 of 114 messages, and those 9 still carry parts — the
  // URL is an escape hatch for the tail. A reader handed two thirds of a message
  // with no sign of it answers confidently from the part it got.
  const item = parseGmailCapture(fdFixture('cap_MaWFh80XGBkInHjV')).items?.[0];
  assert.ok(item);
  assert.equal(((item.raw as unknown[])[5] as unknown[])[2], 1, 'precondition: clipped');
  assert.match(item.text, /\n\n\[message clipped by Gmail; full text at https:\/\/\S+\]$/);
});

test('a body that is only a snippet is still a body', () => {
  const r = parseGmailCapture(
    fd([{ id: 'thread-f:1', messages: [{ id: 'msg-f:1', snippet: 'only a preview' }] }]),
  );
  assert.equal(r.items?.[0]?.text, 'only a preview');
});

// ── Reading a stored record back ─────────────────────────────────────────────────

test('gmailMessageView splits back out what item text flattened together', () => {
  // `text` is `subject\n\nbody`, and splitting it on the first blank line guesses
  // wrong on every message whose body opens with one. The record is lossless, so
  // the view reads it rather than unpicking the string.
  const item = parseGmailCapture(
    fd([
      {
        id: 'thread-f:1',
        messages: [
          {
            id: 'msg-f:1',
            subject: 'Quarterly numbers',
            from: ['Sender@Example.test', 'A Sender'],
            to: [['to@example.test', 'Tee Oh']],
            cc: [['cc@example.test']],
            plain: '\n\nleading blank lines, then the body',
            ts: 1_700_000_111_000,
          },
        ],
      },
    ]),
  ).items?.[0];
  assert.ok(item);
  const view = gmailMessageView(item.raw);
  assert.equal(view.subject, 'Quarterly numbers');
  assert.equal(view.body, 'leading blank lines, then the body');
  assert.deepEqual(view.from, { address: 'Sender@Example.test', name: 'A Sender' });
  assert.deepEqual(view.to, [{ address: 'to@example.test', name: 'Tee Oh' }]);
  assert.deepEqual(view.cc, [{ address: 'cc@example.test' }]);
  assert.equal(view.date, 1_700_000_111_000);
});

test('gmailMessageView answers a malformed record instead of throwing', () => {
  // `raw` comes off a JSON column a truncated write can leave malformed, and an
  // MCP tool that throws on one bad row answers nothing for the whole page.
  for (const raw of [undefined, null, 'not an array', 42, {}]) {
    assert.deepEqual(gmailMessageView(raw), { subject: '', body: '', to: [], cc: [] });
  }
});

test('a thread is from its NEWEST message, not its first', () => {
  // `bv` message rows are oldest-first — [17], which equals fd's date field in
  // 23/23 joined messages, ascends in all 29 multi-message threads recorded.
  const item = parseGmailCapture(
    bv('in:^i', [
      thread('thread-f:1', 5, 'Re: the thing', 'the latest reply', ['^i'], [
        ['first@example.test', 'First Writer'],
        ['latest@example.test', 'Latest Writer'],
      ]),
    ]),
  ).items?.[0];
  assert.ok(item);
  const view = gmailThreadView(item.raw);
  assert.equal(view.subject, 'Re: the thing');
  assert.equal(view.messageCount, 2);
  assert.deepEqual(view.from, { address: 'latest@example.test', name: 'Latest Writer' });
});

test('every recorded bv message row carries an address-shaped sender at [1]', () => {
  // The claim the constant rests on, checked against the recording rather than
  // against this file's own synthetic rows.
  const threads = (decodeGmailBody(fixture('/i/bv').resBody) as unknown[])[2] as unknown[][];
  const rows = threads.flatMap((t) => ((t[0] as unknown[])[4] ?? []) as unknown[][]);
  assert.equal(rows.length, 42, 'precondition: the recorded page has this many message rows');
  for (const row of rows) {
    const card = row[1] as unknown[];
    assert.ok(Array.isArray(card), 'every row has a sender card');
    assert.equal(typeof card[1], 'string');
    assert.ok(String(card[1]).includes('@'), 'and slot 1 of it is an address');
  }
});

// ── parse: fd → edges ────────────────────────────────────────────────────────────

test('a message emits authored, sent-to and in-label edges', () => {
  const r = parseGmailCapture(
    fd([
      {
        id: 'thread-f:1',
        messages: [
          {
            id: 'msg-f:1',
            from: ['Sender@Example.test', 'A Sender'],
            to: [['to@example.test']],
            cc: [['cc@example.test', 'Cee Cee']],
            labels: ['^all', '^i'],
          },
        ],
      },
    ]),
  );
  const e = (over: Record<string, unknown>) => ({
    adapterId: 'gmail',
    workspaceId: 'gmail:u0',
    ...over,
  });
  assert.deepEqual(r.edges, [
    e({ srcKind: 'actor', srcId: 'gmail:u0/sender@example.test', rel: 'authored', dstKind: 'item', dstId: 'msg-f:1' }),
    e({ srcKind: 'item', srcId: 'msg-f:1', rel: 'sent-to', dstKind: 'actor', dstId: 'gmail:u0/to@example.test' }),
    e({ srcKind: 'item', srcId: 'msg-f:1', rel: 'sent-to', dstKind: 'actor', dstId: 'gmail:u0/cc@example.test' }),
    e({ srcKind: 'item', srcId: 'msg-f:1', rel: 'in-label', dstKind: 'container', dstId: 'gmail:u0/^all' }),
    e({ srcKind: 'item', srcId: 'msg-f:1', rel: 'in-label', dstKind: 'container', dstId: 'gmail:u0/^i' }),
  ]);
  // The author edge and the item's authorId name the same actor, in the same
  // normalized form — `Sender@Example.test` is one person, not two.
  assert.equal(r.items?.[0]?.authorId, 'gmail:u0/sender@example.test');
  assert.equal(r.actors?.[0]?.handle, 'Sender@Example.test', 'the handle keeps the spelling seen');
});

test('labels ride the thread summary, never the message record', () => {
  // There is not one `^`-prefixed string anywhere in any of the 114 full message
  // records. A parser that read labels off the record would emit nothing,
  // silently, on every message — which is exactly what the first pass did.
  const withLabels = parseGmailCapture(
    fd([{ id: 'thread-f:1', messages: [{ id: 'msg-f:1', labels: ['^i'] }] }]),
  );
  assert.deepEqual(
    withLabels.edges?.map((x) => x.dstId),
    ['gmail:u0/^i'],
  );

  const onTheRecord = fd([{ id: 'thread-f:1', messages: [{ id: 'msg-f:1' }] }]);
  const body = JSON.parse(onTheRecord.resBody ?? '') as unknown[];
  const record = (((body[1] as unknown[][])[0] as unknown[])[2] as unknown[][])[0] as unknown[];
  (record[1] as unknown[])[10] = ['^i', '^all'];
  onTheRecord.resBody = JSON.stringify(body);
  assert.equal(parseGmailCapture(onTheRecord).edges, undefined);
});

test('the recorded exchanges emit an edge for every sighting of a person', () => {
  const r = parseGmailCapture(fdFixture('cap_unWtwNnKD_7b0Bwc'));
  const rels = new Map<string, number>();
  for (const edge of r.edges ?? []) rels.set(edge.rel, (rels.get(edge.rel) ?? 0) + 1);
  assert.equal(rels.get('authored'), 12, 'one author per message');
  assert.equal(rels.get('sent-to'), 22, 'To and Cc across the twelve');
  assert.ok((rels.get('in-label') ?? 0) > 0, 'all four threads here carry summaries');
  for (const edge of r.edges ?? []) {
    assert.equal(edge.adapterId, 'gmail');
    if (edge.rel === 'in-label') assert.equal(labelRef(edge.dstId)?.workspaceId, RECORDED_MAILBOX_WS);
  }
});

// ── parse: two signed-in accounts ────────────────────────────────────────────────

/**
 * The same page of labels, as every signed-in account reports it — the whole
 * vocabulary repeats verbatim in every account, which is the collision.
 */
const SHARED_LABELS = [
  ['^i', '^i'],
  ['^all', '^all'],
  ['^x_1', 'Receipts'],
];

test('each account gets its own container for a label, instead of one overwriting the other', () => {
  // The defect this whole scoping exists for. `containers.id` is a PRIMARY KEY
  // and `^i` is EVERY account's inbox, so the second account's Inbox used to
  // overwrite the first's row and take its workspace_id with it — after which
  // both mailboxes' threads hung off one container and nothing reported a thing.
  const u0 = parseGmailCapture(bv('in:^i', [], SHARED_LABELS, '0'));
  const u1 = parseGmailCapture(bv('in:^i', [], SHARED_LABELS, '1'));
  assert.deepEqual(u0.containers?.map((c) => c.id), [
    'gmail:u0/^i',
    'gmail:u0/^all',
    'gmail:u0/^x_1',
  ]);
  assert.deepEqual(u1.containers?.map((c) => c.id), [
    'gmail:u1/^i',
    'gmail:u1/^all',
    'gmail:u1/^x_1',
  ]);
  const ids = new Set([...(u0.containers ?? []), ...(u1.containers ?? [])].map((c) => c.id));
  assert.equal(ids.size, 6, 'six rows, not three rows written twice');
  // The label a reader sees is still Gmail's own, and the account is on the row.
  assert.equal(u1.containers?.[0]?.name, 'Inbox');
  assert.equal(u1.containers?.[0]?.workspaceId, 'gmail:u1');
});

test("a thread is filed under its own account's view of the label", () => {
  const u1 = parseGmailCapture(
    bv('in:^i', [thread('thread-f:9', 5, 'S', 'p', ['^i', '^all'])], SHARED_LABELS, '1'),
  );
  assert.equal(u1.items?.[0]?.containerId, 'gmail:u1/^i');
  assert.equal(u1.items?.[0]?.workspaceId, 'gmail:u1');
  assert.deepEqual(u1.edges?.map((e) => e.dstId), ['gmail:u1/^i', 'gmail:u1/^all']);
});

test('a fetched message points its in-label edges at its own account too', () => {
  const u1 = parseGmailCapture(
    fd([{ id: 'thread-f:9', messages: [{ id: 'msg-f:9', labels: ['^i'] }] }], '1'),
  );
  assert.deepEqual(
    u1.edges?.filter((e) => e.rel === 'in-label').map((e) => e.dstId),
    ['gmail:u1/^i'],
  );
});

test('the label-not-recovered bucket is per account as well', () => {
  // The two buckets hold precisely the threads whose view is already unknown —
  // merging them is the pair that would be hardest to pull apart afterwards.
  const u0 = parseGmailCapture(bv('unreadable', [thread('thread-f:1', 5, 'S', 'p', [])], [], '0'));
  const u1 = parseGmailCapture(bv('unreadable', [thread('thread-f:2', 5, 'S', 'p', [])], [], '1'));
  assert.equal(u0.items?.[0]?.containerId, 'gmail:u0/unknown');
  assert.equal(u1.items?.[0]?.containerId, 'gmail:u1/unknown');
  assert.equal(u0.containers?.[0]?.id, 'gmail:u0/unknown');
  assert.equal(u1.containers?.[0]?.id, 'gmail:u1/unknown');
});

test('two slots are two placeholders, and a placeholder says it is one', () => {
  // `bv` carries no address anywhere, so a thread-list response genuinely cannot
  // say whose mailbox it describes. Keeping the slots apart is still worth doing
  // — merging them would merge two mailboxes — but the NAME has to read as
  // unresolved. `Gmail (u0)` was the old spelling and it read as a mailbox,
  // which is how a workspace list showed two accounts as one row and nobody
  // could tell.
  const u0 = parseGmailCapture(bv('in:^i', [], SHARED_LABELS, '0')).workspaces?.[0];
  const u1 = parseGmailCapture(bv('in:^i', [], SHARED_LABELS, '1')).workspaces?.[0];
  assert.deepEqual(u0, {
    id: 'gmail:u0',
    adapterId: 'gmail',
    name: 'Gmail (u0 — mailbox not identified)',
  });
  assert.deepEqual(u1, {
    id: 'gmail:u1',
    adapterId: 'gmail',
    name: 'Gmail (u1 — mailbox not identified)',
  });
  assert.equal(u0?.domain, undefined, 'bv cannot know it, so it must not claim one');
  assert.ok(isProvisionalWorkspaceId(u0!.id) && isProvisionalWorkspaceId(u1!.id));
});

test('a placeholder is never the same workspace as a mailbox served from that slot', () => {
  // The property the whole scheme exists for. `bv` and `fd` on `/u/0/` in the
  // same session describe the same mailbox, and it is still right for them to
  // land apart until something proves it: the alternative is `bv` adopting
  // whichever mailbox happened to be at slot 0 last, which is a guess that is
  // wrong exactly when a switch has just happened. reconcile.ts is what closes
  // the gap, with the neighbouring captures as evidence.
  const list = parseGmailCapture(bv('in:^i', [], SHARED_LABELS, '0')).workspaces?.[0];
  const fetch = parseGmailCapture(
    fd([{ id: 'thread-f:9', messages: [{ id: 'msg-f:9', accountAddress: 'second@example.test' }] }], '0'),
  ).workspaces?.[0];
  assert.notEqual(list?.id, fetch?.id);
  assert.equal(fetch?.domain, 'second@example.test', 'fd is the only place it is written down');
  assert.equal(fetch?.id, 'gmail:second@example.test');
});

test('a container id says which account it belongs to', () => {
  // What a reader needs to tell one mailbox from the other, and what the MCP
  // tools filter on.
  assert.deepEqual(labelRef('gmail:u1/^i'), { workspaceId: 'gmail:u1', labelId: '^i' });
  assert.equal(containerKind('gmail:u1/^i'), 'label');
  assert.equal(containerKind('thread-f:1'), 'thread');
  assert.equal(containerKind('gmail:u1/unknown'), 'unrecovered');
  // A row written before ids were scoped keeps the bare id forever — nothing
  // re-parses a mailbox — and still has to read as the label it is.
  assert.deepEqual(labelRef('^i'), { labelId: '^i' });
  assert.equal(containerKind('^i'), 'label');
  assert.equal(containerKind('gmail:unknown'), 'unrecovered');
});

// ── parse: the two grains cannot collide ─────────────────────────────────────────

test('fd items never clobber bv items', () => {
  // Items upsert by (container_id, id). bv emits one item per THREAD keyed
  // (label, thread id); fd emits one per MESSAGE keyed (thread id, message id).
  // Both halves differ, and both differ for a reason rather than by luck: a
  // message id and its thread id share their digits — `msg-f:123…` against
  // `thread-f:123…` — and are told apart only by the prefix, so the container
  // half is what actually guarantees this.
  const threads = parseGmailCapture(fixture('/sync/u/0/i/bv')).items ?? [];
  const messages = recordedMessages();
  assert.ok(threads.length > 0 && messages.length > 0);

  const key = (i: Item) => `${i.containerId} ${i.id}`;
  const bvKeys = new Set(threads.map(key));
  for (const m of messages) assert.ok(!bvKeys.has(key(m)), `${key(m)} would overwrite a bv thread`);

  // The containers do not collide either: a label container is scoped to its
  // account and a thread container is the bare thread id, so the two parsers
  // cannot rename each other's rows.
  const labels = parseGmailCapture(fixture('/sync/u/0/i/bv')).containers ?? [];
  const threadContainers = allFixtures('/i/fd').flatMap((c) => parseGmailCapture(c).containers ?? []);
  assert.ok(labels.every((c) => containerKind(c.id) !== 'thread'));
  assert.ok(threadContainers.every((c) => containerKind(c.id) === 'thread'));
  assert.equal(
    threadContainers.filter((c) => labels.some((l) => l.id === c.id)).length,
    0,
  );
});

test('re-parsing the same fd capture is idempotent', () => {
  // The container of a message must be a function of the message, not of which
  // capture happened to carry it — otherwise the same message lands under two
  // container ids and the (container_id, id) key stores it twice.
  const capture = fdFixture('cap_9pndNYJ2l0EZ0TA2');
  assert.deepEqual(parseGmailCapture(capture), parseGmailCapture(capture));
});

// ── HTML → text ──────────────────────────────────────────────────────────────────

test('htmlToText keeps the words and drops the markup', () => {
  assert.equal(htmlToText('<p>Hello <b>world</b></p>'), 'Hello world');
  assert.equal(htmlToText('a<br>b'), 'a\nb', 'a break is a break, not a space');
  assert.equal(htmlToText('<div>one</div><div>two</div>'), 'one\ntwo');
  assert.equal(htmlToText('  lots   of\n\n\n   space  '), 'lots of\nspace');
});

test('htmlToText drops script and style CONTENT, not just their tags', () => {
  // A marketing email carries far more CSS and JavaScript than prose. Stripping
  // only the tags leaves `font-family` and `googletagmanager` as body text, and
  // those are then the words a search matches.
  assert.equal(
    htmlToText('<style>.x{font-family:Arial}</style><p>hi</p><script>var a=1<2;</script>'),
    'hi',
  );
});

test('htmlToText decodes the entities that change a word and leaves the rest alone', () => {
  assert.equal(htmlToText('a&nbsp;&amp;&nbsp;b'), 'a & b');
  assert.equal(htmlToText('&#72;&#x69;'), 'Hi');
  assert.equal(htmlToText('caf&eacute;'), 'caf&eacute;', 'an unknown entity is text, not a deletion');
});

test('htmlToText survives an entity that would throw', () => {
  // `String.fromCodePoint` throws RangeError above 0x10FFFF and on a lone
  // surrogate, and this runs in the ingest funnel where a throw is fatal.
  for (const hostile of ['&#9999999;', '&#xD800;', '&#0;', '&#x110000;', '&#;', '&#99999999999;']) {
    assert.doesNotThrow(() => htmlToText(hostile), hostile);
    assert.ok(htmlToText(hostile).length > 0, `${hostile} is text when it is not a character`);
  }
});

test('htmlToText is total on anything that is not a string', () => {
  for (const value of [null, undefined, 42, {}, [], '']) {
    assert.equal(htmlToText(value), '');
  }
  assert.equal(htmlToText('<p>unclosed'), 'unclosed');
  // Malformed markup leaves debris rather than throwing or eating the message:
  // `<[^>]*>` consumes `<<>` and the trailing `>` is just a character.
  assert.equal(htmlToText('<<>>'), '>');
});

test('htmlToText caps one message rather than truncating every message', () => {
  // Nothing in the 114-message recording is clipped by this — the largest body
  // there is 11 703 characters. It is a bound against one pathological message
  // dominating items_fts.
  assert.equal(htmlToText(`<p>${'x'.repeat(MAX_BODY_CHARS * 2)}</p>`).length, MAX_BODY_CHARS);
  assert.equal(htmlToText('<p>abc</p>', 2), 'ab');
});

test('an HTML-only message is flattened into the item text', () => {
  const r = parseGmailCapture(
    fd([
      {
        id: 'thread-f:1',
        messages: [
          {
            id: 'msg-f:1',
            subject: 'Invoice 42',
            html: ['<style>p{color:red}</style><p>Due&nbsp;today.</p>', '<p>Thanks</p>'],
          },
        ],
      },
    ]),
  );
  assert.equal(r.items?.[0]?.text, 'Invoice 42\n\nDue today.\nThanks');
});

// ── parse: what it deliberately does not do ──────────────────────────────────────

test('s and the shell parse to nothing at all', () => {
  // `s` is the incremental-delta channel: it names thread ids and label ids and
  // carries no content, so there is nothing to normalize that bv/fd do not say
  // better. The shell and the bundles are assets.
  for (const match of ['/sync/u/0/i/s', '/_/scs/', 'checkbuild']) {
    assert.deepEqual(parseGmailCapture(fixture(match)), {}, match);
  }
});

test('a bv response with no threads still yields the labels', () => {
  // The recording has one: a view with nothing in it answers `[2] = null`, not
  // an empty array, so anything that iterated it directly would throw.
  const res: unknown[] = new Array(19).fill(null);
  res[1] = [[['^i', '^i'], 7]];
  const c = makeCapture({
    method: 'POST',
    host: 'mail.google.com',
    path: '/sync/u/0/i/bv',
    url: 'https://mail.google.com/sync/u/0/i/bv',
    reqBody: '[[9,51,null,"in:^i"],null,null]',
    resBody: JSON.stringify(res),
  });
  const r = parseGmailCapture(c);
  assert.equal(r.containers?.length, 1);
  assert.equal(r.items, undefined);
});

// ── nextCursors ──────────────────────────────────────────────────────────────────

test('nextCursors is empty — no page offset was identifiable', () => {
  // A guessed offset re-fetches page one forever, and `sluice replay --all`
  // drains that against a live account. See gmailNextCursors for what was ruled
  // out and why.
  assert.deepEqual(gmailNextCursors(), []);
  assert.deepEqual(gmailAdapter.nextCursors?.(fixture('/sync/u/0/i/bv')), []);
});

// ── replay ───────────────────────────────────────────────────────────────────────

test('buildReplayRequest puts the cookie VALUES in the Cookie header', () => {
  const action = gmailAdapter.listReplayActions()[0];
  assert.ok(action, 'precondition: gmail has a replay action');
  const req = gmailAdapter.buildReplayRequest(action, { label: '^i' }, SESSION);
  assert.equal(req.headers.Cookie, 'SID=g.a000REAL_SID_VALUE; HSID=REAL_HSID_VALUE; SSID=REAL_SSID_VALUE');
  assert.equal(req.headers['x-framework-xsrf-token'], 'synthetic-xsrf:1700000000000');
  assert.ok(req.headers['User-Agent'], 'Google serves a different client to a non-browser agent');
});

test('a pre-assembled cookieHeader is accepted when no injection map is given', () => {
  // What a Chrome-cookie provider hands over: one ready-made header rather than a
  // name→key map. app-trello mints exactly this shape.
  const action = gmailAdapter.listReplayActions()[0];
  assert.ok(action);
  const req = gmailAdapter.buildReplayRequest(action, {}, {
    ...SESSION,
    credentials: {
      kind: 'google-cookies',
      values: { cookieHeader: 'SID=abc; HSID=def' },
      injection: {},
    },
  });
  assert.equal(req.headers.Cookie, 'SID=abc; HSID=def');
});

test('the account index goes in the PATH and the label goes in the BODY', () => {
  // `new URL('…/u/{account}/i/bv')` percent-encodes the braces into a literal
  // `/u/%7Baccount%7D/`, which 404s; and bv reads its arguments positionally out
  // of the body, so a label appended to the query string selects nothing.
  const action = gmailAdapter.listReplayActions()[0];
  assert.ok(action);
  const req = gmailAdapter.buildReplayRequest(action, { account: '2', label: '^x_1' }, SESSION);
  const u = new URL(req.url);
  assert.equal(u.pathname, '/sync/u/2/i/bv');
  assert.equal(u.searchParams.get('label'), null);
  assert.equal(req.headers.Referer, 'https://mail.google.com/mail/u/2/');

  const body = JSON.parse(req.body ?? '') as unknown[];
  const frame = body[0] as unknown[];
  assert.equal(frame.length, 33, 'the frame arity the real client sends');
  assert.equal(frame[3], 'in:^x_1');
  assert.equal(frame[5], 'itemlist-ViewType(0)-0', 'the view type in [5] tracks the one in [0]');
  assert.equal(frame[0], 0);
});

test('a scoped label id selects the label AND the account it came from', () => {
  // `label` is `kind: 'containerId'`, so the UI hands over a Container id — and
  // those are scoped now. Two ways to get this wrong, both silent: `in:gmail:u1/^i`
  // is a query that selects nothing, and replaying account 1's Inbox against
  // `/u/0/` fetches the wrong mailbox and files it under a right-looking view.
  const action = gmailAdapter.listReplayActions()[0];
  assert.ok(action);
  const req = gmailAdapter.buildReplayRequest(action, { label: 'gmail:u1/^x_1' }, SESSION);
  assert.equal(new URL(req.url).pathname, '/sync/u/1/i/bv');
  assert.equal(req.headers.Referer, 'https://mail.google.com/mail/u/1/');
  assert.equal((JSON.parse(req.body ?? '') as unknown[][])[0]?.[3], 'in:^x_1');
});

test('an explicit account still wins over the one the label id names', () => {
  const action = gmailAdapter.listReplayActions()[0];
  assert.ok(action);
  const req = gmailAdapter.buildReplayRequest(action, { account: '2', label: 'gmail:u1/^i' }, SESSION);
  assert.equal(new URL(req.url).pathname, '/sync/u/2/i/bv');
});

test('a missing account throws by name instead of building a broken url', () => {
  const action = gmailAdapter.listReplayActions()[0];
  assert.ok(action);
  assert.throws(
    () => gmailAdapter.buildReplayRequest(action, { account: '' }, SESSION),
    /account/,
    'the error has to name the param the caller left out',
  );
});

// ── the shared invariants ────────────────────────────────────────────────────────

runConformance(gmailApp, {
  session: SESSION,
  fixtures: [
    ...FIXTURES,
    // Shapes the recording happens not to contain. `bv` is the only endpoint with
    // a parser, so without these the never-throws probes stop at its first guard.
    bv('in:^i', [thread('thread-f:1', 5, 'S', 'p', ['^i'])], [[['^i', '^i']]]),
    makeCapture({
      host: 'mail.google.com',
      path: '/sync/u/0/i/bv',
      url: 'https://mail.google.com/sync/u/0/i/bv',
      reqBody: '[[9,51,null,"in:^i"]]',
      // labels and threads sent as objects rather than arrays — `?? []` does not
      // save you here, the field is present and simply not iterable.
      resBody: '[0,{"0":["^i"]},{"0":[]},1]',
    }),
    makeCapture({
      host: 'mail.google.com',
      path: '/sync/u/0/i/bv',
      url: 'https://mail.google.com/sync/u/0/i/bv',
      reqBody: '[[9,51,null,"in:^__proto__"]]',
      resBody: '[0,[[["^i",null],7],7,null],[["not-a-record",1],[[],1]],1]',
    }),
    // fd, likewise: the parser reads eight levels down into a positional array
    // (`[1][i][2][j][1][5][1][k][2][1]`), and every one of those levels is a place
    // Google can send something else.
    fd([
      {
        id: 'thread-f:1',
        messages: [{ id: 'msg-f:1', from: ['a@b.test'], to: [['c@d.test']], labels: ['^i'] }],
      },
    ]),
    makeCapture({
      host: 'mail.google.com',
      path: '/sync/u/0/i/fd',
      url: 'https://mail.google.com/sync/u/0/i/fd',
      reqBody: '[[["thread-f:1"]],2]',
      // A thread that is an object, a message that is a scalar, a record whose
      // address lists and body block are the wrong type throughout, and a sender
      // card that is a string. `?? []` does not save you from any of them.
      resBody:
        '[0,[{"0":"thread-f:1"},["thread-f:2",null,"nope"],["thread-f:3",{"1":[]},[["msg-f:3",{"0":1,"5":"x","10":"y","16":"z"}],7,[]]]],null,null,[1]]',
    }),
    makeCapture({
      host: 'mail.google.com',
      path: '/sync/u/0/i/fd',
      url: 'https://mail.google.com/sync/u/0/i/fd',
      reqBody: '[[["thread-f:__proto__"]],2]',
      // Prototype keys as ids, an empty id (which would upsert onto whatever
      // else has one), and a body block whose parts are not parts.
      resBody:
        '[0,[["__proto__",null,[["",[null,null,null,null,"s",[null,[[0,null,7,0]],1,null,[],""],"",null,null,null,null,null,null,null,null,0]],["constructor",[]]]]],null,null,[1]]',
    }),
  ],
});
