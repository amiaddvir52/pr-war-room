import { describe, it, expect, vi } from "vitest";
import { reconcileJudge, runJudge } from "../../src/agents/runJudge.js";
import type { Judge } from "../../src/agents/JudgeAgent.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import type { Config } from "../../src/config/schema.js";
import type { FindingCluster, JudgeVerdict, SkepticResult } from "../../src/findings/schema.js";
import { silentReporter } from "../../src/ui/reporter.js";
import { ReviewerTimeoutError } from "../../src/errors.js";
import { makeReviewPacket } from "../fixtures/reviewPacket.js";

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

function verdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    final_classification: "should_fix_before_review",
    model_score: 0.8,
    reasoning_summary: "reviewers would raise this",
    ...overrides,
  };
}

/** A skeptic result carrying a strong model verdict (well-supported). */
function strongSkeptic(clusterId = "cluster-001"): SkepticResult {
  return {
    cluster_id: clusterId,
    source: "llm",
    checks: {
      hard_failures: [],
      soft_warnings: [],
      signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: true, line_near_diff: true },
      notes: [],
    },
    model_verdict: {
      is_supported: true,
      support_level: "strong",
      false_positive_risk: "low",
      reasoning_summary: "supported",
      recommended_action: "keep",
    },
    decision: { action: "keep", reason: "supported", softened_from_model_action: null },
    failure: null,
    attempts: 1,
  };
}

describe("reconcileJudge", () => {
  it("takes the model classification when it does not drop", () => {
    const r = reconcileJudge(cluster(), strongSkeptic(), verdict({ final_classification: "blocker" }), null);
    expect(r.source).toBe("llm");
    expect(r.decision.classification).toBe("blocker");
    expect(r.decision.include_in_main_report).toBe(true);
    expect(r.decision.softened_from_model_classification).toBeNull();
    // model_score is preserved for audit; the score itself is deterministic.
    expect(r.model_verdict?.model_score).toBe(0.8);
    expect(r.decision.score).toBeGreaterThan(0);
    expect(r.decision.score).toBeLessThanOrEqual(1);
  });

  it("honours a model drop on a low-value finding", () => {
    const r = reconcileJudge(
      cluster({ severity: "low" }),
      null,
      verdict({ final_classification: "drop" }),
      null,
    );
    expect(r.decision.classification).toBe("drop");
    expect(r.decision.include_in_main_report).toBe(false);
    expect(r.decision.softened_from_model_classification).toBeNull();
  });

  it("softens a model drop on a well-supported high-severity finding to nice_to_have", () => {
    const r = reconcileJudge(
      cluster({ severity: "high" }),
      strongSkeptic(),
      verdict({ final_classification: "drop" }),
      null,
    );
    expect(r.decision.classification).toBe("nice_to_have");
    expect(r.decision.include_in_main_report).toBe(true);
    expect(r.decision.softened_from_model_classification).toBe("drop");
    // The raw verdict is preserved as-is; the record does not contradict itself.
    expect(r.model_verdict?.final_classification).toBe("drop");
  });

  it("softens a model drop on a multiply-reported high-severity finding even without a skeptic", () => {
    const r = reconcileJudge(
      cluster({ severity: "high", agreement: 2 }),
      null,
      verdict({ final_classification: "drop" }),
      null,
    );
    expect(r.decision.classification).toBe("nice_to_have");
    expect(r.decision.softened_from_model_classification).toBe("drop");
  });

  it("classifies deterministically on the mock path (no model verdict)", () => {
    const r = reconcileJudge(cluster({ severity: "blocker" }), strongSkeptic(), null, null);
    expect(r.source).toBe("deterministic");
    expect(r.decision.classification).toBe("blocker");
    expect(r.model_verdict).toBeNull();
  });

  it("keeps (fallback) with the failure recorded and never drops", () => {
    const r = reconcileJudge(
      cluster({ severity: "high" }),
      strongSkeptic(),
      null,
      { kind: "timeout", message: "t" },
    );
    expect(r.source).toBe("fallback");
    expect(r.decision.classification).toBe("should_fix_before_review");
    expect(r.decision.classification).not.toBe("drop");
    expect(r.failure).toEqual({ kind: "timeout", message: "t" });
  });
});

describe("runJudge", () => {
  const reporter = silentReporter();
  const withConfig = (overrides: Partial<Config["judge"]> = {}): Config => ({
    ...defaultConfig,
    judge: { ...defaultConfig.judge, ...overrides },
  });

  it("returns no results for zero clusters", async () => {
    const out = await runJudge({
      clusters: [],
      skepticResults: [],
      packet: makeReviewPacket(),
      config: defaultConfig,
      reporter,
    });
    expect(out.ranked).toEqual([]);
  });

  it("mock backend ranks deterministically with no model call", async () => {
    const clusters = [
      cluster({ cluster_id: "cluster-001", severity: "blocker" }),
      cluster({ cluster_id: "cluster-002", severity: "low" }),
    ];
    const { ranked } = await runJudge({
      clusters,
      skepticResults: [],
      packet: makeReviewPacket(),
      config: withConfig({ backend: "mock" }),
      reporter,
    });
    expect(ranked.every((r) => r.source === "deterministic")).toBe(true);
    expect(ranked.find((r) => r.cluster_id === "cluster-001")?.decision.classification).toBe("blocker");
    expect(ranked.find((r) => r.cluster_id === "cluster-002")?.decision.classification).toBe(
      "nice_to_have",
    );
  });

  it("uses an injected judge and records its verdict", async () => {
    const judge: Judge = async () => verdict({ final_classification: "blocker" });
    const { ranked } = await runJudge({
      clusters: [cluster()],
      skepticResults: [strongSkeptic()],
      packet: makeReviewPacket(),
      config: withConfig({ backend: "claude" }),
      reporter,
      makeJudge: () => judge,
    });
    expect(ranked[0]?.source).toBe("llm");
    expect(ranked[0]?.decision.classification).toBe("blocker");
    expect(ranked[0]?.model_verdict?.final_classification).toBe("blocker");
  });

  it("passes the matching skeptic result through to the judge", async () => {
    const seen: Array<SkepticResult | null> = [];
    const judge: Judge = async (_c, skeptic) => {
      seen.push(skeptic);
      return verdict();
    };
    await runJudge({
      clusters: [cluster({ cluster_id: "cluster-001" })],
      skepticResults: [strongSkeptic("cluster-001")],
      packet: makeReviewPacket(),
      config: withConfig({ backend: "claude" }),
      reporter,
      makeJudge: () => judge,
    });
    expect(seen[0]?.model_verdict?.support_level).toBe("strong");
  });

  it("keeps (with a recorded failure) when the judge throws", async () => {
    const judge: Judge = async () => {
      throw new Error("boom");
    };
    const { ranked } = await runJudge({
      clusters: [cluster({ severity: "high" })],
      skepticResults: [strongSkeptic()],
      packet: makeReviewPacket(),
      config: withConfig({ backend: "claude" }),
      reporter,
      makeJudge: () => judge,
    });
    expect(ranked[0]?.source).toBe("fallback");
    expect(ranked[0]?.failure?.kind).toBe("unexpected");
    expect(ranked[0]?.decision.classification).not.toBe("drop");
  });

  it("does not abort when the judge cannot be constructed — ranks all deterministically", async () => {
    const makeJudge = (): Judge => {
      throw new Error("missing credentials");
    };
    const { ranked } = await runJudge({
      clusters: [cluster({ cluster_id: "cluster-001" }), cluster({ cluster_id: "cluster-002" })],
      skepticResults: [],
      packet: makeReviewPacket(),
      config: withConfig({ backend: "claude" }),
      reporter,
      makeJudge,
    });
    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.source === "fallback")).toBe(true);
    expect(ranked.every((r) => r.failure?.kind === "construction_error")).toBe(true);
    expect(ranked.every((r) => r.decision.classification !== "drop")).toBe(true);
  });

  it("keeps the finding on a real timeout, via fake timers", async () => {
    vi.useFakeTimers();
    try {
      const hang: Judge = () => new Promise<JudgeVerdict>(() => {}); // never resolves
      // retries: 0 keeps this a single-attempt fallback test; retry behavior has
      // its own dedicated test below.
      const config = withConfig({ backend: "claude", timeoutMs: 1_000, retries: 0 });
      const promise = runJudge({
        clusters: [cluster()],
        skepticResults: [strongSkeptic()],
        packet: makeReviewPacket(),
        config,
        reporter,
        makeJudge: () => hang,
      });
      await vi.advanceTimersByTimeAsync(1_000 + 250 + 5);
      const { ranked } = await promise;
      expect(ranked[0]?.source).toBe("fallback");
      expect(ranked[0]?.failure?.kind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a judge that times out once, then uses the retry's verdict (attempts=2)", async () => {
    let calls = 0;
    const flaky: Judge = async () => {
      calls++;
      // First attempt times out; the retry classifies the finding.
      if (calls === 1) throw new ReviewerTimeoutError("timed out after 90000ms");
      return verdict({ final_classification: "blocker" });
    };
    const { ranked } = await runJudge({
      clusters: [cluster()],
      skepticResults: [strongSkeptic()],
      packet: makeReviewPacket(),
      config: withConfig({ backend: "claude", retries: 1 }),
      reporter: silentReporter(),
      makeJudge: () => flaky,
    });
    expect(calls).toBe(2);
    expect(ranked[0]?.source).toBe("llm"); // ranked by the retry, not the fallback
    expect(ranked[0]?.attempts).toBe(2);
    expect(ranked[0]?.failure).toBeNull();
    expect(ranked[0]?.decision.classification).toBe("blocker");
  });
});
