import type { ReviewPacket } from "../../context/types.js";
import type { FindingCluster, SkepticResult } from "../../findings/schema.js";
import { renderCluster, renderFocusFile, renderVerification } from "./renderContext.js";

/**
 * Prompt for the judge (Phase 9, PRD §10.8). The judge classifies a
 * skeptic-supported cluster by how much a human reviewer would care about it. It
 * is given one cluster, the skeptic's support summary, the relevant changed
 * code, and the verification outcome, and returns a single verdict object.
 *
 * The system prompt states the division of labour explicitly: the skeptic has
 * ALREADY decided whether the finding is real, so the judge should not
 * re-litigate evidence — it decides *value and priority*. This keeps the two
 * roles from stepping on each other (double-jeopardy on the same axis).
 */

export function buildJudgeSystemPrompt(): string {
  return [
    "You are the judge for an AI pre-review tool. Independent reviewers proposed",
    "findings on a pull request, duplicates were merged, and a skeptic already",
    "validated that each finding is supported by the evidence. Your job is NOT to",
    "re-check whether the finding is real — trust the skeptic on that. Your job is",
    "to decide how much a human reviewer would CARE: rank findings by practical",
    "usefulness and the likelihood a senior teammate would raise them in review.",
    "",
    "Classify the finding as exactly one of:",
    "  - \"blocker\": must be fixed before a human reviews; a correctness/security",
    "    defect, data loss, or a broken contract introduced by this change.",
    "  - \"should_fix_before_review\": a real issue a reviewer would very likely",
    "    comment on and want addressed, but not release-blocking.",
    "  - \"nice_to_have\": a minor or optional improvement; worth mentioning but a",
    "    reviewer might reasonably let it slide.",
    "  - \"drop\": low-value or noise — purely stylistic (without violating an",
    "    explicit repo convention), speculative, or something a reviewer would not",
    "    bother raising. Use this to keep the final report short and actionable.",
    "",
    "Apply this rubric — keep a finding (i.e. do NOT drop it) only if ALL hold:",
    "  1. It is grounded in the changed code or directly affected surrounding code.",
    "  2. It is actionable.",
    "  3. It includes concrete evidence.",
    "  4. It is likely to matter to a human reviewer.",
    "  5. It is not purely stylistic unless it violates an explicit repo convention.",
    "  6. The proposed fix is safer than ignoring the issue.",
    "",
    "Prefer five useful findings over twenty speculative ones (§9.2). Independent",
    "agreement between reviewers and a strong skeptic support level are signals",
    "the finding matters; weak support and a single low-confidence reviewer are",
    "signals it may be noise. Do not inflate severity — a stylistic nit is never a",
    "blocker, however confident the reviewer was.",
    "",
    "Also return a model_score in [0, 1] reflecting your own sense of the finding's",
    "usefulness (1 = a reviewer would definitely raise it; 0 = pure noise). This is",
    "advisory; the tool computes the authoritative ordering score itself.",
    "",
    "Respond with ONLY this JSON object, nothing else:",
    "{",
    '  "final_classification": "blocker" | "should_fix_before_review" | "nice_to_have" | "drop",',
    '  "model_score": number,',
    '  "reasoning_summary": string',
    "}",
  ].join("\n");
}

/** Summarize the skeptic's outcome so the judge builds on it instead of redoing it. */
function renderSkepticSummary(skeptic: SkepticResult | null): string {
  if (skeptic === null) {
    return "Skeptic: did not run for this finding (skeptic disabled); weigh the evidence yourself.";
  }
  const verdict = skeptic.model_verdict;
  const lines = [
    `Skeptic decision: ${skeptic.decision.action} (via ${skeptic.source}).`,
  ];
  if (verdict !== null) {
    lines.push(
      `Skeptic support level: ${verdict.support_level}; false-positive risk: ${verdict.false_positive_risk}.`,
      `Skeptic reasoning: ${verdict.reasoning_summary}`,
    );
  } else {
    lines.push("Skeptic support: validated by deterministic checks only (no model verdict).");
  }
  if (skeptic.decision.softened_from_model_action !== null) {
    lines.push(
      `Note: the skeptic's "${skeptic.decision.softened_from_model_action}" was softened to "${skeptic.decision.action}" for recall.`,
    );
  }
  return lines.join("\n");
}

export function buildJudgeUserPrompt(
  cluster: FindingCluster,
  skeptic: SkepticResult | null,
  packet: ReviewPacket,
): string {
  const header = packet.pr.description
    ? `Pull request: ${packet.pr.title}\nDescription: ${packet.pr.description}`
    : `Pull request: ${packet.pr.title}`;
  return [
    header,
    "",
    "----- FINDING TO RANK -----",
    renderCluster(cluster),
    `Reviewer confidence: ${cluster.confidence}; estimated human-review likelihood: ${cluster.human_review_likelihood}.`,
    "",
    "----- SKEPTIC RESULT -----",
    renderSkepticSummary(skeptic),
    "",
    "----- RELEVANT CHANGED CODE -----",
    renderFocusFile(cluster, packet),
    "",
    "----- VERIFICATION -----",
    renderVerification(packet.verification),
    "",
    "Classify and score the finding, then return your verdict as the JSON object.",
  ].join("\n");
}
