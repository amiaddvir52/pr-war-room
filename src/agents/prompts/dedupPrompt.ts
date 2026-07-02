import type { Finding } from "../../findings/schema.js";

/**
 * Prompt for the dedup adjudicator (Phase 7). It is only consulted for the
 * "gray zone" — pairs the heuristics find plausibly-but-not-clearly duplicate —
 * so the question is narrow: do these two findings describe the *same underlying
 * issue*? The model returns a single boolean.
 */

export function buildDedupSystemPrompt(): string {
  return [
    "You are the deduplication adjudicator for an AI code-review tool.",
    "Two independent reviewers may report the same underlying issue in different",
    "words. Given two findings, decide whether they describe the SAME underlying",
    "issue — the same root cause in the same place — such that a human reviewer",
    "would treat them as one comment.",
    "",
    "Answer true only when merging them loses no distinct, actionable concern.",
    "Different issues that merely touch nearby code are NOT the same issue.",
    "",
    'Respond with ONLY this JSON object, nothing else: {"same_issue": boolean}',
  ].join("\n");
}

function renderFinding(label: string, f: Finding): string {
  const lines =
    f.line_start === 0 && f.line_end === 0 ? "file-level" : `lines ${f.line_start}-${f.line_end}`;
  return [
    `${label}:`,
    `  file: ${f.file ?? "(none)"} (${lines})`,
    `  category: ${f.category}`,
    `  title: ${f.title}`,
    `  claim: ${f.claim}`,
  ].join("\n");
}

export function buildDedupUserPrompt(a: Finding, b: Finding): string {
  return [
    "Are these two findings about the same underlying issue?",
    "",
    renderFinding("Finding A", a),
    "",
    renderFinding("Finding B", b),
  ].join("\n");
}
