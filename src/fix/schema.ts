import { z } from "zod";
import type { JudgeClassification } from "../findings/schema.js";
import { SKEPTIC_FAILURE_KINDS } from "../findings/schema.js";

/**
 * Fix-mode schemas (PRD Phase 11). Two layers, following the repo-wide split:
 *
 *   • Zod schemas parse what the MODEL returns (`FixProposal`) — the fix agent
 *     proposes exact search/replace edits rather than a unified diff, because a
 *     model-emitted diff is brittle (wrong hunk headers/context make `git apply`
 *     fail), while edits applied by us and diffed with `git diff` always yield a
 *     valid, applyable `patch.diff`.
 *   • Plain interfaces describe data WE produce (`FixFindingOutcome`,
 *     `FixResults`) — same convention as `workspace/schema.ts`.
 */

/**
 * One exact search/replace edit. `search` must be copied byte-exact from the
 * current file content and occur exactly once in the file at apply time —
 * ambiguity or a miss fails the whole finding's proposal (all-or-nothing),
 * never a partial write.
 */
export const FixEditSchema = z.object({
  // Repo-relative path; must be a file the PR changed (guard in applyFixEdits).
  path: z.string().min(1),
  search: z.string().min(1),
  // May be empty — an empty replace deletes the searched text.
  replace: z.string(),
});
export type FixEdit = z.infer<typeof FixEditSchema>;

/**
 * The fix agent's full response for one finding. `edits: []` means the model
 * declined to propose a safe minimal fix; `needs_manual_review` carries either
 * the reason for declining or follow-ups a human should still do (e.g. "add a
 * regression test").
 */
export const FixProposalSchema = z.object({
  edits: z.array(FixEditSchema),
  summary: z.string(),
  needs_manual_review: z.string().nullable(),
});
export type FixProposal = z.infer<typeof FixProposalSchema>;

/**
 * Structured-output JSON Schema for the fix proposal. Same convention as
 * `JUDGE_OUTPUT_JSON_SCHEMA`: closed objects, every property required; value
 * semantics (non-empty strings) are re-checked by `FixProposalSchema` on parse.
 */
export const FIX_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["edits", "summary", "needs_manual_review"],
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "search", "replace"],
        properties: {
          path: { type: "string" },
          search: { type: "string" },
          replace: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
    needs_manual_review: { type: ["string", "null"] },
  },
};

/**
 * Why a finding could not be fixed. The first group is the shared model-failure
 * vocabulary (same as skeptic/judge); the rest are fix-specific:
 *   - `declined`             — the model returned zero edits (its explicit choice).
 *   - `no_file`              — the finding has `file: null`; nothing to anchor a patch to.
 *   - `path_not_in_changeset`— an edit targets a file the PR did not change (MVP guard).
 *   - `path_escapes_repo`    — an edit path is absolute or escapes the checkout.
 *   - `search_not_found`     — a `search` string does not occur in the file.
 *   - `ambiguous_search`     — a `search` string occurs more than once.
 *   - `file_unreadable`      — the target file is missing/unreadable in the workspace.
 *   - `file_not_utf8`         — the target file is not valid UTF-8 (binary or a
 *                               legacy encoding); a lossy decode + whole-file
 *                               rewrite would corrupt every non-UTF-8 byte in it.
 *   - `write_failed`          — committing the staged edits to disk failed
 *                               (already-written files are rolled back).
 */
export const FIX_FAILURE_KINDS = [
  ...SKEPTIC_FAILURE_KINDS,
  "declined",
  "no_file",
  "path_not_in_changeset",
  "path_escapes_repo",
  "search_not_found",
  "ambiguous_search",
  "file_unreadable",
  "file_not_utf8",
  "write_failed",
] as const;
export type FixFailureKind = (typeof FIX_FAILURE_KINDS)[number];

/**
 * Per-finding outcome:
 *   - `fixed`   — edits were applied to the workspace checkout.
 *   - `skipped` — nothing was attempted (`declined` / `no_file`).
 *   - `failed`  — attempted but could not complete (model failure or apply failure).
 */
export type FixOutcomeStatus = "fixed" | "skipped" | "failed";

/** One selected finding's fix outcome, as recorded in `fix_results.json`. */
export interface FixFindingOutcome {
  cluster_id: string;
  title: string;
  file: string | null;
  classification: JudgeClassification;
  final_score: number;
  status: FixOutcomeStatus;
  /** The model's summary of what it changed (null when it never responded). */
  summary: string | null;
  /** Follow-ups or decline reasons the model flagged for a human. */
  needs_manual_review: string | null;
  edits_applied: number;
  /** Non-null only when `status` is `skipped` or `failed`. */
  failure: { kind: FixFailureKind; message: string } | null;
}

/** `.ai-review/fix_results.json` — the machine-readable run record. */
export interface FixResults {
  schemaVersion: 1;
  /** All findings in `final_findings.json`. */
  totalFinalFindings: number;
  /** Findings matching the fixable filter (before the `fix.maxFindings` cap). */
  fixableCount: number;
  /** Findings actually attempted (after the cap). */
  selectedCount: number;
  outcomes: FixFindingOutcome[];
  /** True when a non-empty `patch.diff` was written. */
  patchWritten: boolean;
  /** True when `--apply` left the workspace checkout patched. */
  workspaceLeftPatched: boolean;
  generatedAt: string;
}
