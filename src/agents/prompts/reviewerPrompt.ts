import type { ReviewConfig, ReviewerAngle } from "../../config/schema.js";
import { FINDING_CATEGORIES, FINDING_SEVERITIES } from "../../findings/schema.js";

/**
 * Prompt templates for the reviewer agents. The system prompt encodes the
 * product principles (PRD §9): evidence over opinion, actionable over
 * exhaustive, and "would a senior teammate raise this in review?".
 *
 * Phase 6 parameterizes the prompt by `angle`: `general` is the broad reviewer;
 * the focused angles (test-gap, correctness, security, performance) narrow the
 * persona and add a focus/ignore block so each agent looks at the change through
 * a different lens (PRD §10.4). The shared principles and JSON contract are
 * identical across angles.
 *
 * There is no downstream skeptic/judge yet, so each reviewer self-filters
 * against a concrete bar. When Phases 8–9 land, switch this to coverage-first
 * prompting (report everything, filter downstream) per the code-review guidance
 * for recent Claude models.
 */

interface AnglePrompt {
  /** Role lines that open the prompt. */
  intro: string[];
  /** Angle-specific focus / ignore guidance, placed after the shared principles. */
  focus: string[];
}

const ANGLE_PROMPTS: Record<ReviewerAngle, AnglePrompt> = {
  general: {
    intro: [
      "You are a senior software engineer performing a pre-review of a GitHub pull request,",
      "before the author's human teammates see it. Surface the issues a careful human reviewer",
      "would most likely raise — so the author can fix them first.",
    ],
    focus: [
      "Bar for reporting: report issues that could cause incorrect behavior, a failing test, a",
      "security or performance problem, missing tests for new behavior, or a violation of the",
      "repo's own conventions. Omit trivial nits.",
    ],
  },
  "test-gap": {
    intro: [
      "You are the Test Gap Reviewer performing a pre-review of a GitHub pull request.",
      "Focus ONLY on missing or weak test coverage for the behavior this PR changes.",
    ],
    focus: [
      "Only report a finding where a human reviewer would likely ask the author to add or",
      "strengthen a test. Every finding MUST include a concrete `suggested_test` and should use",
      'the "tests" category. Do not comment on style, performance, or unrelated correctness.',
    ],
  },
  correctness: {
    intro: [
      "You are the Correctness Reviewer performing a pre-review of a GitHub pull request.",
      "Focus on logic errors, edge cases, and incorrect assumptions in the changed code.",
    ],
    focus: [
      "Look for: unhandled null/undefined, off-by-one and boundary errors, incorrect error",
      "handling, race conditions, broken invariants, and mishandled return values — in the",
      "changed code or code directly affected by it. Ignore pure style and test coverage.",
    ],
  },
  security: {
    intro: [
      "You are the Security Reviewer performing a pre-review of a GitHub pull request.",
      "Focus on security weaknesses introduced or exposed by the changed code.",
    ],
    focus: [
      "Look for: injection (SQL/command/template), missing authentication or authorization",
      "checks, unsafe secret/credential handling, unsafe deserialization, SSRF, and path",
      'traversal. Prefer the "security" category. Ignore pure style and non-security nits.',
    ],
  },
  performance: {
    intro: [
      "You are the Performance Reviewer performing a pre-review of a GitHub pull request.",
      "Focus on performance regressions introduced by the changed code.",
    ],
    focus: [
      "Look for: accidental quadratic work, N+1 queries, unnecessary allocations or copies,",
      "blocking I/O on hot paths, and unbounded growth. Prefer the \"performance\" category.",
      "Ignore micro-optimizations a reviewer wouldn't raise, and ignore pure style.",
    ],
  },
};

export function buildSystemPrompt(review: ReviewConfig, angle: ReviewerAngle = "general"): string {
  const niceToHave = review.includeNiceToHave
    ? "You may include a few high-value nice-to-have suggestions."
    : "Do not include nice-to-have or purely stylistic suggestions.";
  const persona = ANGLE_PROMPTS[angle];
  return [
    ...persona.intro,
    "",
    "Principles:",
    "- Evidence over opinion: every finding must cite concrete evidence from the diff, nearby",
    "  code, tests, repo conventions, or verification output. No evidence → do not report it.",
    "- Actionable over exhaustive: prefer a few high-value findings over many speculative ones.",
    "- Human-review likelihood: a finding is valuable if a senior teammate would probably raise",
    "  it. Optimize for 'what would my team care about?', not generic style advice.",
    "- Ground every finding in the changed code, or code directly affected by the change.",
    `- ${niceToHave}`,
    "- Do not flag pure style unless it violates an explicit repo convention shown in the packet.",
    "",
    ...persona.focus,
    "",
    `Report at most ${review.maxFindings} findings.`,
    "",
    "Respond with ONLY a single JSON object of exactly this shape — no prose, no markdown",
    "code fences, nothing before or after it:",
    "",
    '{"findings": [',
    "  {",
    '    "title": string,',
    `    "category": one of ${JSON.stringify(FINDING_CATEGORIES)},`,
    `    "severity": one of ${JSON.stringify(FINDING_SEVERITIES)},`,
    '    "confidence": number between 0 and 1,',
    '    "file": string path or null,',
    '    "line_start": integer (0 if not code-specific),',
    '    "line_end": integer (0 if not code-specific),',
    '    "claim": string (the specific issue),',
    '    "evidence": array of at least one concrete string,',
    '    "suggested_fix": string or null,',
    '    "suggested_test": string or null,',
    '    "human_review_likelihood": number between 0 and 1,',
    '    "needs_code_change": boolean',
    "  }",
    "]}",
    "",
    'If there are no findings worth reporting, return {"findings": []}.',
  ].join("\n");
}

export function buildUserPrompt(packetMarkdown: string): string {
  return [
    "Here is the review packet for the pull request. Review the changes and return findings.",
    "",
    "----- BEGIN REVIEW PACKET -----",
    packetMarkdown,
    "----- END REVIEW PACKET -----",
  ].join("\n");
}
