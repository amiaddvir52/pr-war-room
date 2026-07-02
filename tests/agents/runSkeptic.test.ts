import { describe, it, expect, vi } from "vitest";
import {
  reconcileResult,
  selectSupportedClusters,
  runSkeptic,
} from "../../src/agents/runSkeptic.js";
import type { Skeptic } from "../../src/agents/SkepticAgent.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import type { Config } from "../../src/config/schema.js";
import type {
  EvidenceChecks,
  FindingCluster,
  SkepticVerdict,
} from "../../src/findings/schema.js";
import type { PacketChangedFile } from "../../src/context/types.js";
import { silentReporter } from "../../src/ui/reporter.js";
import { makeReviewPacket } from "../fixtures/reviewPacket.js";

const PASS: EvidenceChecks = {
  hard_failures: [],
  soft_warnings: [],
  signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: true, line_near_diff: true },
  notes: [],
};
const SOFT: EvidenceChecks = {
  hard_failures: [],
  soft_warnings: [{ code: "line_outside_diff", message: "off window" }],
  signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: false, line_near_diff: false },
  notes: [],
};
const HARD_FAIL: EvidenceChecks = {
  hard_failures: [{ code: "file_not_in_changeset", message: "file not in changeset" }],
  soft_warnings: [],
  signals: { file_in_changeset: false, has_line_anchor: false, line_in_diff: null, line_near_diff: null },
  notes: [],
};

function verdict(overrides: Partial<SkepticVerdict> = {}): SkepticVerdict {
  return {
    is_supported: true,
    support_level: "strong",
    false_positive_risk: "low",
    reasoning_summary: "supported",
    recommended_action: "keep",
    ...overrides,
  };
}

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
    line_start: 11,
    line_end: 12,
    claim: "a real, actionable claim",
    evidence: ["concrete evidence"],
    suggested_fix: null,
    suggested_test: null,
    needs_code_change: true,
    ...overrides,
  };
}

const changedFile = (overrides: Partial<PacketChangedFile> = {}): PacketChangedFile => ({
  path: "src/a.ts",
  status: "modified",
  previousPath: null,
  additions: 5,
  deletions: 2,
  patchOmitted: false,
  // A hunk covering new-file lines 10..14.
  patch: "@@ -10,5 +10,5 @@\n context\n-old\n+new\n context\n context",
  nearbyContext: null,
  ...overrides,
});

describe("reconcileResult", () => {
  it("drops (deterministically) on a hard failure, overriding the model", () => {
    const r = reconcileResult("cluster-001", HARD_FAIL, verdict({ recommended_action: "keep" }), null);
    expect(r.decision.action).toBe("drop");
    expect(r.source).toBe("deterministic");
    // The model verdict is still preserved for the audit trail.
    expect(r.model_verdict?.recommended_action).toBe("keep");
  });

  it("drops on a hard failure even when the skeptic also failed", () => {
    const r = reconcileResult("cluster-001", HARD_FAIL, null, { kind: "timeout", message: "t" });
    expect(r.decision.action).toBe("drop");
    expect(r.source).toBe("deterministic");
  });

  it("keeps (fallback) with the failure recorded when the skeptic failed but checks passed", () => {
    const r = reconcileResult("cluster-001", PASS, null, { kind: "refusal", message: "no" });
    expect(r.decision.action).toBe("keep");
    expect(r.source).toBe("fallback");
    expect(r.failure).toEqual({ kind: "refusal", message: "no" });
  });

  it("keeps (deterministic) on the mock path with no warnings", () => {
    const r = reconcileResult("cluster-001", PASS, null, null);
    expect(r.decision.action).toBe("keep");
    expect(r.source).toBe("deterministic");
  });

  it("downgrades (deterministic) on the mock path when there are soft warnings", () => {
    const r = reconcileResult("cluster-001", SOFT, null, null);
    expect(r.decision.action).toBe("downgrade");
    expect(r.source).toBe("deterministic");
  });

  it("takes the model verdict when checks pass", () => {
    const r = reconcileResult("cluster-001", PASS, verdict({ recommended_action: "keep" }), null);
    expect(r.decision.action).toBe("keep");
    expect(r.source).toBe("llm");
  });

  it("softens a model 'drop' to 'downgrade' unless it is unsupported + high risk, without contradicting the verdict", () => {
    const r = reconcileResult(
      "cluster-001",
      PASS,
      verdict({ recommended_action: "drop", support_level: "weak", false_positive_risk: "medium", is_supported: false }),
      null,
    );
    expect(r.decision.action).toBe("downgrade");
    expect(r.decision.softened_from_model_action).toBe("drop");
    // The raw verdict is preserved as-is; the record does not contradict itself
    // because is_supported lives only on model_verdict, not on the decision.
    expect(r.model_verdict?.is_supported).toBe(false);
    expect(r.model_verdict?.recommended_action).toBe("drop");
  });

  it("allows a model 'drop' when unsupported + high false-positive risk", () => {
    const r = reconcileResult(
      "cluster-001",
      PASS,
      verdict({ recommended_action: "drop", support_level: "unsupported", false_positive_risk: "high", is_supported: false }),
      null,
    );
    expect(r.decision.action).toBe("drop");
    expect(r.decision.softened_from_model_action).toBeNull();
    expect(r.source).toBe("llm");
  });
});

describe("selectSupportedClusters", () => {
  it("excludes only dropped clusters; keeps downgraded and result-less clusters", () => {
    const a = cluster({ cluster_id: "cluster-001" });
    const b = cluster({ cluster_id: "cluster-002" });
    const c = cluster({ cluster_id: "cluster-003" });
    const d = cluster({ cluster_id: "cluster-004" });
    const results = [
      reconcileResult("cluster-001", PASS, verdict({ recommended_action: "keep" }), null),
      reconcileResult("cluster-002", HARD_FAIL, null, null), // dropped
      reconcileResult("cluster-003", SOFT, null, null), // downgraded → kept
      // cluster-004 has no result → kept (recall-first).
    ];
    const supported = selectSupportedClusters([a, b, c, d], results);
    expect(supported.map((x) => x.cluster_id)).toEqual(["cluster-001", "cluster-003", "cluster-004"]);
  });
});

describe("runSkeptic", () => {
  const reporter = silentReporter();
  const withConfig = (overrides: Partial<Config["skeptic"]> = {}, context: Partial<Config["context"]> = {}): Config => ({
    ...defaultConfig,
    skeptic: { ...defaultConfig.skeptic, ...overrides },
    context: { ...defaultConfig.context, ...context },
  });

  it("returns no results for zero clusters", async () => {
    const out = await runSkeptic({
      clusters: [],
      packet: makeReviewPacket(),
      config: defaultConfig,
      reporter,
    });
    expect(out.results).toEqual([]);
  });

  it("mock backend validates deterministically (keep in-diff, drop off-changeset)", async () => {
    const packet = makeReviewPacket({ changedFiles: [changedFile()] });
    const clusters = [
      cluster({ cluster_id: "cluster-001", file: "src/a.ts", line_start: 11, line_end: 12 }),
      cluster({ cluster_id: "cluster-002", file: "src/missing.ts", line_start: 5, line_end: 6 }),
    ];
    const { results } = await runSkeptic({ clusters, packet, config: withConfig({ backend: "mock" }), reporter });
    expect(results.every((r) => r.source === "deterministic")).toBe(true);
    expect(results.find((r) => r.cluster_id === "cluster-001")?.decision.action).toBe("keep");
    expect(results.find((r) => r.cluster_id === "cluster-002")?.decision.action).toBe("drop");
    expect(selectSupportedClusters(clusters, results).map((c) => c.cluster_id)).toEqual(["cluster-001"]);
  });

  it("uses an injected skeptic and records its verdict", async () => {
    const skeptic: Skeptic = async () => verdict({ recommended_action: "keep" });
    const packet = makeReviewPacket({ changedFiles: [changedFile()] });
    const { results } = await runSkeptic({
      clusters: [cluster()],
      packet,
      config: withConfig({ backend: "claude" }),
      reporter,
      makeSkeptic: () => skeptic,
    });
    expect(results[0]?.source).toBe("llm");
    expect(results[0]?.decision.action).toBe("keep");
    expect(results[0]?.model_verdict?.recommended_action).toBe("keep");
  });

  it("keeps a strong-keep finding whose anchor is off-window — never drops it (finding #1)", async () => {
    const skeptic: Skeptic = async () => verdict({ support_level: "strong", recommended_action: "keep" });
    const packet = makeReviewPacket({ changedFiles: [changedFile()] });
    const offWindow = cluster({ line_start: 500, line_end: 500 });
    const { results } = await runSkeptic({
      clusters: [offWindow],
      packet,
      config: withConfig({ backend: "claude" }),
      reporter,
      makeSkeptic: () => skeptic,
    });
    // Off-window is only a soft warning; the model's keep stands.
    expect(results[0]?.decision.action).toBe("keep");
    expect(results[0]?.checks.soft_warnings.map((w) => w.code)).toContain("line_outside_diff");
    expect(selectSupportedClusters([offWindow], results)).toHaveLength(1);
  });

  it("keeps (with a recorded failure) when the skeptic fails on an off-window anchor (finding #2)", async () => {
    const skeptic: Skeptic = async () => {
      throw new Error("boom");
    };
    const packet = makeReviewPacket({ changedFiles: [changedFile()] });
    const offWindow = cluster({ line_start: 500, line_end: 500 });
    const { results } = await runSkeptic({
      clusters: [offWindow],
      packet,
      config: withConfig({ backend: "claude" }),
      reporter,
      makeSkeptic: () => skeptic,
    });
    expect(results[0]?.source).toBe("fallback");
    expect(results[0]?.decision.action).toBe("keep");
    expect(results[0]?.failure?.kind).toBe("unexpected");
  });

  it("ties the nearby window to config.context.nearbyContextLines", async () => {
    const packet = makeReviewPacket({ changedFiles: [changedFile()] });
    // Line 40 is 26 lines past the hunk end (14). Mock backend so the decision is
    // driven purely by the deterministic window.
    const far = cluster({ line_start: 40, line_end: 40 });
    const narrow = await runSkeptic({ clusters: [far], packet, config: withConfig({ backend: "mock" }, { nearbyContextLines: 20 }), reporter });
    expect(narrow.results[0]?.decision.action).toBe("downgrade"); // off-window → soft warning → downgrade
    expect(narrow.results[0]?.checks.signals.line_near_diff).toBe(false);

    const wide = await runSkeptic({ clusters: [far], packet, config: withConfig({ backend: "mock" }, { nearbyContextLines: 30 }), reporter });
    expect(wide.results[0]?.decision.action).toBe("keep"); // now within the window
    expect(wide.results[0]?.checks.signals.line_near_diff).toBe(true);
  });

  it("does not validate a partial (0, N) anchor against line 0", async () => {
    const packet = makeReviewPacket({ changedFiles: [changedFile()] });
    const partial = cluster({ line_start: 0, line_end: 500 });
    const { results } = await runSkeptic({ clusters: [partial], packet, config: withConfig({ backend: "mock" }), reporter });
    // If line 0 were used, line_in_diff would be spuriously true; it must not be.
    expect(results[0]?.checks.signals.line_in_diff).toBe(false);
    expect(results[0]?.checks.soft_warnings.map((w) => w.code)).toContain("partial_anchor");
    expect(results[0]?.decision.action).not.toBe("drop");
  });

  it("does not abort when the skeptic cannot be constructed — keeps all findings (finding #13)", async () => {
    const packet = makeReviewPacket({ changedFiles: [changedFile()] });
    const makeSkeptic = (): Skeptic => {
      throw new Error("missing credentials");
    };
    const { results } = await runSkeptic({
      clusters: [cluster({ cluster_id: "cluster-001" }), cluster({ cluster_id: "cluster-002" })],
      packet,
      config: withConfig({ backend: "claude" }),
      reporter,
      makeSkeptic,
    });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.source === "fallback")).toBe(true);
    expect(results.every((r) => r.decision.action === "keep")).toBe(true);
    expect(results.every((r) => r.failure?.kind === "construction_error")).toBe(true);
  });

  it("keeps the finding on a real timeout, via fake timers (finding #10)", async () => {
    vi.useFakeTimers();
    try {
      const hang: Skeptic = () => new Promise<SkepticVerdict>(() => {}); // never resolves
      const packet = makeReviewPacket({ changedFiles: [changedFile()] });
      const config = withConfig({ backend: "claude", timeoutMs: 1_000 });
      const promise = runSkeptic({
        clusters: [cluster()],
        packet,
        config,
        reporter,
        makeSkeptic: () => hang,
      });
      // Advance past timeoutMs + TIMEOUT_GRACE_MS so the backstop fires.
      await vi.advanceTimersByTimeAsync(1_000 + 250 + 5);
      const { results } = await promise;
      expect(results[0]?.source).toBe("fallback");
      expect(results[0]?.failure?.kind).toBe("timeout");
      expect(results[0]?.decision.action).toBe("keep");
    } finally {
      vi.useRealTimers();
    }
  });
});
