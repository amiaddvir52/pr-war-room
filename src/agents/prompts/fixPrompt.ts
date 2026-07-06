import type { FinalFinding } from "../../findings/schema.js";
import { fence } from "../../report/markdownHelpers.js";
import { renderCluster } from "./renderContext.js";

/**
 * Prompt for the fix agent (Phase 11, PRD §10.10). The agent is given one
 * validated finding plus the CURRENT content of the file it points at (read
 * from the workspace checkout — the exact bytes its edits will be applied to)
 * and returns exact search/replace edits, not a diff. We apply the edits and
 * let `git diff` produce `patch.diff`, so the patch is valid by construction.
 */

/** Everything the fix agent sees for one finding. */
export interface FixPromptContext {
  finding: FinalFinding;
  /**
   * The current file content from the workspace checkout — raw and
   * un-line-numbered so the model's `search` strings can match byte-exact.
   * May be a window of a large file (see `fileWindow`).
   */
  fileContent: string;
  fileWindow: { startLine: number; endLine: number; truncated: boolean };
  /** This file's diff hunk from the PR (`changed_files.json`), or null. */
  diffPatch: string | null;
}

// Whole files up to this size go into the prompt; larger ones are windowed
// around the finding's line anchor so the prompt stays focused and bounded.
const MAX_WHOLE_FILE_BYTES = 24 * 1024;
const WINDOW_LINES = 80;
// Anchorless fallback for oversized files: show the head and let the model
// decline if the relevant code is not visible.
const HEAD_LINES = 200;

export interface FileWindow {
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

/**
 * Slice `content` down to what the prompt shows: the whole file when small,
 * otherwise ±`WINDOW_LINES` around the finding's line anchor (snapped to line
 * boundaries), or the head when there is no anchor. Pure, so the windowing is
 * unit-testable; the caller reads the file.
 */
export function buildFileWindow(
  content: string,
  lineStart: number,
  lineEnd: number,
): FileWindow {
  const lines = content.split("\n");
  if (Buffer.byteLength(content, "utf8") <= MAX_WHOLE_FILE_BYTES) {
    return { content, startLine: 1, endLine: lines.length, truncated: false };
  }
  const anchorStart = Math.min(lineStart, lineEnd || lineStart);
  // A stale anchor past the current EOF (the PR head moved since the review)
  // would invert the window (`from > to`, empty content) — treat it as
  // anchorless and fall back to the head window instead.
  const anchored =
    (lineStart > 0 || lineEnd > 0) && anchorStart - WINDOW_LINES <= lines.length;
  const from = anchored ? Math.max(1, anchorStart - WINDOW_LINES) : 1;
  const to = anchored
    ? Math.min(lines.length, Math.max(lineStart, lineEnd) + WINDOW_LINES)
    : Math.min(lines.length, HEAD_LINES);
  return {
    content: lines.slice(from - 1, to).join("\n"),
    startLine: from,
    endLine: to,
    truncated: from > 1 || to < lines.length,
  };
}

export function buildFixSystemPrompt(): string {
  return [
    "You are the fix agent for an AI pre-review tool. A finding on a pull request",
    "was validated by a skeptic and ranked by a judge; it now needs a minimal code",
    "fix. Produce that fix as exact search/replace edits — the tool applies them",
    "and generates the patch itself, so you never write a diff.",
    "",
    "Rules:",
    "  - Make the SMALLEST change that resolves the finding. Do not refactor,",
    "    reformat, or touch unrelated code.",
    "  - Only edit files changed by this PR (the file shown, or another file the",
    "    PR changed if the finding requires it).",
    "  - Each `search` string must be copied BYTE-EXACT from the CURRENT FILE",
    "    CONTENT section — same whitespace, same indentation, same line breaks —",
    "    and must occur exactly once in the file. Include enough surrounding",
    "    lines to make it unique.",
    "  - `replace` is the full replacement for the searched text. An empty",
    "    `replace` deletes it.",
    "  - Match the file's existing style and conventions. Do not invent APIs,",
    "    imports, or helpers you cannot see.",
    "  - If no safe minimal fix is possible (the fix needs unseen code, a design",
    "    decision, or a file outside the PR), return an empty `edits` array and",
    "    explain why in `needs_manual_review`.",
    "  - Use `needs_manual_review` also for follow-ups a human should still do",
    "    (e.g. \"add a regression test for X\"). Set it to null when there are none.",
    "",
    "Respond with ONLY this JSON object, nothing else:",
    "{",
    '  "edits": [{ "path": string, "search": string, "replace": string }],',
    '  "summary": string,',
    '  "needs_manual_review": string | null',
    "}",
  ].join("\n");
}

export function buildFixUserPrompt(ctx: FixPromptContext): string {
  const { finding, fileWindow } = ctx;
  const windowNote = fileWindow.truncated
    ? ` (showing lines ${fileWindow.startLine}-${fileWindow.endLine} of a larger file — decline if the code you need is not visible)`
    : "";
  return [
    "----- FINDING TO FIX -----",
    renderCluster(finding),
    `Judge: ${finding.final_classification} — ${finding.judge_reasoning}`,
    "",
    "----- PR DIFF FOR THIS FILE -----",
    ctx.diffPatch !== null ? fence(ctx.diffPatch, "diff") : "(diff unavailable)",
    "",
    "----- CURRENT FILE CONTENT (copy `search` strings byte-exact from here) -----",
    `File: ${finding.file ?? "(none)"}${windowNote}`,
    fence(ctx.fileContent),
    "",
    "Produce the minimal fix and return it as the JSON object.",
  ].join("\n");
}
