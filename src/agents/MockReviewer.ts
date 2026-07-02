import type { FindingCore } from "../findings/schema.js";
import type { RawAgentResult, ReviewerAgent, ReviewerInput } from "./types.js";

/**
 * An offline reviewer that fabricates a small, deterministic set of findings
 * from the packet's changed files — no API call. Selected via a `mock` backend
 * in `agents.reviewers`. It lets CI and demos exercise the full review flow with
 * no API key, and satisfies the PRD note that the adapter "may call a local
 * command, SDK, or mocked model provider depending on config". The `name`
 * defaults to `"mock"` but is configurable so several mock agents can coexist.
 */
export class MockReviewer implements ReviewerAgent {
  readonly name: string;

  constructor(name = "mock") {
    this.name = name;
  }

  async review(input: ReviewerInput): Promise<RawAgentResult> {
    const findings = buildMockFindings(input);
    const rawText = JSON.stringify({ findings }, null, 2);
    return { rawText, findings, parseError: null };
  }
}

const CODE_FILE = /\.(ts|tsx|js|jsx|py|go|rb|java|rs)$/;
const TEST_FILE = /(test|spec|__tests__)/i;

function buildMockFindings(input: ReviewerInput): FindingCore[] {
  const files = input.packet.changedFiles;
  if (files.length === 0) return [];

  const findings: FindingCore[] = [];

  const first = files[0]!;
  findings.push({
    title: `Double-check edge cases in ${first.path}`,
    category: "correctness",
    severity: "medium",
    confidence: 0.6,
    file: first.path,
    line_start: 1,
    line_end: 1,
    claim: `The changes in ${first.path} should be reviewed for unhandled edge cases (mock finding).`,
    evidence: [`${first.path} changed with +${first.additions}/-${first.deletions} lines.`],
    suggested_fix: null,
    suggested_test: `Add a test exercising the new behavior in ${first.path}.`,
    human_review_likelihood: 0.5,
    needs_code_change: false,
  });

  const untested = files.find((f) => CODE_FILE.test(f.path) && !TEST_FILE.test(f.path));
  if (untested) {
    findings.push({
      title: `Missing test coverage for ${untested.path}`,
      category: "tests",
      severity: "low",
      confidence: 0.55,
      file: untested.path,
      line_start: 0,
      line_end: 0,
      claim: `No matching test change was detected for ${untested.path} (mock finding).`,
      evidence: [`${untested.path} changed but no corresponding test file appears in the diff.`],
      suggested_fix: null,
      suggested_test: `Add tests covering ${untested.path}.`,
      human_review_likelihood: 0.45,
      needs_code_change: false,
    });
  }

  return findings;
}
