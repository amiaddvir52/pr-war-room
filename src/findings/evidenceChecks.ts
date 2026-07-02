import type { PacketChangedFile, ReviewPacket } from "../context/types.js";
import { parseHunkNewRanges } from "../context/hunkRanges.js";
import type { EvidenceChecks, EvidenceIssue, FindingCluster } from "./schema.js";

/**
 * Deterministic (no-LLM) evidence checks for the skeptic (Phase 8, PRD §10.7).
 * Pure functions over a cluster and the review packet — no IO, no model calls —
 * so they are fully unit-testable and run for every cluster regardless of the
 * skeptic backend.
 *
 * The checks are split by consequence, matching the recall-first policy:
 *   - HARD failures are objective, out-of-scope problems (the referenced file is
 *     not in the changeset at all). These may drop a finding without the model.
 *   - SOFT warnings are weak-anchoring signals (line outside the diff window,
 *     partial/inverted anchor). These downgrade/annotate but NEVER drop; the
 *     skeptic model already receives them and can weigh them itself.
 *
 * The packet's changed-file diffs are the only ground truth we have here (we do
 * not have the whole checked-out tree), so an off-window line is treated as
 * "unproven", i.e. a soft warning — not a proof the finding is wrong.
 */

/** Fallback nearby-window when a caller has no configured value. */
export const DEFAULT_NEARBY_WINDOW = 20;

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Find the changed file a cluster points at, matching path or rename source. */
export function findChangedFile(file: string, packet: ReviewPacket): PacketChangedFile | undefined {
  return packet.changedFiles.find((f) => f.path === file || f.previousPath === file);
}

/** A normalized line anchor. See `normalizeAnchor`. */
export interface NormalizedAnchor {
  /** The finding carries a usable (positive) line anchor. */
  hasAnchor: boolean;
  start: number;
  end: number;
  /** Exactly one of line_start/line_end was set; normalized to the present one. */
  partial: boolean;
  /** line_end < line_start; normalized to a single line. */
  inverted: boolean;
}

/**
 * Normalize a cluster's `(line_start, line_end)` into a usable range, never
 * validating against the impossible line 0:
 *   - `(0, 0)`        → no anchor (a file-level / line-less finding).
 *   - `(0, N)`/`(N, 0)` → partial anchor: use the present bound for both.
 *   - `line_end < line_start` → inverted: collapse to a single line at start.
 */
export function normalizeAnchor(lineStart: number, lineEnd: number): NormalizedAnchor {
  const s = lineStart > 0 ? lineStart : 0;
  const e = lineEnd > 0 ? lineEnd : 0;
  if (s === 0 && e === 0) return { hasAnchor: false, start: 0, end: 0, partial: false, inverted: false };
  if (s === 0 || e === 0) {
    const v = s || e;
    return { hasAnchor: true, start: v, end: v, partial: true, inverted: false };
  }
  if (e < s) return { hasAnchor: true, start: s, end: s, partial: false, inverted: true };
  return { hasAnchor: true, start: s, end: e, partial: false, inverted: false };
}

/**
 * Run the deterministic evidence checks for one cluster. `nearbyWindow` is the
 * line slack around a hunk still counted as "near the change" — pass
 * `config.context.nearbyContextLines` so the gate matches the code the reviewer
 * was actually shown, instead of a hardcoded constant.
 */
export function runEvidenceChecks(
  cluster: FindingCluster,
  packet: ReviewPacket,
  nearbyWindow: number = DEFAULT_NEARBY_WINDOW,
): EvidenceChecks {
  const notes: string[] = [];
  const hardFailures: EvidenceIssue[] = [];
  const softWarnings: EvidenceIssue[] = [];

  // File-level finding: no file to anchor. Nothing to disprove deterministically.
  if (cluster.file === null) {
    notes.push("File-level finding; file/line anchoring checks are not applicable.");
    return {
      hard_failures: hardFailures,
      soft_warnings: softWarnings,
      signals: { file_in_changeset: true, has_line_anchor: false, line_in_diff: null, line_near_diff: null },
      notes,
    };
  }

  const changed = findChangedFile(cluster.file, packet);
  if (changed === undefined) {
    hardFailures.push({
      code: "file_not_in_changeset",
      message: `Referenced file "${cluster.file}" is not among the PR's changed files.`,
    });
    notes.push(`Referenced file "${cluster.file}" is not among the PR's changed files.`);
    return {
      hard_failures: hardFailures,
      soft_warnings: softWarnings,
      signals: { file_in_changeset: false, has_line_anchor: false, line_in_diff: null, line_near_diff: null },
      notes,
    };
  }
  notes.push(`File "${cluster.file}" is part of the changeset (status: ${changed.status}).`);

  const anchor = normalizeAnchor(cluster.line_start, cluster.line_end);
  if (anchor.partial) {
    softWarnings.push({
      code: "partial_anchor",
      message: `Only one line bound was provided; treating the finding as anchored at line ${anchor.start}.`,
    });
    notes.push(`Partial line anchor normalized to line ${anchor.start}.`);
  }
  if (anchor.inverted) {
    softWarnings.push({
      code: "inverted_anchor",
      message: `line_end < line_start; treating the finding as a single line at ${anchor.start}.`,
    });
    notes.push(`Inverted line anchor normalized to line ${anchor.start}.`);
  }

  // Line-less finding: the file is in the changeset and that is all we can check.
  // A missing line anchor is never a reason to drop (recall-first).
  if (!anchor.hasAnchor) {
    notes.push("Finding is file-level (no line range); line/diff checks skipped.");
    return {
      hard_failures: hardFailures,
      soft_warnings: softWarnings,
      signals: { file_in_changeset: true, has_line_anchor: false, line_in_diff: null, line_near_diff: null },
      notes,
    };
  }

  // No patch to inspect (binary / omitted / trimmed for size): we cannot
  // evaluate the line, so we leave the signals unknown (null) and do not warn.
  if (changed.patchOmitted || changed.patch === null) {
    notes.push("Patch unavailable for this file; line and diff-overlap checks skipped.");
    return {
      hard_failures: hardFailures,
      soft_warnings: softWarnings,
      signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: null, line_near_diff: null },
      notes,
    };
  }

  const hunks = parseHunkNewRanges(changed.patch, { keepEmpty: true });
  if (hunks.length === 0) {
    notes.push("No parseable hunks in the patch; line and diff-overlap checks skipped.");
    return {
      hard_failures: hardFailures,
      soft_warnings: softWarnings,
      signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: null, line_near_diff: null },
      notes,
    };
  }

  const range: [number, number] = [anchor.start, anchor.end];
  const inDiff = hunks.some((h) => overlaps(range, h));
  const nearby = hunks.some((h) => overlaps(range, [h[0] - nearbyWindow, h[1] + nearbyWindow]));

  notes.push(
    inDiff
      ? `Lines ${anchor.start}-${anchor.end} overlap the changed hunks.`
      : nearby
        ? `Lines ${anchor.start}-${anchor.end} are near (within ${nearbyWindow} lines of) the changed hunks but not inside them.`
        : `Lines ${anchor.start}-${anchor.end} are outside the changed hunks and their surrounding context.`,
  );

  // Off-window is a SOFT warning (weak anchoring), not a hard drop: with only the
  // diff as ground truth we cannot prove the line is wrong, and the model may
  // still recognise a real issue the reviewer anchored imperfectly.
  if (!nearby) {
    softWarnings.push({
      code: "line_outside_diff",
      message: `Lines ${anchor.start}-${anchor.end} are outside the changed hunks and their ${nearbyWindow}-line context; the finding may be mis-anchored.`,
    });
  }

  return {
    hard_failures: hardFailures,
    soft_warnings: softWarnings,
    signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: inDiff, line_near_diff: nearby },
    notes,
  };
}

/**
 * A hard, deterministic failure that may drop a finding without model support:
 * the cluster references a file that is not part of the PR at all (objectively
 * out of scope, §10.7). Weak anchoring is deliberately NOT a hard failure —
 * see `runEvidenceChecks`.
 */
export function hasHardFailure(checks: EvidenceChecks): boolean {
  return checks.hard_failures.length > 0;
}
