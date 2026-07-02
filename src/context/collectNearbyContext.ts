import { join } from "node:path";
import { readTextIfExists } from "./fsProbe.js";
import { mergeRanges, parseHunkNewRanges } from "./hunkRanges.js";

/**
 * Extract line-numbered code around a changed file's hunks, read from the
 * checked-out repo (Phase 3 workspace). This gives review agents the real
 * surrounding code — not just the diff — so they can judge context. Heuristic
 * and bounded: only the new-file side of each hunk, expanded by a context
 * window, merged, and capped in total lines.
 */

// Hunk parsing lives in `./hunkRanges` so the skeptic's evidence checks use the
// exact same parser. Re-exported here for existing importers.
export { mergeRanges, parseHunkNewRanges } from "./hunkRanges.js";

const DEFAULT_MAX_NEARBY_LINES = 400;

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
