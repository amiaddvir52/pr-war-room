import { describe, it, expect } from "vitest";
import {
  findingSimilarity,
  extractSymbols,
  deduplicateFindings,
  clusterFindings,
} from "../../src/findings/deduplicateFindings.js";
import type { Finding } from "../../src/findings/schema.js";
import type { DedupConfig } from "../../src/config/schema.js";

/** The shipped defaults (schema/defaultConfig) — the thresholds under test. */
const OPTS: DedupConfig = {
  proximityLines: 10,
  mergeThreshold: 0.46,
  candidateThreshold: 0.35,
  minLinkScore: 0.15,
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

describe("extractSymbols", () => {
  it("finds camelCase, snake_case, dotted, and call-syntax identifiers", () => {
    const symbols = extractSymbols(
      "getUser(task.assigneeId) crashes; assignee_total_completed uses listTasks() from src/csv.ts",
    );
    expect(symbols).toContain("getuser");
    expect(symbols).toContain("task.assigneeid");
    expect(symbols).toContain("assignee_total_completed");
    expect(symbols).toContain("listtasks");
    expect(symbols).toContain("csv.ts");
  });

  it("finds backtick-quoted spans and strips call parens", () => {
    const symbols = extractSymbols("uses `escapeCsvField` instead of `quote()`");
    expect(symbols).toContain("escapecsvfield");
    expect(symbols).toContain("quote");
  });

  it("ignores plain prose words", () => {
    expect(extractSymbols("the export loop is slow").size).toBe(0);
  });
});

describe("findingSimilarity", () => {
  it("never merges across different files", () => {
    const a = finding({ file: "src/a.ts", title: "same title here", claim: "same claim text" });
    const b = finding({ file: "src/b.ts", title: "same title here", claim: "same claim text" });
    expect(findingSimilarity(a, b, OPTS)).toBe(0);
  });

  it("is 0 for same-file findings whose lines are far apart", () => {
    const a = finding({ line_start: 10, line_end: 12, title: "same title", claim: "same claim" });
    const b = finding({ line_start: 500, line_end: 502, title: "same title", claim: "same claim" });
    expect(findingSimilarity(a, b, OPTS)).toBe(0);
  });

  it("is 1 for identical candidates and symmetric in general", () => {
    const a = finding({ title: "missing null guard for the user profile", claim: "profile may be undefined" });
    const b = finding({ id: "b-001", title: "no null check on user profile access", claim: "undefined profile crashes rendering" });
    expect(findingSimilarity(a, a, OPTS)).toBe(1);
    expect(findingSimilarity(a, b, OPTS)).toBe(findingSimilarity(b, a, OPTS));
  });

  it("scores different root causes on adjacent lines low", () => {
    // Modeled on the demo's dense src/export.ts: a performance scan at 39-42
    // and a cross-project data leak at 40-42 overlap almost exactly, yet are
    // distinct issues — the text/symbol signals must dominate span proximity.
    const scan = finding({
      title: "Full task-store scan inside the per-row export loop",
      claim: "listTasks() is filtered inside the loop over completed tasks, O(rows x tasks) work per export",
      line_start: 39,
      line_end: 42,
      category: "performance",
    });
    const leak = finding({
      id: "agent2-001",
      title: "assignee_total_completed counts tasks across all projects, leaking cross-project activity",
      claim: "the per-assignee total uses the global store, so members see activity from projects they do not belong to",
      line_start: 40,
      line_end: 42,
      category: "product",
    });
    expect(findingSimilarity(scan, leak, OPTS)).toBeLessThan(OPTS.mergeThreshold);
  });
});

/* ------------------------- demo-derived regressions ----------------------- */

/**
 * Condensed from the first TaskFlow demo run (57 findings): four distinct
 * planted issues live within 15 lines of one dense new file. The original
 * transitive-proximity dedup chained 27 findings across all four into one
 * giant cluster; issue-identity clustering must keep them apart while still
 * merging each issue's rephrasings — including across vendors.
 */
function denseFileFindings(): Finding[] {
  const at = (lineStart: number, lineEnd: number) => ({ file: "src/export.ts", line_start: lineStart, line_end: lineEnd });
  return [
    // 30-day product-intent bug (L31-33) — claude + codex wordings
    finding({
      id: "claude_general-003", source_agent: "claude_general_reviewer",
      title: "Export does not filter by the advertised 30-day completion window",
      claim: "The PR and README promise a 30-day window but no completedAt filter exists; all-time completed tasks are exported.",
      category: "correctness", severity: "high", ...at(31, 33),
    }),
    finding({
      id: "codex_general-002", source_agent: "codex_general_reviewer",
      title: "Activity export does not enforce the 30-day window",
      claim: "Rows are not restricted to the last 30 days as the PR describes.",
      category: "correctness", severity: "high", ...at(31, 33),
    }),
    // O(rows × tasks) scan (L39-42)
    finding({
      id: "claude_perf-001", source_agent: "claude_performance_reviewer",
      title: "Full task-store scan inside the export loop (O(rows x total tasks))",
      claim: "listTasks().filter(...) runs once per exported row, scanning every task in the store per row.",
      category: "performance", severity: "high", ...at(39, 42),
    }),
    finding({
      id: "codex_general-004", source_agent: "codex_general_reviewer",
      title: "Export repeatedly scans all tasks inside the row loop",
      claim: "exportActivityCsv scans the entire task store per exported row to compute assignee totals, scaling poorly.",
      category: "performance", severity: "medium", ...at(39, 42),
    }),
    // Cross-project leak (L40-42)
    finding({
      id: "claude_sec-006", source_agent: "claude_security_reviewer",
      title: "assignee_total_completed leaks cross-project activity via global task scan",
      claim: "The per-row total uses the global listTasks() store filtered only by assignee, so any member learns completion counts from projects they do not belong to.",
      category: "security", severity: "medium", ...at(40, 42),
    }),
    finding({
      id: "codex_sec-002", source_agent: "codex_security_reviewer",
      title: "Activity export leaks cross-project assignee completion totals",
      claim: "assignee_total_completed is computed from all tasks in the store, allowing members to infer activity in other projects.",
      category: "security", severity: "medium", ...at(40, 42),
    }),
    // Unassigned-task crash (L44-45) — claude + codex wordings
    finding({
      id: "claude_general-004", source_agent: "claude_general_reviewer",
      title: "Export crashes on unassigned tasks instead of rendering Unassigned",
      claim: "getUser(task.assigneeId as string)! throws a TypeError for a completed task with no assignee; describeUser handles this case.",
      category: "correctness", severity: "high", ...at(44, 45),
    }),
    finding({
      id: "codex_correctness-003", source_agent: "codex_correctness_reviewer",
      title: "Export crashes for unassigned or missing assignees",
      claim: "Done tasks without a valid assignee cause a runtime failure instead of rendering Unassigned.",
      category: "correctness", severity: "medium", ...at(44, 45),
    }),
  ];
}

describe("dense-file over-merge prevention (demo regression)", () => {
  it("keeps the four distinct root causes in four separate clusters", async () => {
    const { clusters } = await deduplicateFindings(denseFileFindings(), OPTS);
    expect(clusters).toHaveLength(4);

    const membership = new Map(
      clusters.flatMap((c) => c.source_finding_ids.map((id) => [id, c.cluster_id] as const)),
    );
    const sameCluster = (a: string, b: string): boolean => membership.get(a) === membership.get(b);

    // Each issue's rephrasings merge — including cross-vendor…
    expect(sameCluster("claude_general-003", "codex_general-002")).toBe(true); // 30-day
    expect(sameCluster("claude_perf-001", "codex_general-004")).toBe(true); // scan
    expect(sameCluster("claude_sec-006", "codex_sec-002")).toBe(true); // leak
    expect(sameCluster("claude_general-004", "codex_correctness-003")).toBe(true); // crash

    // …and the distinct root causes never merge, despite adjacent/overlapping lines.
    expect(sameCluster("claude_general-003", "claude_perf-001")).toBe(false);
    expect(sameCluster("claude_perf-001", "claude_sec-006")).toBe(false);
    expect(sameCluster("claude_sec-006", "claude_general-004")).toBe(false);
  });

  it("merges a terse codex report into a verbose claude report of the same issue", async () => {
    // Second demo run regression: Dice alone punishes length imbalance, so a
    // one-sentence codex claim never merged with claude's five-sentence claim
    // of the same crash. The overlap-coefficient blend must bridge them.
    const verbose = finding({
      id: "claude_security-002", source_agent: "claude_security_reviewer",
      title: "Export crashes on unassigned tasks via non-null assertion on getUser",
      claim: "getUser(task.assigneeId as string)! assumes every completed task has an assignee that resolves to a user. For an unassigned task (assigneeId undefined) getUser returns undefined and the dereference of .name throws a TypeError, aborting the export for the whole project instead of rendering Unassigned.",
      category: "correctness", severity: "high",
      file: "src/export.ts", line_start: 44, line_end: 45,
    });
    const terse = finding({
      id: "codex_correctness-003", source_agent: "codex_correctness_reviewer",
      title: "Unassigned or missing assignees crash the CSV export",
      claim: "The export assumes every completed task has a valid assignee user, so unassigned tasks or deleted/missing users throw instead of rendering Unassigned.",
      category: "correctness", severity: "medium",
      file: "src/export.ts", line_start: 44, line_end: 45,
    });
    const { clusters } = await deduplicateFindings([verbose, terse], OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.agreement).toBe(2);
  });

  it("merges the same crash from claude and codex into one coherent cluster", async () => {
    const crashOnly = denseFileFindings().filter((f) =>
      ["claude_general-004", "codex_correctness-003"].includes(f.id),
    );
    const { clusters } = await deduplicateFindings(crashOnly, OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.source_agents).toEqual([
      "claude_general_reviewer",
      "codex_correctness_reviewer",
    ]);
  });
});

describe("CSV helper under-merge (demo regression)", () => {
  it("merges differently-worded reports of the same helper duplication", async () => {
    // The demo's clusters 003/005: same root cause ("use the existing csv
    // helpers"), phrased differently by claude and codex, overlapping lines.
    const claude = finding({
      id: "claude_general-005", source_agent: "claude_general_reviewer",
      title: "Hand-rolled CSV quoting instead of the mandated src/csv.ts helpers",
      claim: "The export builds rows with a local quote() helper and manual join(\",\"), violating the repo convention that CSV output goes through escapeCsvField/toCsvRow.",
      category: "maintainability", severity: "high",
      file: "src/export.ts", line_start: 47, line_end: 63,
    });
    const codex = finding({
      id: "codex_general-003", source_agent: "codex_general_reviewer",
      title: "CSV generation bypasses repository CSV helpers",
      claim: "The export hand-rolls CSV quoting instead of using the required CSV helpers, which violates the repo convention and risks inconsistent escaping.",
      category: "maintainability", severity: "medium",
      file: "src/export.ts", line_start: 47, line_end: 62,
    });
    const { clusters } = await deduplicateFindings([claude, codex], OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.agreement).toBe(2);
  });
});

describe("anti-chaining guardrail (complete linkage)", () => {
  it("refuses a merge that would chain two unrelated findings through a bridge", async () => {
    // A ~ B and B ~ C are each above the merge bar, but A and C share nothing;
    // pure union-find would chain all three. Complete linkage must block it.
    const a = finding({
      id: "a-001", source_agent: "x",
      title: "duplicate quote helper reimplements csv escaping",
      claim: "a local quote helper duplicates csv escaping logic",
      line_start: 10, line_end: 12,
    });
    const bridge = finding({
      id: "b-001", source_agent: "y",
      title: "duplicate quote helper reimplements csv escaping and misses the thirty day window filter",
      claim: "a local quote helper duplicates csv escaping logic and the export misses the thirty day window filter",
      line_start: 11, line_end: 14,
    });
    const c = finding({
      id: "c-001", source_agent: "z",
      title: "export misses the thirty day window filter",
      claim: "the export misses the thirty day window filter",
      line_start: 13, line_end: 15,
    });

    // Sanity-check the setup so threshold drift can't silently defang the test:
    // both bridge pairs merge-worthy, the endpoints incompatible.
    expect(findingSimilarity(a, bridge, OPTS)).toBeGreaterThanOrEqual(OPTS.mergeThreshold);
    expect(findingSimilarity(bridge, c, OPTS)).toBeGreaterThanOrEqual(OPTS.mergeThreshold);
    expect(findingSimilarity(a, c, OPTS)).toBeLessThan(OPTS.minLinkScore);

    const { groups, stats } = await clusterFindings([a, bridge, c], OPTS);
    expect(groups).toHaveLength(2);
    expect(stats.mergesBlockedByLinkage).toBeGreaterThanOrEqual(1);
    // The strongest pair united first; the endpoint stayed out.
    const sizes = groups.map((g) => g.length).sort();
    expect(sizes).toEqual([1, 2]);
  });
});

/* ------------------------------ merge fields ------------------------------ */

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

    const { clusters } = await deduplicateFindings([a, b], OPTS);
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

  it("orders merged evidence strongest-member-first (representative leads)", async () => {
    const weak = finding({
      id: "a-001", source_agent: "x", severity: "low", confidence: 0.3,
      evidence: ["weak evidence"],
      title: "user.profile may be undefined and crash rendering",
      claim: "user.profile may be undefined and crash rendering",
    });
    const strong = finding({
      id: "b-001", source_agent: "y", severity: "high", confidence: 0.9,
      evidence: ["strong evidence"],
      title: "user.profile may be undefined and crash rendering",
      claim: "user.profile may be undefined and crash rendering",
    });
    const { clusters } = await deduplicateFindings([weak, strong], OPTS);
    expect(clusters[0]!.evidence).toEqual(["strong evidence", "weak evidence"]);
  });

  it("merges the same issue across the original and preset-added reviewer angles", async () => {
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
    const { clusters } = await deduplicateFindings(members, OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.source_agents).toEqual([
      "claude_general_reviewer",
      "claude_product_intent_reviewer",
      "claude_repo_pattern_reviewer",
    ]);
    expect(clusters[0]!.agreement).toBe(3);
  });

  it("ignores file-level (0/0) members when computing a merged cluster's line range", async () => {
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
    const { clusters } = await deduplicateFindings([fileLevel, anchored], OPTS);
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
    const { clusters } = await deduplicateFindings([a, b], OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.line_start).toBe(0);
    expect(clusters[0]!.line_end).toBe(0);
  });

  it("keeps findings in different files separate", async () => {
    const a = finding({ id: "a-001", file: "src/a.ts", title: "same issue", claim: "same issue" });
    const b = finding({ id: "b-001", file: "src/b.ts", title: "same issue", claim: "same issue" });
    const { clusters } = await deduplicateFindings([a, b], OPTS);
    expect(clusters).toHaveLength(2);
  });

  it("wraps a lone finding as a cluster of one", async () => {
    const { clusters } = await deduplicateFindings([finding({ id: "solo-001" })], OPTS);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.source_finding_ids).toEqual(["solo-001"]);
    expect(clusters[0]!.agreement).toBe(1);
  });

  it("assigns cluster ids most-severe-first", async () => {
    const low = finding({ id: "a-001", file: "src/low.ts", severity: "low", title: "unbounded audit log growth", claim: "the audit array grows forever" });
    const blocker = finding({
      id: "b-001",
      file: "src/high.ts",
      severity: "blocker",
      title: "mutation happens before the auth check",
      claim: "settings are written before requireProjectAdmin runs",
    });
    const { clusters } = await deduplicateFindings([low, blocker], OPTS);
    expect(clusters[0]!.cluster_id).toBe("cluster-001");
    expect(clusters[0]!.severity).toBe("blocker");
    expect(clusters[1]!.severity).toBe("low");
  });

  it("is deterministic regardless of input order", async () => {
    const findings = [
      finding({ id: "a-001", file: "src/a.ts", title: "alpha problem", claim: "alpha issue here" }),
      finding({ id: "b-001", file: "src/b.ts", title: "beta problem", claim: "beta issue here" }),
      finding({ id: "c-001", file: "src/c.ts", severity: "high", title: "gamma problem", claim: "gamma issue here" }),
    ];
    const forward = await deduplicateFindings(findings, OPTS);
    const reversed = await deduplicateFindings([...findings].reverse(), OPTS);
    expect(reversed.clusters).toEqual(forward.clusters);
  });

  it("reports dedup stats (gray pairs, adjudication availability)", async () => {
    const { stats } = await deduplicateFindings(denseFileFindings(), OPTS);
    expect(stats.llmAvailable).toBe(false);
    expect(stats.grayPairsAdjudicated).toBe(0);
    expect(stats.autoMergePairs).toBeGreaterThan(0);
  });

  describe("LLM adjudicator (gray zone)", () => {
    // Force every same-file pair into the gray zone: only exact matches (>= 1.0)
    // auto-merge, and anything >= 0.0 is a candidate the adjudicator decides.
    // minLinkScore 0 keeps the linkage guardrail out of these tests' way.
    const grayOpts: DedupConfig = { ...OPTS, mergeThreshold: 1.0, candidateThreshold: 0.0, minLinkScore: 0 };
    const a = finding({ id: "a-001", source_agent: "x", title: "counter not reset", claim: "the counter is not reset between runs" });
    const b = finding({ id: "b-001", source_agent: "y", title: "stale counter", claim: "counter value persists across runs incorrectly" });

    it("merges a gray-zone pair when the adjudicator says same issue", async () => {
      const { clusters, stats } = await deduplicateFindings([a, b], grayOpts, async () => true);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]!.agreement).toBe(2);
      expect(stats.llmMerges).toBe(1);
      expect(stats.llmAvailable).toBe(true);
    });

    it("keeps a gray-zone pair separate when the adjudicator says no", async () => {
      const { clusters } = await deduplicateFindings([a, b], grayOpts, async () => false);
      expect(clusters).toHaveLength(2);
    });

    it("keeps a gray-zone pair separate when no adjudicator is provided", async () => {
      const { clusters } = await deduplicateFindings([a, b], grayOpts);
      expect(clusters).toHaveLength(2);
    });

    it("treats an adjudicator error as 'don't merge' (fail-open)", async () => {
      const { clusters, stats } = await deduplicateFindings([a, b], grayOpts, async () => {
        throw new Error("model unavailable");
      });
      expect(clusters).toHaveLength(2);
      expect(stats.adjudicatorErrors).toBe(1);
    });

    it("produces deterministic clusters with an adjudicator regardless of input order", async () => {
      const items = [
        finding({ id: "a-001", source_agent: "x", title: "first problem", claim: "first problem alpha" }),
        finding({ id: "b-001", source_agent: "y", title: "second problem", claim: "second problem beta" }),
        finding({ id: "c-001", source_agent: "z", title: "third problem", claim: "third problem gamma" }),
      ];
      // Deterministic per-pair decision (clusterFindings always calls in id order).
      const adj = async (l: Finding, r: Finding): Promise<boolean> => l.id < r.id;
      const forward = await deduplicateFindings(items, grayOpts, adj);
      const reversed = await deduplicateFindings([...items].reverse(), grayOpts, adj);
      expect(reversed.clusters).toEqual(forward.clusters);
    });

    it("does not consult the adjudicator once a pair is already clustered", async () => {
      // A~B and A~C auto-merge on identical text (score 1.0 ≥ mergeThreshold),
      // which connects B and C; the (B,C) pair must be skipped, not adjudicated.
      const autoMergeOpts: DedupConfig = { ...grayOpts };
      const same = { file: "src/a.ts", title: "identical problem", claim: "identical problem text" };
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
      const { clusters } = await deduplicateFindings(items, autoMergeOpts, adj);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]!.agreement).toBe(3);
      expect(called).toBe(0); // every pair auto-merged or skipped as already-connected
    });

    it("applies the linkage guardrail to adjudicator-approved merges too", async () => {
      // The adjudicator approves everything, but A and C are wholly unrelated
      // (score 0 < minLinkScore) — an approved bridge must still not chain them.
      const guarded: DedupConfig = { ...OPTS, mergeThreshold: 1.0, candidateThreshold: 0.0 };
      const one = finding({ id: "a-001", source_agent: "x", title: "alpha omission entirely", claim: "alpha words only", line_start: 10, line_end: 11 });
      const two = finding({ id: "b-001", source_agent: "y", title: "alpha omission entirely beta overlap", claim: "alpha words only beta words", line_start: 11, line_end: 12 });
      const three = finding({ id: "c-001", source_agent: "z", title: "beta overlap", claim: "beta words", line_start: 12, line_end: 13 });
      expect(findingSimilarity(one, three, guarded)).toBeLessThan(guarded.minLinkScore);
      const { clusters } = await deduplicateFindings([one, two, three], guarded, async () => true);
      expect(clusters.length).toBeGreaterThanOrEqual(2);
      // Whatever merged, the unrelated endpoints never share a cluster.
      const byId = new Map(clusters.flatMap((c) => c.source_finding_ids.map((id) => [id, c.cluster_id] as const)));
      expect(byId.get("a-001")).not.toBe(byId.get("c-001"));
    });
  });
});
