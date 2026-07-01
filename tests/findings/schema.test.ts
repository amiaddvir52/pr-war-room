import { describe, it, expect } from "vitest";
import { FindingCoreSchema, ReviewerResponseSchema } from "../../src/findings/schema.js";

function core(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Possible null deref",
    category: "correctness",
    severity: "high",
    confidence: 0.7,
    file: "src/a.ts",
    line_start: 10,
    line_end: 12,
    claim: "x may be undefined here",
    evidence: ["the diff removes the guard on x"],
    suggested_fix: null,
    suggested_test: null,
    human_review_likelihood: 0.6,
    needs_code_change: true,
    ...overrides,
  };
}

describe("FindingCoreSchema", () => {
  it("accepts a well-formed core finding", () => {
    expect(FindingCoreSchema.safeParse(core()).success).toBe(true);
  });

  it("accepts a null file (repo-level finding)", () => {
    expect(FindingCoreSchema.safeParse(core({ file: null })).success).toBe(true);
  });

  it("rejects confidence outside [0,1]", () => {
    expect(FindingCoreSchema.safeParse(core({ confidence: 1.5 })).success).toBe(false);
    expect(FindingCoreSchema.safeParse(core({ human_review_likelihood: -0.1 })).success).toBe(false);
  });

  it("rejects empty evidence", () => {
    expect(FindingCoreSchema.safeParse(core({ evidence: [] })).success).toBe(false);
  });

  it("rejects an unknown category or severity", () => {
    expect(FindingCoreSchema.safeParse(core({ category: "bogus" })).success).toBe(false);
    expect(FindingCoreSchema.safeParse(core({ severity: "critical" })).success).toBe(false);
  });
});

describe("ReviewerResponseSchema", () => {
  it("wraps an array of findings", () => {
    const parsed = ReviewerResponseSchema.safeParse({ findings: [core()] });
    expect(parsed.success).toBe(true);
  });

  it("accepts an empty findings array", () => {
    expect(ReviewerResponseSchema.safeParse({ findings: [] }).success).toBe(true);
  });

  it("rejects a missing findings key", () => {
    expect(ReviewerResponseSchema.safeParse({}).success).toBe(false);
  });
});
