import { describe, it, expect } from "vitest";
import {
  computePriorityScore,
  deterministicClassification,
  isWellSupported,
  selectFinalFindings,
  shouldProtectFromDrop,
} from "../../src/findings/scoreFindings.js";
import type {
  FindingCluster,
  FindingSeverity,
  JudgeResult,
  SkepticResult,
  SupportLevel,
} from "../../src/findings/schema.js";

function cluster(overrides: Partial<FindingCluster> = {}): FindingCluster {
  return {
    cluster_id: "cluster-001",
    merged_title: "a finding",
    source_finding_ids: ["a-001"],
    source_agents: ["a"],
    agreement: 1,
    category: "correctness",
    severity: "medium",
    confidence: 0.6,
    human_review_likelihood: 0.5,
    file: "src/a.ts",
    line_start: 10,
    line_end: 12,
    claim: "a real, actionable claim",
    evidence: ["concrete evidence"],
    suggested_fix: null,
    suggested_test: null,
    needs_code_change: true,
    ...overrides,
  };
}

/** A skeptic result carrying a model verdict with the given support/risk. */
function skepticWith(
  support: SupportLevel,
  risk: "low" | "medium" | "high" = "low",
  action: "keep" | "downgrade" = "keep",
): SkepticResult {
  return {
    cluster_id: "cluster-001",
    source: "llm",
    checks: {
      hard_failures: [],
      soft_warnings: [],
      signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: true, line_near_diff: true },
      notes: [],
    },
    model_verdict: {
      is_supported: support !== "unsupported",
      support_level: support,
      false_positive_risk: risk,
      reasoning_summary: "…",
      recommended_action: action,
    },
    decision: { action, reason: "…", softened_from_model_action: null },
    failure: null,
    attempts: 1,
  };
}

/** A skeptic result with no model verdict (mock/deterministic path). */
function skepticDeterministic(action: "keep" | "downgrade"): SkepticResult {
  return {
    cluster_id: "cluster-001",
    source: "deterministic",
    checks: {
      hard_failures: [],
      soft_warnings: [],
      signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: true, line_near_diff: true },
      notes: [],
    },
    model_verdict: null,
    decision: { action, reason: "…", softened_from_model_action: null },
    failure: null,
    attempts: 1,
  };
}

describe("computePriorityScore", () => {
  it("stays within [0, 1]", () => {
    const min = computePriorityScore(
      cluster({ severity: "info", confidence: 0, human_review_likelihood: 0, agreement: 1 }),
      skepticWith("unsupported", "high"),
    );
    const max = computePriorityScore(
      cluster({ severity: "blocker", confidence: 1, human_review_likelihood: 1, agreement: 5 }),
      skepticWith("strong", "low"),
    );
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeGreaterThan(min);
  });

  it("increases with severity, all else equal", () => {
    const severities: FindingSeverity[] = ["info", "low", "medium", "high", "blocker"];
    const scores = severities.map((severity) => computePriorityScore(cluster({ severity }), null));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
    }
  });

  it("rewards independent-reviewer agreement", () => {
    const solo = computePriorityScore(cluster({ agreement: 1 }), null);
    const agreed = computePriorityScore(cluster({ agreement: 3 }), null);
    expect(agreed).toBeGreaterThan(solo);
  });

  it("rewards a stronger skeptic support level", () => {
    const weak = computePriorityScore(cluster(), skepticWith("weak"));
    const strong = computePriorityScore(cluster(), skepticWith("strong"));
    expect(strong).toBeGreaterThan(weak);
  });

  it("penalizes a high false-positive risk", () => {
    const lowRisk = computePriorityScore(cluster(), skepticWith("strong", "low"));
    const highRisk = computePriorityScore(cluster(), skepticWith("strong", "high"));
    expect(highRisk).toBeLessThan(lowRisk);
  });

  it("is deterministic (same inputs → same score)", () => {
    const c = cluster({ severity: "high", agreement: 2 });
    expect(computePriorityScore(c, skepticWith("medium"))).toBe(
      computePriorityScore(c, skepticWith("medium")),
    );
  });
});

describe("deterministicClassification", () => {
  it("maps severity to a bucket and never drops (recall-first)", () => {
    expect(deterministicClassification(cluster({ severity: "blocker" }), null)).toBe("blocker");
    expect(deterministicClassification(cluster({ severity: "high" }), null)).toBe(
      "should_fix_before_review",
    );
    expect(deterministicClassification(cluster({ severity: "low" }), null)).toBe("nice_to_have");
    expect(deterministicClassification(cluster({ severity: "info" }), null)).toBe("nice_to_have");
  });

  it("promotes a well-supported medium finding to should-fix, else nice-to-have", () => {
    expect(deterministicClassification(cluster({ severity: "medium" }), skepticWith("strong"))).toBe(
      "should_fix_before_review",
    );
    expect(
      deterministicClassification(cluster({ severity: "medium" }), skepticWith("weak")),
    ).toBe("nice_to_have");
    // No skeptic verdict at all → not "well supported" → nice-to-have.
    expect(deterministicClassification(cluster({ severity: "medium" }), null)).toBe("nice_to_have");
  });
});

describe("isWellSupported", () => {
  it("uses the model support level when present", () => {
    expect(isWellSupported(skepticWith("strong"))).toBe(true);
    expect(isWellSupported(skepticWith("medium"))).toBe(true);
    expect(isWellSupported(skepticWith("weak"))).toBe(false);
    expect(isWellSupported(skepticWith("unsupported"))).toBe(false);
  });

  it("falls back to the kept/downgraded decision when there is no model verdict", () => {
    expect(isWellSupported(skepticDeterministic("keep"))).toBe(true);
    expect(isWellSupported(skepticDeterministic("downgrade"))).toBe(false);
    expect(isWellSupported(null)).toBe(false);
  });
});

describe("shouldProtectFromDrop", () => {
  it("protects high-severity findings that are supported or multiply-reported", () => {
    expect(shouldProtectFromDrop(cluster({ severity: "high" }), skepticWith("strong"))).toBe(true);
    expect(shouldProtectFromDrop(cluster({ severity: "blocker", agreement: 2 }), null)).toBe(true);
  });

  it("does not protect low-severity or weakly-supported single findings", () => {
    expect(shouldProtectFromDrop(cluster({ severity: "low" }), skepticWith("strong"))).toBe(false);
    expect(shouldProtectFromDrop(cluster({ severity: "high", agreement: 1 }), skepticWith("weak"))).toBe(
      false,
    );
  });
});

describe("selectFinalFindings", () => {
  const ranked = (
    id: string,
    classification: JudgeResult["decision"]["classification"],
    score: number,
  ): JudgeResult => ({
    cluster_id: id,
    source: "llm",
    model_verdict: { final_classification: classification, model_score: score, reasoning_summary: "…" },
    decision: {
      classification,
      score,
      include_in_main_report: classification !== "drop",
      reason: "…",
      softened_from_model_classification: null,
    },
    failure: null,
    attempts: 1,
  });

  it("excludes dropped clusters and orders by classification then score", () => {
    const clusters = [
      cluster({ cluster_id: "cluster-001" }),
      cluster({ cluster_id: "cluster-002" }),
      cluster({ cluster_id: "cluster-003" }),
      cluster({ cluster_id: "cluster-004" }),
    ];
    const results = [
      ranked("cluster-001", "nice_to_have", 0.4),
      ranked("cluster-002", "blocker", 0.9),
      ranked("cluster-003", "drop", 0.1), // excluded
      ranked("cluster-004", "should_fix_before_review", 0.7),
    ];
    const final = selectFinalFindings(clusters, results, []);
    expect(final.map((f) => f.cluster_id)).toEqual(["cluster-002", "cluster-004", "cluster-001"]);
    expect(final.every((f) => f.final_classification !== "drop")).toBe(true);
    // The joined FinalFinding carries the judge fields alongside the cluster's.
    expect(final[0]?.final_classification).toBe("blocker");
    expect(final[0]?.final_score).toBe(0.9);
    expect(final[0]?.claim).toBe("a real, actionable claim");
  });

  it("orders by score within the same classification", () => {
    const clusters = [cluster({ cluster_id: "cluster-001" }), cluster({ cluster_id: "cluster-002" })];
    const results = [
      ranked("cluster-001", "should_fix_before_review", 0.5),
      ranked("cluster-002", "should_fix_before_review", 0.8),
    ];
    const final = selectFinalFindings(clusters, results, []);
    expect(final.map((f) => f.cluster_id)).toEqual(["cluster-002", "cluster-001"]);
  });

  it("attaches the skeptic support level when available", () => {
    const clusters = [cluster({ cluster_id: "cluster-001" })];
    const results = [ranked("cluster-001", "blocker", 0.9)];
    const skeptic: SkepticResult = { ...skepticWith("strong"), cluster_id: "cluster-001" };
    const final = selectFinalFindings(clusters, results, [skeptic]);
    expect(final[0]?.skeptic_support_level).toBe("strong");
  });
});
