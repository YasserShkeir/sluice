// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WebVTT → plain transcript.
 *
 * Loom's `fetchVideoTranscript` resolves to a signed `captions_source_url` — a
 * WebVTT (`.vtt`) file on cdn.loom.com. This turns that file into timed segments
 * and one joined text blob, which is what a caller actually wants from "the
 * transcript of a video". Kept dependency-free and total: a malformed cue is
 * skipped, never thrown.
 */

export interface TranscriptSegment {
  /** seconds from the start of the video */
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  /** every segment's text joined with spaces — the whole transcript as prose */
  text: string;
}

/** `HH:MM:SS.mmm` or `MM:SS.mmm` → seconds, or NaN if unparseable. */
function cueTimeToSeconds(raw: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!m) return NaN;
  const [, hh, mm, ss, ms] = m;
  const h = hh ? Number(hh) : 0;
  const min = Number(mm);
  const sec = Number(ss);
  const millis = ms ? Number(ms.padEnd(3, '0')) : 0;
  return h * 3600 + min * 60 + sec + millis / 1000;
}

/** Strip WebVTT inline markup: `<c>`, `</c>`, `<v Name>`, `<00:00:01.000>`. */
function stripCueTags(line: string): string {
  return line.replace(/<[^>]*>/g, '').trim();
}

/**
 * Parse a WebVTT document. Blocks are separated by blank lines; a cue block has a
 * `start --> end` timing line optionally preceded by a numeric/id line, followed
 * by one or more text lines. Header (`WEBVTT`), `NOTE`, `STYLE` and `REGION`
 * blocks are ignored.
 */
export function parseVtt(vtt: string): Transcript {
  const segments: TranscriptSegment[] = [];
  const blocks = vtt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    const first = lines[0]?.trim() ?? '';
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(first)) continue;

    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;

    const timing = lines[timingIdx] ?? '';
    const [startRaw, rest] = timing.split('-->');
    if (startRaw === undefined || rest === undefined) continue;
    // The end time can be followed by cue settings (e.g. `align:start position:0%`).
    const endRaw = rest.trim().split(/\s+/)[0] ?? '';
    const start = cueTimeToSeconds(startRaw);
    const end = cueTimeToSeconds(endRaw);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;

    const text = lines
      .slice(timingIdx + 1)
      .map(stripCueTags)
      .filter((l) => l.length > 0)
      .join(' ')
      .trim();
    if (text.length === 0) continue;

    segments.push({ start, end, text });
  }

  return { segments, text: segments.map((s) => s.text).join(' ') };
}
