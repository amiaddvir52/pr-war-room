import type { FinalFinding } from "../findings/schema.js";

export interface FixableSelection {
  /** All findings matching the fixable filter, in priority order. */
  fixable: FinalFinding[];
  /** The head of `fixable`, capped at `maxFindings` — what fix mode attempts. */
  selected: FinalFinding[];
}

/**
 * Pick the findings fix mode attempts (PRD Phase 11): a finding is fixable when
 * it needs a code change AND the judge classified it blocker or
 * should-fix-before-review. `final_findings.json` is already sorted
 * blocker-first, score-descending (see `selectFinalFindings`), so slicing the
 * head takes the highest-priority findings first.
 */
export function selectFixableFindings(
  final: FinalFinding[],
  maxFindings: number,
): FixableSelection {
  const fixable = final.filter(
    (f) =>
      f.needs_code_change &&
      (f.final_classification === "blocker" ||
        f.final_classification === "should_fix_before_review"),
  );
  return { fixable, selected: fixable.slice(0, maxFindings) };
}
