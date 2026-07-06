import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ParsedPr } from "../github/parsePrUrl.js";
import { getSharedPaths, RUNS_DIRNAME } from "./artifactPaths.js";
import { readJsonArtifact } from "./readArtifact.js";
import { writeJsonArtifact } from "./writeArtifact.js";

/**
 * The `.ai-review/latest.json` pointer — the one root-level file that names the
 * most recent review run. `review` writes it as soon as a run directory exists;
 * `fix` (and anything else that consumes "the latest run") resolves the run id
 * through it instead of guessing from directory listings, so consumers can
 * never accidentally read a mix of runs.
 */

export const LatestRunPointerSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  /** Directory of the run, relative to `.ai-review/` (informational). */
  runDir: z.string().min(1),
  command: z.string(),
  pr: z
    .object({ owner: z.string(), repo: z.string(), number: z.number().int().positive() })
    .nullable(),
  prUrl: z.string().nullable(),
  createdAt: z.string(),
});

export type LatestRunPointer = z.infer<typeof LatestRunPointerSchema>;

/**
 * Mint a new run id: UTC timestamp (filesystem-safe, lexicographically
 * sortable) plus a short random suffix so two runs started in the same second
 * cannot collide.
 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "-");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export interface WriteLatestPointerInput {
  baseDir: string;
  runId: string;
  command: string;
  pr: ParsedPr | null;
  prUrl: string | null;
}

/** Point `.ai-review/latest.json` at `runId`. */
export async function writeLatestRunPointer(input: WriteLatestPointerInput): Promise<void> {
  const shared = getSharedPaths(input.baseDir);
  const pointer: LatestRunPointer = {
    schemaVersion: 1,
    runId: input.runId,
    runDir: `${RUNS_DIRNAME}/${input.runId}`,
    command: input.command,
    pr: input.pr,
    prUrl: input.prUrl,
    createdAt: new Date().toISOString(),
  };
  await writeJsonArtifact(shared.latestPointer, pointer);
}

/**
 * The latest review run's pointer, or `null` when there is none (no run yet,
 * pre-run-scoping layout, or an unreadable/shapeless pointer file). Callers
 * decide how hard to fail — `fix` turns `null` into a "run review first" error.
 */
export async function readLatestRunPointer(baseDir: string): Promise<LatestRunPointer | null> {
  const shared = getSharedPaths(baseDir);
  try {
    const parsed = LatestRunPointerSchema.safeParse(await readJsonArtifact(shared.latestPointer));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
