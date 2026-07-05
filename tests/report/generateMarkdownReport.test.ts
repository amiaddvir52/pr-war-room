import { describe, it, expect } from "vitest";
import { renderMarkdownReport } from "../../src/report/generateMarkdownReport.js";
import type { ReportInput } from "../../src/report/generateMarkdownReport.js";
import { getArtifactPaths } from "../../src/storage/artifactPaths.js";
import { makeReviewPacket } from "../fixtures/reviewPacket.js";
import type {
  FinalFinding,
  FindingCluster,
  JudgeResult,
  SkepticResult,
} from "../../src/findings/schema.js";

const paths = getArtifactPaths("/base");

function cluster(overrides: Partial<FindingCluster> = {}): FindingCluster {
  return {
    cluster_id: "cluster-001",
    merged_title: "a finding",
    source_finding_ids: ["a-001"],
    source_agents: ["reviewer_a"],
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

function finalFinding(overrides: Partial<FinalFinding> = {}): FinalFinding {
  return {
    ...cluster(),
    final_classification: "blocker",
    final_score: 0.88,
    judge_reasoning: "crash path",
    skeptic_support_level: "strong",
    ...overrides,
  };
}

function judgeDrop(cluster_id: string, reason = "low value / stylistic"): JudgeResult {
  return {
    cluster_id,
    source: "llm",
    model_verdict: { final_classification: "drop", model_score: 0.1, reasoning_summary: reason },
    decision: {
      classification: "drop",
      score: 0.1,
      include_in_main_report: false,
      reason,
      softened_from_model_classification: null,
    },
    failure: null,
  };
}

function skepticKeep(cluster_id = "cluster-001"): SkepticResult {
  return {
    cluster_id,
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
  };
}

function skepticDrop(cluster_id: string, reason = "no supporting evidence"): SkepticResult {
  return {
    cluster_id,
    source: "llm",
    checks: {
      hard_failures: [],
      soft_warnings: [],
      signals: { file_in_changeset: false, has_line_anchor: false, line_in_diff: null, line_near_diff: null },
      notes: [],
    },
    model_verdict: {
      is_supported: false,
      support_level: "unsupported",
      false_positive_risk: "high",
      reasoning_summary: reason,
      recommended_action: "drop",
    },
    decision: { action: "drop", reason, softened_from_model_action: null },
    failure: null,
  };
}

function makeInput(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    packet: makeReviewPacket(),
    clusters: [cluster()],
    candidates: [cluster()],
    skepticResults: [],
    ranked: [],
    final: [finalFinding()],
    rawFindingCount: 1,
    meta: { toolVersion: "0.1.0", generatedAt: "2026-01-01T00:00:00.000Z" },
    options: { maxFindings: 20, includeNiceToHave: false, judgeEnabled: true, skepticEnabled: true },
    paths,
    ...overrides,
  };
}

/** Extract the body of one `## heading` section, up to the next `## ` / `---`. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const rest = md.slice(start + heading.length + 3);
  const next = rest.search(/\n## |\n---/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("renderMarkdownReport", () => {
  it("renders all required headers in order", () => {
    const md = renderMarkdownReport(makeInput());
    const headers = [
      "# AI Pre-Review Report",
      "## Summary",
      "## Must Fix Before Human Review",
      "## Should Fix Before Human Review",
      "## Suggested Tests",
      "## Optional Improvements",
      "## Verification Results",
      "## Dropped Findings",
      "## Raw Artifacts",
    ];
    let cursor = -1;
    for (const h of headers) {
      const at = md.indexOf(h);
      expect(at, `missing header: ${h}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("renders a blocker under Must Fix with every PRD field + trust signals", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [
          finalFinding({
            merged_title: "Null deref crashes render",
            severity: "blocker",
            category: "correctness",
            confidence: 0.7,
            human_review_likelihood: 0.9,
            file: "src/render.ts",
            line_start: 10,
            line_end: 12,
            agreement: 2,
            source_agents: ["reviewer_a", "reviewer_b"],
            claim: "user.profile may be undefined",
            evidence: ["line 10 dereferences user.profile"],
            suggested_fix: "guard with optional chaining",
            suggested_test: "test a user with no profile",
            skeptic_support_level: "strong",
            final_score: 0.91,
          }),
        ],
      }),
    );
    const mustFix = section(md, "Must Fix Before Human Review");
    expect(mustFix).toContain("### Null deref crashes render");
    expect(mustFix).toContain("**Severity:** blocker");
    expect(mustFix).toContain("**Category:** correctness");
    expect(mustFix).toContain("**Confidence:** 0.70");
    expect(mustFix).toContain("**Human review likelihood:** 0.90");
    expect(mustFix).toContain("**File:** `src/render.ts`");
    expect(mustFix).toContain("**Lines:** 10-12");
    expect(mustFix).toContain("**Reported by:** 2 reviewers (reviewer_a, reviewer_b)");
    expect(mustFix).toContain("**Skeptic support:** strong");
    expect(mustFix).toContain("**Score:** 0.91");
    expect(mustFix).toContain("**Why this matters:** user.profile may be undefined");
    expect(mustFix).toContain("- line 10 dereferences user.profile");
    expect(mustFix).toContain("**Suggested fix:** guard with optional chaining");
    expect(mustFix).toContain("**Suggested test:** test a user with no profile");
  });

  it("groups a should_fix finding under Should Fix, not Must Fix", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [
          finalFinding({
            merged_title: "Missing null handling",
            final_classification: "should_fix_before_review",
          }),
        ],
      }),
    );
    expect(section(md, "Should Fix Before Human Review")).toContain("### Missing null handling");
    expect(section(md, "Must Fix Before Human Review")).toContain("_None._");
  });

  it("aggregates non-null suggested tests from displayed findings", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [
          finalFinding({ cluster_id: "c1", suggested_test: "cover the empty case" }),
          finalFinding({ cluster_id: "c2", suggested_test: null }),
        ],
      }),
    );
    const tests = section(md, "Suggested Tests");
    expect(tests).toContain("- cover the empty case");
    expect(tests).not.toContain("_None._");
  });

  it("shows the Optional section when includeNiceToHave is true", () => {
    const md = renderMarkdownReport(
      makeInput({
        options: { maxFindings: 20, includeNiceToHave: true, judgeEnabled: true, skepticEnabled: true },
        final: [finalFinding({ merged_title: "rename for clarity", final_classification: "nice_to_have" })],
      }),
    );
    expect(section(md, "Optional Improvements")).toContain("### rename for clarity");
  });

  it("hides nice_to_have findings and notes the count when includeNiceToHave is false", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [
          finalFinding({ cluster_id: "b1", final_classification: "blocker" }),
          finalFinding({ cluster_id: "n1", merged_title: "nit one", final_classification: "nice_to_have" }),
          finalFinding({ cluster_id: "n2", merged_title: "nit two", final_classification: "nice_to_have" }),
        ],
      }),
    );
    expect(md).not.toContain("### nit one");
    expect(section(md, "Optional Improvements")).toContain("2 optional improvements hidden");
    expect(md).toContain("2 optional findings hidden");
  });

  it("caps the main report at maxFindings and notes the omission, blockers first", () => {
    const md = renderMarkdownReport(
      makeInput({
        options: { maxFindings: 2, includeNiceToHave: true, judgeEnabled: true, skepticEnabled: true },
        final: [
          finalFinding({ cluster_id: "b1", merged_title: "blocker one", final_classification: "blocker", final_score: 0.9 }),
          finalFinding({ cluster_id: "b2", merged_title: "blocker two", final_classification: "blocker", final_score: 0.8 }),
          finalFinding({ cluster_id: "s1", merged_title: "should fix one", final_classification: "should_fix_before_review", final_score: 0.7 }),
        ],
      }),
    );
    expect(md).toContain("### blocker one");
    expect(md).toContain("### blocker two");
    expect(md).not.toContain("### should fix one");
    expect(md).toContain(
      "1 finding beyond the `maxFindings=2` limit not shown — including 1 should-fix",
    );
    expect(md).not.toContain("lower-priority");
  });

  it("does not let hidden nice_to_have findings consume the cap", () => {
    const md = renderMarkdownReport(
      makeInput({
        options: { maxFindings: 2, includeNiceToHave: false, judgeEnabled: true, skepticEnabled: true },
        final: [
          finalFinding({ cluster_id: "b1", merged_title: "blocker one", final_classification: "blocker", final_score: 0.9 }),
          finalFinding({ cluster_id: "b2", merged_title: "blocker two", final_classification: "blocker", final_score: 0.8 }),
          finalFinding({ cluster_id: "n1", merged_title: "nit one", final_classification: "nice_to_have", final_score: 0.3 }),
          finalFinding({ cluster_id: "n2", merged_title: "nit two", final_classification: "nice_to_have", final_score: 0.2 }),
          finalFinding({ cluster_id: "n3", merged_title: "nit three", final_classification: "nice_to_have", final_score: 0.1 }),
        ],
      }),
    );
    expect(md).toContain("### blocker one");
    expect(md).toContain("### blocker two");
    expect(md).not.toContain("omitted by `maxFindings"); // no bogus cap note
    expect(md).toContain("3 optional findings hidden");
  });

  it("renders verification results with per-command status and a link", () => {
    const md = renderMarkdownReport(
      makeInput({
        packet: makeReviewPacket({
          verification: {
            enabled: true,
            ran: true,
            allPassed: false,
            install: null,
            commands: [
              { command: "npm test", exitCode: 0, passed: true, timedOut: false, spawnError: null, stdoutPreview: "", stderrPreview: "" },
              { command: "npm run lint", exitCode: 1, passed: false, timedOut: false, spawnError: null, stdoutPreview: "", stderrPreview: "2 problems" },
            ],
          },
        }),
      }),
    );
    const v = section(md, "Verification Results");
    expect(v).toContain("**Result:** failures present ✗");
    expect(v).toContain("`npm test`: exit 0 ✓");
    expect(v).toContain("`npm run lint`: exit 1 ✗");
    expect(v).toContain("2 problems");
    expect(v).toContain("[verification/initial_verification.json](verification/initial_verification.json)");
  });

  it("notes when verification was not run", () => {
    const md = renderMarkdownReport(makeInput());
    expect(section(md, "Verification Results")).toContain("Verification not run");
    expect(section(md, "Summary")).toContain("**Verification:** not run");
  });

  it("lists dropped findings from both the skeptic and the judge with titles + reasons", () => {
    const md = renderMarkdownReport(
      makeInput({
        clusters: [
          cluster({ cluster_id: "cluster-001" }),
          cluster({ cluster_id: "cluster-008", merged_title: "speculative edge case" }),
          cluster({ cluster_id: "cluster-009", merged_title: "pure style nit" }),
        ],
        skepticResults: [skepticDrop("cluster-008", "no evidence in diff")],
        ranked: [judgeDrop("cluster-009", "stylistic only")],
      }),
    );
    const dropped = section(md, "Dropped Findings");
    expect(dropped).toContain("2 findings dropped");
    expect(dropped).toContain("**speculative edge case** — no evidence in diff _(skeptic)_");
    expect(dropped).toContain("**pure style nit** — stylistic only _(judge)_");
  });

  it("renders relative artifact links, gated by which phases ran", () => {
    const md = renderMarkdownReport(makeInput());
    const raw = section(md, "Raw Artifacts");
    expect(raw).toContain("[run_metadata.json](run_metadata.json)");
    expect(raw).toContain("[context/review_packet.json](context/review_packet.json)");
    expect(raw).toContain("[normalized/all_findings.json](normalized/all_findings.json)");
    expect(raw).toContain("[deduped/finding_clusters.json](deduped/finding_clusters.json)");
    expect(raw).toContain("[skeptic/skeptic_results.json](skeptic/skeptic_results.json)");
    expect(raw).toContain("[judge/ranked_findings.json](judge/ranked_findings.json)");
    expect(raw).toContain("[final_findings.json](final_findings.json)");
    expect(raw).not.toContain(".ai-review/");
  });

  it("renders file-level and null-file locations per convention", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [finalFinding({ file: null, line_start: 0, line_end: 0 })],
      }),
    );
    expect(md).toContain("**File:** (none)");
    expect(md).toContain("**Lines:** file-level (no line range)");
  });

  it("handles zero findings: ready verdict + reviewer-found-nothing note", () => {
    const md = renderMarkdownReport(makeInput({ final: [], clusters: [], candidates: [], rawFindingCount: 0 }));
    expect(section(md, "Summary")).toContain("Looks ready for human review");
    expect(section(md, "Summary")).toContain("reviewers surfaced no findings");
    expect(section(md, "Must Fix Before Human Review")).toContain("_None._");
  });

  it("distinguishes all-dropped from nothing-found", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [],
        clusters: [cluster({ cluster_id: "cluster-001" })],
        candidates: [],
        skepticResults: [skepticDrop("cluster-001")],
        rawFindingCount: 3,
      }),
    );
    expect(section(md, "Summary")).toContain("All findings were dropped");
  });

  it("degrades when the judge is disabled: deterministic grouping, no ranked links/segment", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: null,
        ranked: null,
        clusters: [cluster({ cluster_id: "cluster-001", severity: "high" })],
        candidates: [cluster({ cluster_id: "cluster-001", severity: "high", merged_title: "high sev issue" })],
        skepticResults: [skepticKeep("cluster-001")],
        options: { maxFindings: 20, includeNiceToHave: false, judgeEnabled: false, skepticEnabled: true },
      }),
    );
    // high severity → should_fix_before_review via deterministicClassification
    expect(section(md, "Should Fix Before Human Review")).toContain("### high sev issue");
    const raw = section(md, "Raw Artifacts");
    expect(raw).not.toContain("ranked_findings.json");
    expect(raw).not.toContain("final_findings.json");
    expect(section(md, "Summary")).not.toContain("ranked");
  });

  it("degrades when the skeptic is disabled: no support signal, no skeptic funnel segment", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [finalFinding({ skeptic_support_level: null })],
        skepticResults: [],
        options: { maxFindings: 20, includeNiceToHave: false, judgeEnabled: true, skepticEnabled: false },
      }),
    );
    expect(md).not.toContain("**Skeptic support:**");
    expect(section(md, "Summary")).not.toContain("after skeptic");
    expect(section(md, "Raw Artifacts")).not.toContain("skeptic_results.json");
  });

  it("degrades when both judge and skeptic are disabled: body from clusters, no drops", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: null,
        ranked: null,
        clusters: [cluster({ cluster_id: "cluster-001", severity: "blocker", merged_title: "blocking bug" })],
        candidates: [cluster({ cluster_id: "cluster-001", severity: "blocker", merged_title: "blocking bug" })],
        skepticResults: [],
        options: { maxFindings: 20, includeNiceToHave: false, judgeEnabled: false, skepticEnabled: false },
      }),
    );
    expect(section(md, "Must Fix Before Human Review")).toContain("### blocking bug");
    expect(section(md, "Dropped Findings")).toContain("_None._");
    const raw = section(md, "Raw Artifacts");
    expect(raw).not.toContain("skeptic_results.json");
    expect(raw).not.toContain("ranked_findings.json");
  });

  it("computes the readiness verdict across its branches", () => {
    const ready = renderMarkdownReport(
      makeInput({
        final: [finalFinding({ final_classification: "nice_to_have" })],
        options: { maxFindings: 20, includeNiceToHave: true, judgeEnabled: true, skepticEnabled: true },
      }),
    );
    expect(section(ready, "Summary")).toContain("Verification not run — pass `--verify`");

    const needsWork = renderMarkdownReport(
      makeInput({ final: [finalFinding({ final_classification: "should_fix_before_review" })] }),
    );
    expect(section(needsWork, "Summary")).toContain("Needs work — 1 item");

    const notReady = renderMarkdownReport(makeInput({ final: [finalFinding({ final_classification: "blocker" })] }));
    expect(section(notReady, "Summary")).toContain("Not ready — 1 blocker");

    const caution = renderMarkdownReport(
      makeInput({
        final: [finalFinding({ final_classification: "nice_to_have" })],
        options: { maxFindings: 20, includeNiceToHave: false, judgeEnabled: true, skepticEnabled: true },
        packet: makeReviewPacket({
          verification: { enabled: true, ran: true, allPassed: false, install: null, commands: [] },
        }),
      }),
    );
    expect(section(caution, "Summary")).toContain("Caution — no blockers found, but verification failed");
  });

  it("is deterministic and ends with a trailing newline", () => {
    const a = renderMarkdownReport(makeInput());
    const b = renderMarkdownReport(makeInput());
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);
    expect(a).toContain("_Generated by pr-war-room v0.1.0 at 2026-01-01T00:00:00.000Z._");
  });

  it("sanitizes newlines in titles and evidence so structure can't break", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [finalFinding({ merged_title: "line one\nline two", evidence: ["ev one\nev two"] })],
      }),
    );
    expect(md).toContain("### line one line two");
    expect(md).toContain("- ev one ev two");
    expect(md).not.toContain("### line one\nline two");
  });

  // Regression (report-renderer bug #1): findings that SURVIVE but are hidden as
  // optionals (the default includeNiceToHave=false path) must not be reported as
  // "dropped" — that contradicted the Findings line and "Dropped Findings: None".
  it("does not claim findings were dropped when they survived but are hidden optionals", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [
          finalFinding({ cluster_id: "n1", merged_title: "nit one", final_classification: "nice_to_have" }),
          finalFinding({ cluster_id: "n2", merged_title: "nit two", final_classification: "nice_to_have" }),
        ],
        ranked: [],
        skepticResults: [],
        clusters: [cluster({ cluster_id: "n1" }), cluster({ cluster_id: "n2" })],
        candidates: [cluster({ cluster_id: "n1" }), cluster({ cluster_id: "n2" })],
        rawFindingCount: 2,
        options: { maxFindings: 20, includeNiceToHave: false, judgeEnabled: true, skepticEnabled: true },
      }),
    );
    const summary = section(md, "Summary");
    expect(summary).not.toContain("All findings were dropped");
    expect(summary).toContain("All surviving findings are optional and hidden");
    // The note must agree with the rest of the report, which shows nothing dropped.
    expect(section(md, "Dropped Findings")).toContain("_None._");
    expect(summary).toContain("2 optional findings hidden");
    expect(summary).toContain("Looks ready for human review");
  });

  // Regression (report-renderer bug #2): untrusted model/subprocess text that
  // contains its own ``` fence must not close the outer fence early.
  it("grows the code fence so model text containing a fence cannot close it early", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [
          finalFinding({
            merged_title: "has fenced fix",
            suggested_fix: "Wrap it:\n```ts\nfoo()\n```",
          }),
        ],
      }),
    );
    // Outer fence grew to 4 backticks (one more than the inner ``` run)…
    expect(md).toContain("````");
    // …so the inner fence and its body survive verbatim, and the report body
    // after the finding (Raw Artifacts) is not corrupted.
    expect(md).toContain("```ts");
    expect(md).toContain("foo()");
    expect(md).toContain("## Raw Artifacts");
  });

  // Regression (report-renderer bug #3): the maxFindings cap may shrink the body,
  // but the verdict/counts stay on the true totals, capped high-priority items are
  // named (not called "lower-priority"), and a capped class never reads "_None._".
  it("says explicitly when the cap hides blockers/should-fix and never calls them lower-priority", () => {
    const md = renderMarkdownReport(
      makeInput({
        options: { maxFindings: 1, includeNiceToHave: true, judgeEnabled: true, skepticEnabled: true },
        final: [
          finalFinding({ cluster_id: "b1", merged_title: "blocker one", final_classification: "blocker", final_score: 0.9 }),
          finalFinding({ cluster_id: "b2", merged_title: "blocker two", final_classification: "blocker", final_score: 0.8 }),
          finalFinding({ cluster_id: "s1", merged_title: "should fix one", final_classification: "should_fix_before_review", final_score: 0.7 }),
        ],
      }),
    );
    const summary = section(md, "Summary");
    // Verdict + counts reflect all survivors, not just what fit under the cap.
    expect(summary).toContain("Not ready — 2 blockers");
    expect(summary).toContain(
      "2 findings beyond the `maxFindings=1` limit not shown — including 1 blocker, 1 should-fix",
    );
    expect(md).not.toContain("lower-priority");
    // The Should Fix section is not empty-vs-summary contradictory.
    const shouldFix = section(md, "Should Fix Before Human Review");
    expect(shouldFix).not.toContain("_None._");
    expect(shouldFix).toContain("not shown — capped by `maxFindings`");
    // Must Fix shows one blocker and flags the other as capped, not dropped.
    const mustFix = section(md, "Must Fix Before Human Review");
    expect(mustFix).toContain("### blocker one");
    expect(mustFix).toContain("1 more finding not shown — capped by `maxFindings`");
  });

  // Regression (report-renderer bug #4): inline markdown metacharacters and a
  // standalone \r in untrusted text must be neutralized so they cannot inject
  // links/code spans/HTML into a heading or list item.
  it("escapes inline markdown metacharacters and standalone carriage returns", () => {
    const md = renderMarkdownReport(
      makeInput({
        final: [
          finalFinding({
            merged_title: "Bad [link](http://evil) `code` <x>\rtail",
            claim: "see [a](b) and `c`",
            evidence: ["ev with `tick` and <tag>"],
          }),
        ],
      }),
    );
    expect(md).toContain("\\[");
    expect(md).toContain("\\]");
    expect(md).toContain("\\`");
    expect(md).toContain("\\<");
    expect(md).toContain("\\>");
    // No unescaped injection survives in the heading, and the lone \r is gone.
    expect(md).not.toContain("### Bad [link](http://evil)");
    expect(md).not.toContain("\r");
  });
});
