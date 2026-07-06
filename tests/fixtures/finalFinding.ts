import type { FinalFinding } from "../../src/findings/schema.js";

/**
 * A schema-complete `FinalFinding` for fix-mode tests: fixable by default
 * (needs_code_change + should_fix classification). Override per test.
 */
export function makeFinalFinding(overrides: Partial<FinalFinding> = {}): FinalFinding {
  return {
    cluster_id: "cluster-001",
    merged_title: "off-by-one in range check",
    source_finding_ids: ["a-001"],
    source_agents: ["a"],
    agreement: 1,
    category: "correctness",
    severity: "high",
    confidence: 0.8,
    human_review_likelihood: 0.7,
    file: "src/a.ts",
    line_start: 2,
    line_end: 2,
    claim: "the loop drops the last element",
    evidence: ["`for (i < n - 1)` skips index n-1"],
    suggested_fix: "use `i < n`",
    suggested_test: null,
    needs_code_change: true,
    final_classification: "should_fix_before_review",
    final_score: 0.8,
    judge_reasoning: "a reviewer would raise this",
    skeptic_support_level: "strong",
    ...overrides,
  };
}
