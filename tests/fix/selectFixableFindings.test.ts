import { describe, it, expect } from "vitest";
import { selectFixableFindings } from "../../src/fix/selectFixableFindings.js";
import { makeFinalFinding } from "../fixtures/finalFinding.js";

describe("selectFixableFindings", () => {
  it("keeps only needs_code_change blockers and should-fixes", () => {
    const findings = [
      makeFinalFinding({ cluster_id: "c1", final_classification: "blocker" }),
      makeFinalFinding({ cluster_id: "c2", final_classification: "should_fix_before_review" }),
      makeFinalFinding({ cluster_id: "c3", final_classification: "nice_to_have" }),
      makeFinalFinding({ cluster_id: "c4", needs_code_change: false }),
    ];
    const { fixable, selected } = selectFixableFindings(findings, 10);
    expect(fixable.map((f) => f.cluster_id)).toEqual(["c1", "c2"]);
    expect(selected.map((f) => f.cluster_id)).toEqual(["c1", "c2"]);
  });

  it("caps at maxFindings, keeping the head of the already-sorted array", () => {
    const findings = ["c1", "c2", "c3"].map((id) => makeFinalFinding({ cluster_id: id }));
    const { fixable, selected } = selectFixableFindings(findings, 2);
    expect(fixable).toHaveLength(3);
    expect(selected.map((f) => f.cluster_id)).toEqual(["c1", "c2"]);
  });

  it("returns empty selections for an empty input", () => {
    expect(selectFixableFindings([], 5)).toEqual({ fixable: [], selected: [] });
  });
});
