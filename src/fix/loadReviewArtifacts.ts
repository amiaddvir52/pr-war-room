import { relative } from "node:path";
import { z } from "zod";
import { FixError } from "../errors.js";
import { FinalFindingSchema, type FinalFinding } from "../findings/schema.js";
import {
  ChangedFilesArtifactSchema,
  type ChangedFilesArtifact,
} from "../github/schema.js";
import type { ParsedPr } from "../github/parsePrUrl.js";
import { ArtifactNotFoundError, readJsonArtifact } from "../storage/readArtifact.js";
import { formatZodError } from "../util/formatZodError.js";

/**
 * Validated readers for the review-run artifacts fix mode consumes. The two
 * inputs fix cannot work without (`final_findings.json`, `changed_files.json`)
 * fail loudly with a `FixError` (exit 7) pointing at the missing prerequisite;
 * the provenance artifacts (`run_metadata.json`, `workspace_metadata.json`) are
 * read tolerantly — `null` on any problem — because fix can proceed without
 * them, just with weaker cross-checks.
 */

const FinalFindingsSchema = z.array(FinalFindingSchema);

/** Load and validate `final_findings.json`. Missing/invalid → `FixError`. */
export async function loadFinalFindings(path: string, cwd: string): Promise<FinalFinding[]> {
  let raw: unknown;
  try {
    raw = await readJsonArtifact(path);
  } catch (err) {
    if (err instanceof ArtifactNotFoundError) {
      throw new FixError(
        `No final findings at ${relative(cwd, path)} — run \`pr-war-room review <pr-url>\` first ` +
          "(the judge must be enabled: judge.enabled=true).",
      );
    }
    throw new FixError(`Cannot read final findings: ${(err as Error).message}`);
  }
  const parsed = FinalFindingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FixError(
      `${relative(cwd, path)} does not match the expected shape (stale or incompatible review run — ` +
        `re-run \`pr-war-room review\`): ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/** Load and validate `github/changed_files.json`. Missing/invalid → `FixError`. */
export async function loadChangedFiles(
  path: string,
  cwd: string,
): Promise<ChangedFilesArtifact> {
  let raw: unknown;
  try {
    raw = await readJsonArtifact(path);
  } catch (err) {
    if (err instanceof ArtifactNotFoundError) {
      throw new FixError(
        `No changed-files artifact at ${relative(cwd, path)} — the review run is incomplete; ` +
          "re-run `pr-war-room review <pr-url>`.",
      );
    }
    throw new FixError(`Cannot read changed files: ${(err as Error).message}`);
  }
  const parsed = ChangedFilesArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FixError(
      `${relative(cwd, path)} does not match the expected shape — re-run \`pr-war-room review\`: ` +
        formatZodError(parsed.error),
    );
  }
  return parsed.data;
}

// Only the fields fix cross-checks; everything else in run_metadata.json is
// passed through untouched (and never rewritten by fix).
const ReviewRunPrSchema = z
  .object({
    pr: z
      .object({
        owner: z.string(),
        repo: z.string(),
        number: z.number().int().positive(),
      })
      .nullable(),
  })
  .passthrough();

/**
 * The PR the on-disk review run belongs to, or `null` when `run_metadata.json`
 * is missing/unreadable/shapeless (tolerated: the PR-match check is skipped).
 */
export async function loadReviewedPr(path: string): Promise<ParsedPr | null> {
  try {
    const parsed = ReviewRunPrSchema.safeParse(await readJsonArtifact(path));
    return parsed.success ? parsed.data.pr : null;
  } catch {
    return null;
  }
}

const WorkspaceHeadSchema = z.object({ headSha: z.string().min(1) }).passthrough();

/**
 * The head sha the review checked out, or `null` when `workspace_metadata.json`
 * is missing/unreadable (tolerated: fix falls back to a fresh fetch).
 */
export async function loadWorkspaceHeadSha(path: string): Promise<string | null> {
  try {
    const parsed = WorkspaceHeadSchema.safeParse(await readJsonArtifact(path));
    return parsed.success ? parsed.data.headSha : null;
  } catch {
    return null;
  }
}
