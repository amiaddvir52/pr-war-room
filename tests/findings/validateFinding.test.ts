import { describe, it, expect } from "vitest";
import { partitionFindings } from "../../src/findings/validateFinding.js";
import type { FindingCore } from "../../src/findings/schema.js";
import type { ReviewConfig } from "../../src/config/schema.js";

const REVIEW: ReviewConfig = { maxFindings: 20, includeNiceToHave: false };

function core(overrides: Partial<FindingCore> = {}): FindingCore {
  return {
    title: "t",
    category: "correctness",
    severity: "medium",
    confidence: 0.6,
    file: "src/a.ts",
    line_start: 1,
    line_end: 2,
    claim: "a real, actionable claim",
    evidence: ["concrete evidence"],
    suggested_fix: null,
    suggested_test: null,
    human_review_likelihood: 0.5,
    needs_code_change: false,
    ...overrides,
  };
}

describe("partitionFindings", () => {
  it("keeps a well-formed finding", () => {
    const { valid, dropped } = partitionFindings([core()], REVIEW);
    expect(valid).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it("drops findings with no actionable claim", () => {
    const { valid, dropped } = partitionFindings([core({ claim: "   " })], REVIEW);
    expect(valid).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/claim/);
  });

  it("drops findings whose evidence is all empty", () => {
    const { valid, dropped } = partitionFindings([core({ evidence: ["", "  "] })], REVIEW);
    expect(valid).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/evidence/);
  });

  it("drops a code-change finding that names no file", () => {
    const { valid, dropped } = partitionFindings(
      [core({ needs_code_change: true, file: null })],
      REVIEW,
    );
    expect(valid).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/file/);
  });

  it("drops info findings unless includeNiceToHave is set", () => {
    const dropResult = partitionFindings([core({ severity: "info" })], REVIEW);
    expect(dropResult.valid).toHaveLength(0);
    expect(dropResult.dropped[0]?.reason).toMatch(/nice-to-have/);

    const keepResult = partitionFindings([core({ severity: "info" })], {
      maxFindings: 20,
      includeNiceToHave: true,
    });
    expect(keepResult.valid).toHaveLength(1);
  });

  it("caps to maxFindings, keeping the most severe first", () => {
    const findings = [
      core({ title: "low", severity: "low" }),
      core({ title: "blocker", severity: "blocker" }),
      core({ title: "medium", severity: "medium" }),
    ];
    const { valid, dropped } = partitionFindings(findings, { maxFindings: 2, includeNiceToHave: false });
    expect(valid.map((f) => f.title)).toEqual(["blocker", "medium"]);
    expect(dropped[0]?.reason).toMatch(/maxFindings/);
  });
});
