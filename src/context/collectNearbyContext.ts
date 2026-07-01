import { join } from "node:path";
import { readTextIfExists } from "./fsProbe.js";

/**
 * Extract line-numbered code around a changed file's hunks, read from the
 * checked-out repo (Phase 3 workspace). This gives review agents the real
 * surrounding code — not just the diff — so they can judge context. Heuristic
 * and bounded: only the new-file side of each hunk, expanded by a context
 * window, merged, and capped in total lines.
 */

const DEFAULT_MAX_NEARBY_LINES = 400;
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

/** New-file [start, end] (1-based, inclusive) line ranges touched by the patch. */
export function parseHunkNewRanges(patch: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  HUNK_RE.lastIndex = 0;
  while ((m = HUNK_RE.exec(patch)) !== null) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    if (len > 0 && Number.isFinite(start)) ranges.push([start, start + len - 1]);
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

export interface NearbyContextInput {
  repoDir: string;
  filePath: string;
  patch: string | null;
  status: string;
  contextLines: number;
  /** Total cap on emitted lines across all hunks; defaults to 400. */
  maxTotalLines?: number;
}

/**
 * Return a line-numbered snippet of the file around its changed hunks, or null
 * when it can't be produced (no patch, deleted file, missing/binary file).
 */
export async function collectNearbyContext(input: NearbyContextInput): Promise<string | null> {
  if (!input.patch || input.status === "removed") return null;
  const ranges = parseHunkNewRanges(input.patch);
  if (ranges.length === 0) return null;

  const content = await readTextIfExists(join(input.repoDir, input.filePath));
  if (content === null) return null;
  const lines = content.split("\n");

  const windows = mergeRanges(
    ranges.map(([s, e]) => [
      Math.max(1, s - input.contextLines),
      Math.min(lines.length, e + input.contextLines),
    ]),
  );

  let budget = input.maxTotalLines ?? DEFAULT_MAX_NEARBY_LINES;
  const snippets: string[] = [];
  for (const [start, end] of windows) {
    if (budget <= 0) break;
    const clippedEnd = Math.min(end, start + budget - 1);
    const body: string[] = [];
    for (let i = start; i <= clippedEnd; i++) {
      body.push(`${i}\t${lines[i - 1] ?? ""}`);
    }
    budget -= clippedEnd - start + 1;
    snippets.push(`@@ lines ${start}-${clippedEnd} @@\n${body.join("\n")}`);
  }

  return snippets.length > 0 ? snippets.join("\n\n") : null;
}
