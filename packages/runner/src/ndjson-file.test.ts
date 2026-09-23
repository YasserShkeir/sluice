// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * readNdjsonFile tests. Run with:
 *   node --import tsx --test src/*.test.ts   (from this package)
 *
 * The production chunk is 32 MB, so these pass a tiny one instead: the code
 * path is the same, and a chunk of a few bytes puts a boundary inside every
 * multi-byte character and every line at least once.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { parseNdjson, toNdjson } from '@sluice/adapter-sdk';
import type { Capture } from '@sluice/core';
import { readNdjsonFile } from './ndjson-file.js';

const dir = mkdtempSync(join(tmpdir(), 'sluice-ndjson-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const capture = (id: string, resBody: string): Capture => ({
  id,
  ts: 1_757_000_000_000,
  source: 'mitm',
  adapterId: null,
  method: 'GET',
  url: 'https://api.example.test/v1/pages',
  host: 'api.example.test',
  path: '/v1/pages',
  status: 200,
  durationMs: 5,
  reqHeaders: {},
  reqBody: null,
  resHeaders: {},
  resBody,
});

test('a chunk boundary inside a multi-byte character does not corrupt the record', () => {
  // Two-, three- and four-byte UTF-8 sequences, back to back.
  const captures = [
    capture('cap_a', 'Café — über ₿ 🧪 done'),
    capture('cap_b', 'ภาษาไทย 日本語 العربية'),
    capture('cap_c', 'plain ascii'),
  ];
  const file = join(dir, 'multibyte.ndjson');
  writeFileSync(file, toNdjson(captures));

  for (let chunk = 1; chunk <= 17; chunk++) {
    const { captures: back, skipped } = readNdjsonFile(file, chunk);
    assert.deepEqual(skipped, [], `chunk=${chunk}`);
    assert.deepEqual(back, captures, `chunk=${chunk}: text must survive a split character`);
  }
});

test('malformed lines are reported by their line number in the file', () => {
  // Blank lines, a bad line, and no trailing newline: the numbering has to match
  // what parseNdjson reports for the whole text, or the skip report points at
  // the wrong line of a fixture someone is hand-scrubbing.
  const good = toNdjson([capture('cap_1', 'one')]).trimEnd();
  const text = `${good}\n\n{not json\n${toNdjson([capture('cap_2', 'two')]).trimEnd()}\n[]\n\n${good.replace('cap_1', 'cap_3')}`;
  const file = join(dir, 'mixed.ndjson');
  writeFileSync(file, text);

  const whole = parseNdjson(text);
  assert.deepEqual(whole.skipped, [3, 5]);
  for (const chunk of [1, 7, 64, 1024]) {
    assert.deepEqual(readNdjsonFile(file, chunk), whole, `chunk=${chunk}`);
  }
});

test('an empty file reads as nothing', () => {
  const file = join(dir, 'empty.ndjson');
  writeFileSync(file, '');
  assert.deepEqual(readNdjsonFile(file), { captures: [], skipped: [] });
});
