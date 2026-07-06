import { describe, it, expect } from "vitest";
import {
  adaptiveClusterTimeoutMs,
  MAX_TIMEOUT_SCALE,
  TIMEOUT_SCALE_PER_MEMBER,
} from "../../src/agents/clusterTimeout.js";
import type { FindingCluster } from "../../src/findings/schema.js";

function clusterOf(memberCount: number): FindingCluster {
  return {
    cluster_id: "cluster-001",
    merged_title: "t",
    source_finding_ids: Array.from({ length: memberCount }, (_, i) => `a-${i}`),
    source_agents: ["a"],
    agreement: 1,
    category: "correctness",
    severity: "medium",
    confidence: 0.5,
    human_review_likelihood: 0.5,
    file: "src/a.ts",
    line_start: 1,
    line_end: 2,
    claim: "c",
    evidence: ["e"],
    suggested_fix: null,
    suggested_test: null,
    needs_code_change: false,
  };
}

describe("adaptiveClusterTimeoutMs", () => {
  it("gives a singleton the base timeout", () => {
    expect(adaptiveClusterTimeoutMs(90_000, clusterOf(1))).toBe(90_000);
  });

  it("scales linearly with additional members", () => {
    expect(adaptiveClusterTimeoutMs(90_000, clusterOf(2))).toBe(
      Math.round(90_000 * (1 + TIMEOUT_SCALE_PER_MEMBER)),
    );
    expect(adaptiveClusterTimeoutMs(90_000, clusterOf(6))).toBe(
      Math.round(90_000 * (1 + 5 * TIMEOUT_SCALE_PER_MEMBER)),
    );
  });

  it("caps at MAX_TIMEOUT_SCALE for very large clusters (demo's 27-member case)", () => {
    expect(adaptiveClusterTimeoutMs(90_000, clusterOf(27))).toBe(90_000 * MAX_TIMEOUT_SCALE);
    expect(adaptiveClusterTimeoutMs(90_000, clusterOf(100))).toBe(90_000 * MAX_TIMEOUT_SCALE);
  });
});
