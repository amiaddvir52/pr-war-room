import { describe, it, expect } from "vitest";
import { normalizeFindings } from "../../src/findings/normalizeFindings.js";
import { FindingSchema } from "../../src/findings/schema.js";
import type { FindingCore } from "../../src/findings/schema.js";

function core(title: string): FindingCore {
  return {
    title,
    category: "correctness",
    severity: "medium",
    confidence: 0.6,
    file: "src/a.ts",
    line_start: 1,
    line_end: 2,
    claim: "c",
    evidence: ["e"],
    suggested_fix: null,
    suggested_test: null,
    human_review_likelihood: 0.5,
    needs_code_change: false,
  };
}

describe("normalizeFindings", () => {
  it("assigns sequential ids and provenance", () => {
    const findings = normalizeFindings([core("a"), core("b")], {
      agent: "claude",
      rawRef: "raw/claude_review.md",
    });

    expect(findings.map((f) => f.id)).toEqual(["claude-001", "claude-002"]);
    for (const f of findings) {
      expect(f.source_agent).toBe("claude");
      expect(f.raw_agent_output_ref).toBe("raw/claude_review.md");
    }
  });

  it("produces findings that satisfy the full FindingSchema", () => {
    const findings = normalizeFindings([core("a")], { agent: "mock", rawRef: "raw/mock_review.md" });
    expect(() => FindingSchema.array().parse(findings)).not.toThrow();
  });

  it("returns an empty array for no findings", () => {
    expect(normalizeFindings([], { agent: "claude", rawRef: "raw/claude_review.md" })).toEqual([]);
  });
});
