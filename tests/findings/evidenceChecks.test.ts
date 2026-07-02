import { describe, it, expect } from "vitest";
import {
  findChangedFile,
  hasHardFailure,
  normalizeAnchor,
  runEvidenceChecks,
} from "../../src/findings/evidenceChecks.js";
import type { EvidenceChecks, FindingCluster } from "../../src/findings/schema.js";
import type { PacketChangedFile } from "../../src/context/types.js";
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

function changedFile(overrides: Partial<PacketChangedFile> = {}): PacketChangedFile {
  return {
    path: "src/a.ts",
    status: "modified",
    previousPath: null,
    additions: 5,
    deletions: 2,
    patchOmitted: false,
    // A hunk covering new-file lines 10..14.
    patch: "@@ -10,5 +10,5 @@ function f() {\n context\n-old\n+new\n context\n context",
    nearbyContext: null,
    ...overrides,
  };
}

const packetWith = (files: PacketChangedFile[]) => makeReviewPacket({ changedFiles: files });
const codes = (issues: EvidenceChecks["soft_warnings"]) => issues.map((i) => i.code);

describe("normalizeAnchor", () => {
  it("treats (0, 0) as no anchor", () => {
    expect(normalizeAnchor(0, 0)).toMatchObject({ hasAnchor: false });
  });

  it("normalizes a partial anchor to the present bound (never line 0)", () => {
    expect(normalizeAnchor(0, 42)).toMatchObject({ hasAnchor: true, start: 42, end: 42, partial: true });
    expect(normalizeAnchor(42, 0)).toMatchObject({ hasAnchor: true, start: 42, end: 42, partial: true });
  });

  it("collapses an inverted anchor to a single line", () => {
    expect(normalizeAnchor(14, 10)).toMatchObject({ hasAnchor: true, start: 14, end: 14, inverted: true });
  });

  it("passes a normal range through", () => {
    expect(normalizeAnchor(10, 12)).toMatchObject({ hasAnchor: true, start: 10, end: 12, partial: false, inverted: false });
  });
});

describe("findChangedFile", () => {
  it("matches by path and by rename source", () => {
    const packet = packetWith([changedFile({ path: "src/new.ts", previousPath: "src/old.ts" })]);
    expect(findChangedFile("src/new.ts", packet)?.path).toBe("src/new.ts");
    expect(findChangedFile("src/old.ts", packet)?.path).toBe("src/new.ts");
    expect(findChangedFile("src/missing.ts", packet)).toBeUndefined();
  });
});

describe("runEvidenceChecks", () => {
  it("passes vacuously for a file-level finding (file === null)", () => {
    const checks = runEvidenceChecks(cluster({ file: null, line_start: 0, line_end: 0 }), packetWith([]));
    expect(checks.signals).toMatchObject({ file_in_changeset: true, has_line_anchor: false, line_in_diff: null });
    expect(hasHardFailure(checks)).toBe(false);
  });

  it("fails hard when the referenced file is not in the changeset", () => {
    const checks = runEvidenceChecks(cluster({ file: "src/missing.ts" }), packetWith([changedFile()]));
    expect(checks.signals.file_in_changeset).toBe(false);
    expect(codes(checks.hard_failures)).toContain("file_not_in_changeset");
    expect(hasHardFailure(checks)).toBe(true);
  });

  it("passes for a file-anchored-but-line-less finding when the file changed", () => {
    const checks = runEvidenceChecks(cluster({ line_start: 0, line_end: 0 }), packetWith([changedFile()]));
    expect(checks.signals.file_in_changeset).toBe(true);
    expect(checks.signals.has_line_anchor).toBe(false);
    expect(hasHardFailure(checks)).toBe(false);
  });

  it("marks lines inside a hunk as in_diff and near, with no warnings", () => {
    const checks = runEvidenceChecks(cluster({ line_start: 11, line_end: 12 }), packetWith([changedFile()]));
    expect(checks.signals.line_in_diff).toBe(true);
    expect(checks.signals.line_near_diff).toBe(true);
    expect(checks.soft_warnings).toHaveLength(0);
    expect(hasHardFailure(checks)).toBe(false);
  });

  it("marks lines near (but outside) a hunk as near, not in_diff, and does not warn", () => {
    // Hunk covers 10..14; line 30 is within the default 20-line window of 14.
    const checks = runEvidenceChecks(cluster({ line_start: 30, line_end: 30 }), packetWith([changedFile()]));
    expect(checks.signals.line_in_diff).toBe(false);
    expect(checks.signals.line_near_diff).toBe(true);
    expect(codes(checks.soft_warnings)).not.toContain("line_outside_diff");
    expect(hasHardFailure(checks)).toBe(false);
  });

  it("warns (soft) but never hard-fails when the line is far from every hunk", () => {
    const checks = runEvidenceChecks(cluster({ line_start: 500, line_end: 500 }), packetWith([changedFile()]));
    expect(checks.signals.line_in_diff).toBe(false);
    expect(checks.signals.line_near_diff).toBe(false);
    expect(codes(checks.soft_warnings)).toContain("line_outside_diff");
    // Key recall-first change: an off-window line is NOT an objective hard failure.
    expect(hasHardFailure(checks)).toBe(false);
  });

  it("ties the nearby window to the passed value (config.context.nearbyContextLines)", () => {
    // Line 40 is 26 lines past the hunk end (14): outside the default 20 window,
    // but inside a 30-line window. The gate must follow the configured value.
    const far = cluster({ line_start: 40, line_end: 40 });
    const withDefault = runEvidenceChecks(far, packetWith([changedFile()]));
    expect(withDefault.signals.line_near_diff).toBe(false);
    expect(codes(withDefault.soft_warnings)).toContain("line_outside_diff");

    const withWide = runEvidenceChecks(far, packetWith([changedFile()]), 30);
    expect(withWide.signals.line_near_diff).toBe(true);
    expect(codes(withWide.soft_warnings)).not.toContain("line_outside_diff");
  });

  it("normalizes a partial anchor and does NOT validate it against line 0", () => {
    // A (0, 500) anchor would, if start=0 were used, spuriously overlap every
    // hunk. It must be normalized to line 500 (partial) and read as off-window.
    const checks = runEvidenceChecks(cluster({ line_start: 0, line_end: 500 }), packetWith([changedFile()]));
    expect(codes(checks.soft_warnings)).toContain("partial_anchor");
    expect(checks.signals.line_in_diff).toBe(false);
    expect(checks.signals.line_near_diff).toBe(false);
    expect(hasHardFailure(checks)).toBe(false);
  });

  it("normalizes an inverted anchor (line_end < line_start) to a single line", () => {
    const checks = runEvidenceChecks(cluster({ line_start: 14, line_end: 10 }), packetWith([changedFile()]));
    expect(codes(checks.soft_warnings)).toContain("inverted_anchor");
    expect(checks.signals.line_in_diff).toBe(true); // line 14 is inside the hunk
  });

  it("resolves a renamed file via previousPath", () => {
    const checks = runEvidenceChecks(
      cluster({ file: "src/old.ts", line_start: 11, line_end: 12 }),
      packetWith([changedFile({ path: "src/new.ts", previousPath: "src/old.ts" })]),
    );
    expect(checks.signals.file_in_changeset).toBe(true);
  });

  it("leaves line signals unknown (null) — not failing — when the patch is omitted", () => {
    const checks = runEvidenceChecks(
      cluster({ line_start: 999, line_end: 999 }),
      packetWith([changedFile({ patch: null, patchOmitted: true })]),
    );
    expect(checks.signals.line_in_diff).toBeNull();
    expect(checks.signals.line_near_diff).toBeNull();
    expect(checks.soft_warnings).toHaveLength(0);
    expect(hasHardFailure(checks)).toBe(false);
  });
});
