/**
 * Unified-diff hunk parsing, shared by the nearby-context builder
 * (`collectNearbyContext`) and the skeptic's evidence checks (`evidenceChecks`).
 * Pure — no IO — so both callers agree on which new-file lines a patch touches
 * instead of maintaining two regexes that can drift.
 */

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

export interface ParseHunkOptions {
  /**
   * Keep pure-deletion hunks (`+start,0`) as a zero-width point `[start, start]`
   * so callers can still anchor findings near removed code. Off by default: the
   * nearby-context builder has no new-file lines to show for a deletion.
   */
  keepEmpty?: boolean;
}

/** New-file `[start, end]` (1-based, inclusive) line ranges touched by the patch. */
export function parseHunkNewRanges(
  patch: string,
  opts: ParseHunkOptions = {},
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  HUNK_RE.lastIndex = 0;
  while ((m = HUNK_RE.exec(patch)) !== null) {
    const start = Number(m[1]);
    // A missing count means 1 (unified-diff convention).
    const len = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isFinite(start)) continue;
    if (len > 0) ranges.push([start, start + len - 1]);
    else if (opts.keepEmpty) ranges.push([start, start]);
  }
  return ranges;
}

/** Merge overlapping/adjacent [start,end] ranges (assumes small counts). */
export function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}
