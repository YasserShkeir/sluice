// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A minimal line diff for the inspector's compare view.
 *
 * The use it exists for is Sluice's own: pin a response, replay the action, and
 * see what changed between the original and the replay. That is a line-level
 * question ("this field flipped, that array grew"), so a full character diff is
 * more than it needs — an LCS over lines gives a clean unified view.
 *
 * Bounded on purpose: the LCS table is O(n·m), so past a line budget it degrades
 * to a plain "left removed / right added" block rather than hang the tab on two
 * 50k-line bodies. Pretty-print both sides before diffing so formatting noise
 * does not read as change.
 */
export type DiffLine = {
  /** Stable per-row id assigned at build time, so React keys need not be the array index. */
  id: number;
  type: 'ctx' | 'add' | 'del';
  text: string;
};

/** Above this many lines on either side, skip the LCS and show a coarse block. */
const MAX_LCS_LINES = 2000;

export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length > MAX_LCS_LINES || B.length > MAX_LCS_LINES) {
    return [
      ...A.map((text, i): DiffLine => ({ id: i, type: 'del', text })),
      ...B.map((text, i): DiffLine => ({ id: A.length + i, type: 'add', text })),
    ];
  }

  // LCS length table.
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  // Backtrack into a unified sequence.
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ id: out.length, type: 'ctx', text: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ id: out.length, type: 'del', text: A[i]! });
      i++;
    } else {
      out.push({ id: out.length, type: 'add', text: B[j]! });
      j++;
    }
  }
  while (i < n) out.push({ id: out.length, type: 'del', text: A[i++]! });
  while (j < m) out.push({ id: out.length, type: 'add', text: B[j++]! });
  return out;
}

/** Count changed lines, for a compact "±N" summary. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}
