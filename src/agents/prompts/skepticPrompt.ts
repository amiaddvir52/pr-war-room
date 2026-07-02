import type { PacketVerification, ReviewPacket } from "../../context/types.js";
import { findChangedFile } from "../../findings/evidenceChecks.js";
import type { EvidenceChecks, FindingCluster } from "../../findings/schema.js";

/**
 * Prompt for the skeptic (Phase 8, PRD §10.7). The skeptic's job is to try to
 * *disprove* a finding: it is handed one cluster plus the concrete evidence it
 * needs (the relevant changed file's diff and nearby code, the deterministic
 * checks, and the verification summary) and must decide whether the finding
 * survives. It returns a single verdict object.
 */

export function buildSkepticSystemPrompt(): string {
  return [
    "You are the skeptic for an AI code-review tool. Multiple reviewers proposed",
    "findings on a pull request. Your job is to try to DISPROVE each finding —",
    "not to agree with it. Assume the reviewers may be wrong until the evidence",
    "shows otherwise. Reducing false positives is the whole point of your role.",
    "",
    "For the finding, work through these questions:",
    "1. Does the referenced file exist and is it actually part of this change?",
    "2. Does the referenced line range exist and relate to the changed code?",
    "3. Is the issue really in the diff, or directly affected by it — or is it",
    "   pre-existing code the PR did not touch?",
    "4. Does existing code already handle the concern (guard, validation, etc.)?",
    "5. Is the case already covered by an existing test?",
    "6. Is the finding concrete and actionable, or vague/stylistic?",
    "7. Would the suggested fix introduce new risk?",
    "",
    "You are given deterministic check results. Trust them: if they say the file",
    "is not in the changeset or the lines are unrelated to the diff, the finding",
    "is almost certainly a false positive — say so.",
    "",
    "Calibrate honestly. Default to a LOWER support level when the evidence is",
    "thin. Only recommend \"drop\" when the finding is genuinely unsupported and",
    "the risk of it being a false positive is high. Use \"downgrade\" for weak but",
    "not-clearly-wrong findings, and \"keep\" for well-supported ones.",
    "",
    "Respond with ONLY this JSON object, nothing else:",
    "{",
    '  "is_supported": boolean,',
    '  "support_level": "strong" | "medium" | "weak" | "unsupported",',
    '  "false_positive_risk": "low" | "medium" | "high",',
    '  "reasoning_summary": string,',
    '  "recommended_action": "keep" | "downgrade" | "drop"',
    "}",
  ].join("\n");
}

function renderCluster(cluster: FindingCluster): string {
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
function renderFocusFile(cluster: FindingCluster, packet: ReviewPacket): string {
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

function renderChecks(checks: EvidenceChecks): string {
  const flag = (b: boolean | null): string => (b === null ? "n/a" : b ? "yes" : "NO");
  const lines = [
    "Deterministic check results:",
    `  file in changeset: ${flag(checks.signals.file_in_changeset)}`,
    `  has line anchor:   ${flag(checks.signals.has_line_anchor)}`,
    `  overlaps the diff: ${flag(checks.signals.line_in_diff)}`,
    `  near the diff:     ${flag(checks.signals.line_near_diff)}`,
  ];
  for (const f of checks.hard_failures) lines.push(`  HARD FAILURE (${f.code}): ${f.message}`);
  for (const w of checks.soft_warnings) lines.push(`  warning (${w.code}): ${w.message}`);
  for (const n of checks.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

function renderVerification(verification: PacketVerification): string {
  if (!verification.ran) return "Verification: not run.";
  const failed = verification.commands.filter((c) => !c.passed).map((c) => c.command);
  if (verification.allPassed) return "Verification: all configured commands passed.";
  return `Verification: some commands FAILED: ${failed.join(", ") || "(see packet)"}.`;
}

export function buildSkepticUserPrompt(
  cluster: FindingCluster,
  packet: ReviewPacket,
  checks: EvidenceChecks,
): string {
  const header = packet.pr.description
    ? `Pull request: ${packet.pr.title}\nDescription: ${packet.pr.description}`
    : `Pull request: ${packet.pr.title}`;
  return [
    header,
    "",
    "----- FINDING UNDER REVIEW -----",
    renderCluster(cluster),
    "",
    "----- RELEVANT CHANGED CODE -----",
    renderFocusFile(cluster, packet),
    "",
    "----- CHECKS -----",
    renderChecks(checks),
    renderVerification(packet.verification),
    "",
    "Try to disprove the finding, then return your verdict as the JSON object.",
  ].join("\n");
}
