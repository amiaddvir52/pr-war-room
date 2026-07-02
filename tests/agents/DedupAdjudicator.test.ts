import { describe, it, expect } from "vitest";
import { parseSameIssue, createDedupAdjudicator } from "../../src/agents/DedupAdjudicator.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import type { Config } from "../../src/config/schema.js";
import type { Finding } from "../../src/findings/schema.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "agent1-001",
    source_agent: "agent1",
    raw_agent_output_ref: "raw/agent1_review.md",
    title: "a finding",
    category: "correctness",
    severity: "medium",
    confidence: 0.6,
    file: "src/a.ts",
    line_start: 10,
    line_end: 12,
    claim: "a real, actionable claim",
    evidence: ["concrete evidence"],
    suggested_fix: null,
    suggested_test: null,
    human_review_likelihood: 0.5,
    needs_code_change: false,
    ...overrides,
  };
}

describe("parseSameIssue", () => {
  it("reads a bare JSON object (the structured-output / API path)", () => {
    expect(parseSameIssue('{"same_issue": true}')).toBe(true);
    expect(parseSameIssue('{"same_issue": false}')).toBe(false);
  });

  it("reads a fenced object wrapped in prose (the CLI path)", () => {
    expect(parseSameIssue('Here is my verdict:\n```json\n{"same_issue": true}\n```')).toBe(true);
  });

  it("NEVER fabricates a merge: an earlier example object does not override a later 'false'", () => {
    // The model shows an example `true`, then answers `false`. The real verdict
    // is the last object; parsing must not latch onto the earlier example.
    const text = [
      "For example the format is:",
      "```json",
      '{"same_issue": true}',
      "```",
      "My actual answer:",
      "```json",
      '{"same_issue": false}',
      "```",
    ].join("\n");
    expect(parseSameIssue(text)).toBe(false);
  });

  it("recovers a genuine 'true' that follows an un-fenced reasoning object", () => {
    // Greedy brace extraction used to span both objects and fail to parse,
    // silently dropping this real merge verdict.
    expect(parseSameIssue('Not this: {"same_issue": false}. Final answer: {"same_issue": true}')).toBe(
      true,
    );
  });

  it("fails closed to false on missing / malformed / non-boolean output", () => {
    expect(parseSameIssue("no json here at all")).toBe(false);
    expect(parseSameIssue("")).toBe(false);
    expect(parseSameIssue("{ not valid json }")).toBe(false);
    expect(parseSameIssue('{"same_issue": "false"}')).toBe(false); // string, not boolean
    expect(parseSameIssue('{"other": true}')).toBe(false); // wrong key
  });

  it("tolerates extra keys alongside the verdict", () => {
    expect(parseSameIssue('{"same_issue": true, "reason": "same root cause in the same place"}')).toBe(
      true,
    );
  });
});

describe("createDedupAdjudicator", () => {
  function withDedupLlm(overrides: Partial<Config["dedup"]["llm"]>): Config {
    return {
      ...defaultConfig,
      dedup: { ...defaultConfig.dedup, llm: { ...defaultConfig.dedup.llm, ...overrides } },
    };
  }

  it("does not throw for the mock backend and never merges (controlled degradation)", async () => {
    const config = withDedupLlm({ enabled: true, backend: "mock" });
    // The reviewer fan-out builds a MockReviewer directly; dedup mirrors that by
    // returning a no-op adjudicator instead of asking createModelClient for a
    // (nonexistent) mock client, which would throw and abort the whole review.
    const adjudicate = createDedupAdjudicator(config);
    await expect(adjudicate(finding({ id: "a-001" }), finding({ id: "b-001" }))).resolves.toBe(false);
  });
});
