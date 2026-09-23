// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notion's `recordMap` — the one payload shape every read endpoint returns.
 *
 * Notion does not have per-resource JSON. `loadPageChunk`, `queryCollection`,
 * `getSpaces`, `search` and `syncRecordValues*` all answer with the same
 * envelope: a map of TABLE → id → wrapper, where the wrapper holds the record.
 * So there is exactly one shape to parse, and the endpoints differ only in which
 * tables they happen to fill. This module knows that shape; nothing else does.
 *
 * Three facts about it that cost real debugging time:
 *
 *   1. **The wrapper is doubly nested.** Every table entry is
 *      `{ spaceId, value: { value: <record>, role } }` — the record is two
 *      `.value` hops down, not one. Older Notion builds (and some endpoints on
 *      older accounts) return the single-hop `{ role, value: <record> }`, so
 *      {@link recordValue} unwraps by looking for `id`, not by counting hops.
 *
 *   2. **`getSpaces` is a recordMap keyed by user id.** Its top level is
 *      `{ "<userId>": { __version__, notion_user, space, … } }` rather than
 *      `{ recordMap: … }`. {@link recordMaps} yields both shapes so a caller
 *      never has to special-case the endpoint.
 *
 *   3. **Database row property keys are opaque.** A page inside a database
 *      stores its properties under 4-character schema ids (`_SiA`, `` `J_P ``),
 *      not names — the names live in the parent `collection.schema`. `title` is
 *      the one stable key. {@link plainText} therefore reads `properties.title`
 *      for a title and leaves the rest to `raw`, where the cartographer can
 *      derive typed columns later against the schema.
 *
 * Every function here is total: odd shapes yield `undefined` or `''`, never a
 * throw. They run inside `parse`, which must not throw.
 */
import { arr, obj, str } from '@sluice/adapter-sdk';

/** One Notion record, still in service vocabulary. */
export type NotionRecord = Record<string, unknown>;

/** A recordMap: table name → record id → wrapper. `__version__` is not a table. */
export type RecordMap = Record<string, unknown>;

/**
 * The record inside a table wrapper, whichever nesting the endpoint used.
 *
 * Presence of `id` is the discriminator rather than the hop count: a wrapper is
 * `{ spaceId, value: { value: <record> } }` today and `{ role, value: <record> }`
 * on older builds, and a parser that hardcoded `.value.value` returned
 * `undefined` for every record on the second shape — silently, as zero entities.
 */
export function recordValue(wrapper: unknown): NotionRecord | undefined {
  const w = obj(wrapper);
  if (!w) return undefined;
  if (typeof w.id === 'string') return w;
  const inner = obj(w.value);
  if (!inner) return undefined;
  if (typeof inner.id === 'string') return inner;
  const deeper = obj(inner.value);
  return deeper && typeof deeper.id === 'string' ? deeper : undefined;
}

/** The space id Notion stamps on the wrapper, above the record itself. */
export function wrapperSpaceId(wrapper: unknown): string | undefined {
  return str(obj(wrapper)?.spaceId);
}

/**
 * Every recordMap in a response body — usually one, occasionally several.
 *
 * `loadPageChunk` / `queryCollection` / `search` nest theirs under `recordMap`.
 * `getSpaces` returns one per signed-in user, keyed by user id, with no
 * `recordMap` wrapper at all — a `__version__` key is what identifies those.
 */
export function recordMaps(body: unknown): RecordMap[] {
  const root = obj(body);
  if (!root) return [];
  const direct = obj(root.recordMap);
  if (direct) return [direct];
  const out: RecordMap[] = [];
  for (const v of Object.values(root)) {
    const m = obj(v);
    if (m && '__version__' in m) out.push(m);
  }
  return out;
}

/** Walk one table of a recordMap, yielding `(id, record, spaceId)` triples. */
export function* tableRecords(
  map: RecordMap,
  table: string,
): Generator<{ id: string; record: NotionRecord; spaceId?: string }> {
  const t = obj(map[table]);
  if (!t) return;
  for (const [id, wrapper] of Object.entries(t)) {
    const record = recordValue(wrapper);
    if (!record) continue;
    yield { id: str(record.id) ?? id, record, spaceId: wrapperSpaceId(wrapper) ?? str(record.space_id) };
  }
}

/**
 * Flatten one Notion rich-text array to plain text.
 *
 * The shape is `[[text], [text, [[format, …]]], …]`. A mention is encoded as the
 * literal character `‣` carrying a format tuple — `['u', userId]` for a person,
 * `['p', pageId, spaceId]` for a page, `['d', dateSpec]` for a date. Those
 * render as `‣` alone, which would silently turn "‣ approved this" into an
 * unreadable line, so mentions are expanded to a readable token instead. The
 * ids stay in `raw` for anyone who needs to resolve them.
 */
export function plainText(rich: unknown): string {
  const segments = arr(rich);
  if (!segments) return '';
  const parts: string[] = [];
  for (const seg of segments) {
    const pair = arr(seg);
    if (!pair || pair.length === 0) continue;
    const text = str(pair[0]) ?? '';
    if (text !== '‣') {
      parts.push(text);
      continue;
    }
    parts.push(mentionToken(pair[1]));
  }
  return parts.join('');
}

/** `‣` + `[['u', id]]` → `@user:id`; `[['p', id, space]]` → `@page:id`. */
function mentionToken(formats: unknown): string {
  const list = arr(formats);
  const first = list ? arr(list[0]) : undefined;
  const kind = first ? str(first[0]) : undefined;
  const id = first ? str(first[1]) : undefined;
  if (kind === 'u' && id) return `@user:${id}`;
  if (kind === 'p' && id) return `@page:${id}`;
  if (kind === 'd') return '@date';
  return '‣';
}

/** A block's or collection's title as plain text. */
export function recordTitle(record: NotionRecord): string {
  const props = obj(record.properties);
  if (props && props.title !== undefined) return plainText(props.title);
  // `collection` and `team` carry the title one level up, under `name`, and a
  // collection's `name` is itself rich text (`[['Project plans']]`).
  if (record.name !== undefined) {
    const asText = str(record.name);
    return asText ?? plainText(record.name);
  }
  return '';
}

/**
 * When this record last changed, in epoch ms.
 *
 * Notion already stores epoch ms, so there is no date parsing here — but the
 * field is missing on plenty of records (`space_user`, `discussion`, `reaction`
 * on older rows), and `0` is the contract's "unknown".
 */
export function recordTs(record: NotionRecord): number {
  const edited = record.last_edited_time;
  const created = record.created_time;
  if (typeof edited === 'number' && Number.isFinite(edited)) return edited;
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  return 0;
}
