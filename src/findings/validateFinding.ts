import type { FindingCore, FindingSeverity } from "./schema.js";
import type { ReviewConfig } from "../config/schema.js";

/**
 * Post-parse validation and filtering (PRD §10.5 rules + §10.9 policy). The
 * structured-output schema and `FindingCoreSchema` already guarantee the shape
 * and value ranges; this step applies the semantic rules that a schema can't:
 * drop findings with no actionable claim, no real evidence, or missing line
 * numbers for a file-specific finding, then apply the config policy
 * (`includeNiceToHave`, `maxFindings`). Nothing here throws — filtering is data.
 */

export interface DroppedFinding {
  reason: string;
  finding: FindingCore;
}

export interface PartitionResult {
  valid: FindingCore[];
  dropped: DroppedFinding[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocker: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

const hasText = (s: string): boolean => s.trim().length > 0;

/**
 * Partition a reviewer's raw findings into those worth keeping and those
 * dropped (with a reason). Ordering of kept findings is by severity then
 * confidence, so the `maxFindings` cap keeps the most important ones.
 */
export function partitionFindings(cores: FindingCore[], review: ReviewConfig): PartitionResult {
  const dropped: DroppedFinding[] = [];
  const kept: FindingCore[] = [];

  for (const finding of cores) {
    // Rule 7 — no actionable claim.
    if (!hasText(finding.claim)) {
      dropped.push({ reason: "no actionable claim", finding });
      continue;
    }
    // Rule 3 — evidence must contain at least one real (non-empty) item.
    if (!finding.evidence.some(hasText)) {
      dropped.push({ reason: "no supporting evidence", finding });
      continue;
    }
    // Rule 4 — a finding that asks for a code change must at least name the
    // file it applies to (line numbers stay optional: many valid findings are
    // file-level, e.g. "no test covers this module").
    if (finding.needs_code_change && finding.file === null) {
      dropped.push({ reason: "code-change finding without a file reference", finding });
      continue;
    }
    // §10.9 policy — drop nice-to-have (info) findings unless opted in.
    if (!review.includeNiceToHave && finding.severity === "info") {
      dropped.push({ reason: "nice-to-have (info) excluded by config", finding });
      continue;
    }
    kept.push(finding);
  }

  // Most important first, so the cap keeps blockers over low-confidence nits.
  kept.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return bySeverity !== 0 ? bySeverity : b.confidence - a.confidence;
  });

  if (kept.length > review.maxFindings) {
    for (const finding of kept.splice(review.maxFindings)) {
      dropped.push({ reason: `exceeds maxFindings (${review.maxFindings})`, finding });
    }
  }

  return { valid: kept, dropped };
}
