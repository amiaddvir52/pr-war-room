import type { PacketVerification, ReviewPacket } from "../../context/types.js";
import { findChangedFile } from "../../findings/evidenceChecks.js";
import type { FindingCluster } from "../../findings/schema.js";

/**
 * Shared prompt fragments for the per-cluster agents (skeptic Phase 8, judge
 * Phase 9). Both are handed one cluster plus the concrete slice of the review
 * packet it points at, so they render the cluster, its focus file, and the
 * verification summary the same way. Kept here so the two prompts can't drift.
 */

/** Render the cluster under review: its metadata, claim, evidence, and fix. */
export function renderCluster(cluster: FindingCluster): string {
  const lines =
    cluster.line_start === 0 && cluster.line_end === 0
      ? "file-level (no line range)"
      : `lines ${cluster.line_start}-${cluster.line_end}`;
  const evidence = cluster.evidence.map((e) => `  - ${e}`).join("\n");
  return [
    `Title: ${cluster.merged_title}`,
    `Category: ${cluster.category}`,
    `Severity: ${cluster.severity}`,
    `File: ${cluster.file ?? "(none)"} (${lines})`,
    `Reported by ${cluster.agreement} independent reviewer(s): ${cluster.source_agents.join(", ")}`,
    `Claim: ${cluster.claim}`,
    "Evidence the reviewers cited:",
    evidence,
    `Suggested fix: ${cluster.suggested_fix ?? "(none)"}`,
  ].join("\n");
}

/** Render only the changed file the finding points at, to keep the prompt focused. */
export function renderFocusFile(cluster: FindingCluster, packet: ReviewPacket): string {
  if (cluster.file === null) {
    return "This is a file-level finding with no specific file. Use the PR context to judge it.";
  }
  // Reuse the deterministic file matcher so the rendered evidence can't drift
  // from the `file_in_changeset` signal the gate acts on.
  const file = findChangedFile(cluster.file, packet);
  if (file === undefined) {
    return `The referenced file "${cluster.file}" is NOT among the PR's changed files.`;
  }
  const parts = [`File: ${file.path} (status: ${file.status}, +${file.additions}/-${file.deletions})`];
  if (file.patch !== null && !file.patchOmitted) {
    parts.push("Diff:", "```diff", file.patch, "```");
  } else {
    parts.push("(Diff omitted — binary or too large.)");
  }
  if (file.nearbyContext !== null) {
    parts.push("Nearby code (line-numbered):", "```", file.nearbyContext, "```");
  }
  return parts.join("\n");
}

/** Render the PR's verification outcome (tests/lint/build) in one line. */
export function renderVerification(verification: PacketVerification): string {
  if (!verification.ran) return "Verification: not run.";
  const failed = verification.commands.filter((c) => !c.passed).map((c) => c.command);
  if (verification.allPassed) return "Verification: all configured commands passed.";
  return `Verification: some commands FAILED: ${failed.join(", ") || "(see packet)"}.`;
}
