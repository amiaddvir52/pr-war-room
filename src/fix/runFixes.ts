import { resolve } from "node:path";
import { createFixer, createMockFixer, type Fixer } from "../agents/FixAgent.js";
import { buildFileWindow, type FixPromptContext } from "../agents/prompts/fixPrompt.js";
import type { Config } from "../config/types.js";
import { FixAgentError, ReviewerTimeoutError } from "../errors.js";
import type { ChangedFilesArtifact } from "../github/schema.js";
import type { FinalFinding } from "../findings/schema.js";
import type { Reporter } from "../ui/reporter.js";
import { readUtf8File } from "../util/readUtf8File.js";
import { TIMEOUT_GRACE_MS, withTimeout } from "../util/withTimeout.js";
import { applyFixEdits, type AppliedEdit } from "./applyFixEdits.js";
import type { FixFailureKind, FixFindingOutcome, FixProposal } from "./schema.js";

/**
 * Phase 11 orchestration. Unlike the reviewer/skeptic/judge fan-outs this runs
 * SEQUENTIALLY: each finding's applied edits change the workspace, and the next
 * finding's prompt must show the post-edit file content so its byte-exact
 * `search` strings match what is actually on disk. `fix.maxFindings` bounds the
 * total latency.
 *
 * Failure policy mirrors the judge's recall-first stance: a finding whose fix
 * fails (model error, timeout, unapplyable edits) is RECORDED and skipped —
 * never aborts the run. Even a fixer construction failure only marks every
 * finding failed; the command still writes its report.
 */

export interface RunFixesInput {
  /** The selected fixable findings, in priority order (already capped). */
  findings: FinalFinding[];
  /** The workspace checkout edits are applied to. */
  repoDir: string;
  /** The PR's changed files — the path allowlist and per-file diff hunks. */
  changedFiles: ChangedFilesArtifact;
  config: Config;
  reporter: Reporter;
  /** Injected in tests to avoid the network; only called for non-`mock` backends. */
  makeFixer?: (config: Config) => Fixer;
}

export interface RunFixesResult {
  outcomes: FixFindingOutcome[];
  /** True when at least one finding's edits were applied to the workspace. */
  anyApplied: boolean;
}

export type RunFixes = (input: RunFixesInput) => Promise<RunFixesResult>;

interface Failure {
  kind: FixFailureKind;
  message: string;
}

/** Classify a thrown fixer error into a recorded failure (no message matching). */
function classifyFailure(err: unknown): Failure {
  if (err instanceof ReviewerTimeoutError) return { kind: "timeout", message: err.message };
  if (err instanceof FixAgentError) return { kind: err.kind, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  // A non-fixer Error is an unexpected (likely programming) failure: record it
  // loudly rather than disguising it as a benign infra hiccup.
  return { kind: "unexpected", message };
}

function toOutcome(
  finding: FinalFinding,
  status: FixFindingOutcome["status"],
  proposal: FixProposal | null,
  editsApplied: number,
  failure: Failure | null,
): FixFindingOutcome {
  return {
    cluster_id: finding.cluster_id,
    title: finding.merged_title,
    file: finding.file,
    classification: finding.final_classification,
    final_score: finding.final_score,
    status,
    summary: proposal?.summary ?? null,
    needs_manual_review: proposal?.needs_manual_review ?? null,
    edits_applied: editsApplied,
    failure,
  };
}

export const runFixes: RunFixes = async (input) => {
  const { findings, repoDir, changedFiles, config, reporter } = input;
  if (findings.length === 0) return { outcomes: [], anyApplied: false };

  // The MVP safety guard: the fix agent may only touch files this PR changed
  // (and that still exist on the PR head).
  const allowedPaths: ReadonlySet<string> = new Set(
    changedFiles.files.filter((f) => f.status !== "removed").map((f) => f.filename),
  );
  const diffFor = (file: string): string | null =>
    changedFiles.files.find((f) => f.filename === file)?.patch ?? null;

  // Build the fixer once, up front. `mock` gets the deterministic offline fixer
  // (no model client); a construction failure must NOT abort the run — every
  // finding records it and the command still produces its report.
  let fixer: Fixer | null = null;
  let constructionFailure: Failure | null = null;
  if (config.fix.backend === "mock") {
    fixer = createMockFixer();
  } else {
    try {
      fixer = (input.makeFixer ?? createFixer)(config);
    } catch (err) {
      constructionFailure = {
        kind: "construction_error",
        message: err instanceof Error ? err.message : String(err),
      };
      reporter.warn(
        `Fix agent could not be constructed (${constructionFailure.message}); no fixes will be generated.`,
      );
    }
  }

  // Line-shift ledger: an applied fix moves the code below it, so later
  // findings' review-time line anchors in the same file must be shifted to the
  // file's CURRENT coordinates (shifts compose exactly when applied in the
  // order the edits happened).
  const lineShifts = new Map<string, { line: number; delta: number }[]>();
  const shiftLine = (file: string, line: number): number => {
    let shifted = line;
    for (const s of lineShifts.get(file) ?? []) {
      if (s.line <= shifted) shifted = Math.max(s.line, shifted + s.delta);
    }
    return shifted;
  };
  const recordShifts = (applied: AppliedEdit[]): void => {
    for (const e of applied) {
      if (e.lineDelta === 0) continue;
      const list = lineShifts.get(e.path) ?? [];
      list.push({ line: e.line, delta: e.lineDelta });
      lineShifts.set(e.path, list);
    }
  };

  const board = reporter.board(
    findings.map((f) => ({ key: f.cluster_id, label: f.merged_title })),
  );
  const outcomes: FixFindingOutcome[] = [];
  try {
    for (const finding of findings) {
      board.set(finding.cluster_id, "running");
      const outcome = await fixOne(finding, fixer, constructionFailure, {
        repoDir,
        allowedPaths,
        diffFor,
        config,
        reporter,
        shiftLine,
        recordShifts,
      });
      outcomes.push(outcome);
      board.set(
        finding.cluster_id,
        outcome.status === "fixed" ? "ok" : outcome.status === "skipped" ? "skipped" : "fail",
        outcome.status === "fixed"
          ? `${outcome.edits_applied} edit${outcome.edits_applied === 1 ? "" : "s"} applied`
          : (outcome.failure?.kind ?? ""),
      );
    }
  } finally {
    board.stop();
  }

  return { outcomes, anyApplied: outcomes.some((o) => o.status === "fixed") };
};

interface FixOneDeps {
  repoDir: string;
  allowedPaths: ReadonlySet<string>;
  diffFor: (file: string) => string | null;
  config: Config;
  reporter: Reporter;
  /** Map a review-time line anchor to the file's current (post-earlier-fixes) coordinates. */
  shiftLine: (file: string, line: number) => number;
  /** Record where a successful proposal's edits landed, for later findings' anchors. */
  recordShifts: (applied: AppliedEdit[]) => void;
}

async function fixOne(
  finding: FinalFinding,
  fixer: Fixer | null,
  constructionFailure: Failure | null,
  deps: FixOneDeps,
): Promise<FixFindingOutcome> {
  if (fixer === null) {
    // Construction failed earlier; recorded per finding so the report is explicit.
    return toOutcome(finding, "failed", null, 0, constructionFailure);
  }

  if (finding.file === null) {
    return toOutcome(finding, "skipped", null, 0, {
      kind: "no_file",
      message: "file-level finding with no file to patch",
    });
  }
  // Pre-check the finding's own file so an out-of-changeset finding fails fast
  // without spending a model call (its edits would be rejected anyway).
  if (!deps.allowedPaths.has(finding.file)) {
    return toOutcome(finding, "failed", null, 0, {
      kind: "path_not_in_changeset",
      message: `"${finding.file}" is not a file this PR changed`,
    });
  }

  // Read the CURRENT content (post any earlier findings' edits) — the exact
  // bytes the model's `search` strings must match.
  let content: string;
  try {
    const read = await readUtf8File(resolve(deps.repoDir, finding.file));
    if (read === null) {
      return toOutcome(finding, "failed", null, 0, {
        kind: "file_not_utf8",
        message: `${finding.file} is not valid UTF-8 (binary or legacy encoding) — editing it would corrupt it`,
      });
    }
    content = read;
  } catch (err) {
    return toOutcome(finding, "failed", null, 0, {
      kind: "file_unreadable",
      message: `cannot read ${finding.file} in the workspace: ${(err as Error).message}`,
    });
  }

  // Earlier fixes in this run may have moved the code below them — shift the
  // review-time line anchors into the file's CURRENT coordinates before
  // windowing, so the window (and the mock fixer's index) stay on target.
  const lineStart =
    finding.line_start > 0 ? deps.shiftLine(finding.file, finding.line_start) : finding.line_start;
  const lineEnd =
    finding.line_end > 0 ? deps.shiftLine(finding.file, finding.line_end) : finding.line_end;
  const anchored: FinalFinding =
    lineStart === finding.line_start && lineEnd === finding.line_end
      ? finding
      : { ...finding, line_start: lineStart, line_end: lineEnd };

  const window = buildFileWindow(content, lineStart, lineEnd);
  const ctx: FixPromptContext = {
    finding: anchored,
    fileContent: window.content,
    fileWindow: {
      startLine: window.startLine,
      endLine: window.endLine,
      truncated: window.truncated,
    },
    diffPatch: deps.diffFor(finding.file),
  };

  let proposal: FixProposal;
  try {
    proposal = await withTimeout(fixer(ctx), deps.config.fix.timeoutMs + TIMEOUT_GRACE_MS);
  } catch (err) {
    const failure = classifyFailure(err);
    if (failure.kind === "unexpected") {
      deps.reporter.warn(
        `Unexpected fix-agent error on "${finding.merged_title}": ${failure.message}`,
      );
    }
    return toOutcome(finding, "failed", null, 0, failure);
  }

  if (proposal.edits.length === 0) {
    // The model's explicit choice — keep its summary/manual-review notes.
    return toOutcome(finding, "skipped", proposal, 0, {
      kind: "declined",
      message: proposal.needs_manual_review ?? "the model proposed no edits",
    });
  }

  const applied = await applyFixEdits(proposal.edits, deps.repoDir, deps.allowedPaths);
  if (!applied.ok) {
    return toOutcome(finding, "failed", proposal, 0, {
      kind: applied.kind,
      message: applied.message,
    });
  }
  deps.recordShifts(applied.appliedEdits);
  return toOutcome(finding, "fixed", proposal, applied.editsApplied, null);
}
