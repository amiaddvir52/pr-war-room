import { describe, it, expect } from "vitest";
import {
  textSimilarity,
  findingSimilarity,
  deduplicateFindings,
} from "../../src/findings/deduplicateFindings.js";
import type { Finding } from "../../src/findings/schema.js";
import type { DedupConfig } from "../../src/config/schema.js";

const OPTS: DedupConfig = {
  proximityLines: 10,
  mergeThreshold: 0.6,
  candidateThreshold: 0.4,
  llm: { enabled: false, backend: "claude", timeoutMs: 60_000 },
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "agent1-001",
    source_agent: "agent1",
    raw_agent_output_ref: "raw/agent1_review.md",
    title: "a finding",
    category: "correctness",
    severity: "medium",
    confidence: 0.6,
    file: "src/a.ts",
    line_start: 10,
    line_end: 12,
    claim: "a real, actionable claim",
    evidence: ["concrete evidence"],
    suggested_fix: null,
    suggested_test: null,
    human_review_likelihood: 0.5,
    needs_code_change: false,
    ...overrides,
  };
}

describe("textSimilarity", () => {
  it("is 1 for identical strings (case/whitespace-insensitive)", () => {
    expect(textSimilarity("Hello  World", "hello world")).toBe(1);
  });

  it("is 0 for strings with no shared bigrams", () => {
    expect(textSimilarity("abc", "xyz")).toBe(0);
  });

  it("scores sub-bigram (single-character) strings 0, even when identical", () => {
    // A one-character signature has no bigrams; the length guard and the
    // equality shortcut must agree rather than scoring identical single chars 1.
    expect(textSimilarity("a", "a")).toBe(0);
    expect(textSimilarity("a", "ab")).toBe(0);
    expect(textSimilarity("", "")).toBe(0);
  });

  it("is symmetric", () => {
    expect(textSimilarity("foo bar baz", "bar baz qux")).toBe(
      textSimilarity("bar baz qux", "foo bar baz"),
    );
  });
});

describe("findingSimilarity", () => {
  it("never merges across different files", () => {
    const a = finding({ file: "src/a.ts", title: "same", claim: "same" });
    const b = finding({ file: "src/b.ts", title: "same", claim: "same" });
    expect(findingSimilarity(a, b, OPTS)).toBe(0);
  });

  it("is 0 for same-file findings whose lines are far apart", () => {
    const a = finding({ line_start: 10, line_end: 12, title: "same", claim: "same" });
    const b = finding({ line_start: 500, line_end: 502, title: "same", claim: "same" });
    expect(findingSimilarity(a, b, OPTS)).toBe(0);
  });
});

describe("deduplicateFindings", () => {
  it("merges near-identical findings from different agents into one cluster", async () => {
    const a = finding({
      id: "a-001",
      source_agent: "claude_general_reviewer",
      category: "tests",
      severity: "medium",
      confidence: 0.6,
      human_review_likelihood: 0.5,
      evidence: ["evidence from A"],
      needs_code_change: false,
      title: "user.profile may be undefined and crash rendering",
      claim: "user.profile may be undefined and crash rendering",
    });
    const b = finding({
      id: "b-001",
      source_agent: "claude_correctness_reviewer",
      category: "correctness",
      severity: "high",
      confidence: 0.8,
      human_review_likelihood: 0.9,
      evidence: ["evidence from B"],
      suggested_fix: "guard user.profile",
      needs_code_change: true,
      title: "user.profile may be undefined and crash rendering",
      claim: "user.profile may be undefined and crash rendering",
    });

    const clusters = await deduplicateFindings([a, b], OPTS);
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.cluster_id).toBe("cluster-001");
    expect(c.source_finding_ids).toEqual(["a-001", "b-001"]);
    expect(c.source_agents).toEqual([
      "claude_correctness_reviewer",
      "claude_general_reviewer",
    ]);
    expect(c.agreement).toBe(2);
    // Representative is the higher-severity finding (B).
    expect(c.category).toBe("correctness");
    expect(c.severity).toBe("high"); // max across members
    expect(c.confidence).toBe(0.8); // max
    expect(c.human_review_likelihood).toBe(0.9); // max
    expect(c.needs_code_change).toBe(true); // OR
    expect(c.suggested_fix).toBe("guard user.profile"); // first non-null
    expect(c.evidence).toEqual(expect.arrayContaining(["evidence from A", "evidence from B"]));
  });

  it("merges the same issue across the original and preset-added reviewer angles", async () => {
    // One underlying issue reported by an original agent and two of the agents
    // added with the standard preset (repo-pattern / product-intent names).
    const sources: ReadonlyArray<readonly [string, string]> = [
      ["a-001", "claude_general_reviewer"],
      ["b-001", "claude_repo_pattern_reviewer"],
      ["c-001", "claude_product_intent_reviewer"],
    ];
    const members = sources.map(([id, agent]) =>
      finding({
        id,
        source_agent: agent,
        title: "config option added but never read",
        claim: "the new config option is added but never read anywhere",
      }),
    );
    const clusters = await deduplicateFindings(members, OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.source_agents).toEqual([
      "claude_general_reviewer",
      "claude_product_intent_reviewer",
      "claude_repo_pattern_reviewer",
    ]);
    expect(clusters[0]!.agreement).toBe(3);
  });

  it("ignores file-level (0/0) members when computing a merged cluster's line range", async () => {
    // A file-level finding (0/0 sentinel) and a line-anchored finding for the
    // same issue must merge into a range at the real lines, not get dragged to 0.
    const fileLevel = finding({
      id: "a-001",
      source_agent: "agent_a",
      file: "src/x.ts",
      line_start: 0,
      line_end: 0,
      title: "user.profile may be undefined and crash rendering",
      claim: "user.profile may be undefined and crash rendering",
    });
    const anchored = finding({
      id: "b-001",
      source_agent: "agent_b",
      file: "src/x.ts",
      line_start: 42,
      line_end: 50,
      title: "user.profile may be undefined and crash rendering",
      claim: "user.profile may be undefined and crash rendering",
    });
    const clusters = await deduplicateFindings([fileLevel, anchored], OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.source_finding_ids).toEqual(["a-001", "b-001"]);
    expect(clusters[0]!.line_start).toBe(42); // NOT 0 — the sentinel is ignored
    expect(clusters[0]!.line_end).toBe(50);
  });

  it("keeps an all-file-level cluster at the 0/0 sentinel", async () => {
    const a = finding({
      id: "a-001",
      source_agent: "agent_a",
      file: "src/x.ts",
      line_start: 0,
      line_end: 0,
      title: "config file is missing a required key",
      claim: "config file is missing a required key",
    });
    const b = finding({
      id: "b-001",
      source_agent: "agent_b",
      file: "src/x.ts",
      line_start: 0,
      line_end: 0,
      title: "config file is missing a required key",
      claim: "config file is missing a required key",
    });
    const clusters = await deduplicateFindings([a, b], OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.line_start).toBe(0);
    expect(clusters[0]!.line_end).toBe(0);
  });

  it("keeps findings in different files separate", async () => {
    const a = finding({ id: "a-001", file: "src/a.ts", title: "same issue", claim: "same issue" });
    const b = finding({ id: "b-001", file: "src/b.ts", title: "same issue", claim: "same issue" });
    const clusters = await deduplicateFindings([a, b], OPTS);
    expect(clusters).toHaveLength(2);
  });

  it("wraps a lone finding as a cluster of one", async () => {
    const clusters = await deduplicateFindings([finding({ id: "solo-001" })], OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.source_finding_ids).toEqual(["solo-001"]);
    expect(clusters[0]!.agreement).toBe(1);
  });

  it("assigns cluster ids most-severe-first", async () => {
    const low = finding({ id: "a-001", file: "src/low.ts", severity: "low", title: "low", claim: "low" });
    const blocker = finding({
      id: "b-001",
      file: "src/high.ts",
      severity: "blocker",
      title: "blocker",
      claim: "blocker",
    });
    const clusters = await deduplicateFindings([low, blocker], OPTS);
    expect(clusters[0]!.cluster_id).toBe("cluster-001");
    expect(clusters[0]!.severity).toBe("blocker");
    expect(clusters[1]!.severity).toBe("low");
  });

  it("is deterministic regardless of input order", async () => {
    const findings = [
      finding({ id: "a-001", file: "src/a.ts", title: "alpha", claim: "alpha issue here" }),
      finding({ id: "b-001", file: "src/b.ts", title: "beta", claim: "beta issue here" }),
      finding({ id: "c-001", file: "src/c.ts", severity: "high", title: "gamma", claim: "gamma issue here" }),
    ];
    const forward = await deduplicateFindings(findings, OPTS);
    const reversed = await deduplicateFindings([...findings].reverse(), OPTS);
    expect(reversed).toEqual(forward);
  });

  describe("LLM adjudicator (gray zone)", () => {
    // Force every same-file pair into the gray zone: only exact matches (>= 1.0)
    // auto-merge, and anything >= 0.0 is a candidate the adjudicator decides.
    const grayOpts: DedupConfig = { ...OPTS, mergeThreshold: 1.0, candidateThreshold: 0.0 };
    const a = finding({ id: "a-001", source_agent: "x", title: "counter not reset", claim: "the counter is not reset between runs" });
    const b = finding({ id: "b-001", source_agent: "y", title: "stale counter", claim: "counter value persists across runs incorrectly" });

    it("merges a gray-zone pair when the adjudicator says same issue", async () => {
      const clusters = await deduplicateFindings([a, b], grayOpts, async () => true);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]!.agreement).toBe(2);
    });

    it("keeps a gray-zone pair separate when the adjudicator says no", async () => {
      const clusters = await deduplicateFindings([a, b], grayOpts, async () => false);
      expect(clusters).toHaveLength(2);
    });

    it("keeps a gray-zone pair separate when no adjudicator is provided", async () => {
      const clusters = await deduplicateFindings([a, b], grayOpts);
      expect(clusters).toHaveLength(2);
    });

    it("treats an adjudicator error as 'don't merge' (fail-open)", async () => {
      const clusters = await deduplicateFindings([a, b], grayOpts, async () => {
        throw new Error("model unavailable");
      });
      expect(clusters).toHaveLength(2);
    });

    it("produces deterministic clusters with an adjudicator regardless of input order", async () => {
      // The gray-zone pass adjudicates with bounded concurrency and unions in
      // sorted pair order, so output must not depend on input order or on which
      // adjudicator call resolves first.
      const items = [
        finding({ id: "a-001", source_agent: "x", title: "issue one", claim: "issue one alpha" }),
        finding({ id: "b-001", source_agent: "y", title: "issue two", claim: "issue two beta" }),
        finding({ id: "c-001", source_agent: "z", title: "issue three", claim: "issue three gamma" }),
      ];
      // Deterministic per-pair decision (clusterFindings always calls in id order).
      const adj = async (l: Finding, r: Finding): Promise<boolean> => l.id < r.id;
      const forward = await deduplicateFindings(items, grayOpts, adj);
      const reversed = await deduplicateFindings([...items].reverse(), grayOpts, adj);
      expect(reversed).toEqual(forward);
    });

    it("does not consult the adjudicator once a pair is already clustered", async () => {
      // A~B and A~C auto-merge on identical text (score 1.0 ≥ mergeThreshold),
      // which connects B and C; the (B,C) pair must be skipped, not adjudicated.
      const autoMergeOpts: DedupConfig = { ...OPTS, mergeThreshold: 1.0, candidateThreshold: 0.0 };
      const same = { file: "src/a.ts", title: "identical issue", claim: "identical issue text" };
      const items = [
        finding({ id: "a-001", source_agent: "x", ...same }),
        finding({ id: "b-001", source_agent: "y", ...same }),
        finding({ id: "c-001", source_agent: "z", ...same }),
      ];
      let called = 0;
      const adj = async (): Promise<boolean> => {
        called += 1;
        return true;
      };
      const clusters = await deduplicateFindings(items, autoMergeOpts, adj);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]!.agreement).toBe(3);
      expect(called).toBe(0); // every pair auto-merged or skipped as already-connected
    });

    it("transitively clusters a chain even when the endpoints are rejected", async () => {
      // Adjudicator approves adjacent pairs (A~B, B~C) but rejects A~C; union-find
      // must still put all three in one cluster.
      const c1 = finding({ id: "a-001", source_agent: "x", title: "A-issue", claim: "issue number one here" });
      const c2 = finding({ id: "b-001", source_agent: "y", title: "B-issue", claim: "issue number two here" });
      const c3 = finding({ id: "c-001", source_agent: "z", title: "C-issue", claim: "issue number three here" });
      const adjacentOnly = async (l: Finding, r: Finding): Promise<boolean> => {
        const pair = `${l.title}|${r.title}`;
        return pair === "A-issue|B-issue" || pair === "B-issue|C-issue";
      };
      const clusters = await deduplicateFindings([c1, c2, c3], grayOpts, adjacentOnly);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]!.agreement).toBe(3);
      expect(clusters[0]!.source_finding_ids).toEqual(["a-001", "b-001", "c-001"]);
    });
  });
});
