import { describe, it, expect } from "vitest";
import { parseJudgeVerdict, judgeFromClient } from "../../src/agents/JudgeAgent.js";
import type { ModelClient, ModelRequest, ModelResult } from "../../src/agents/types.js";
import type { FindingCluster, JudgeVerdict } from "../../src/findings/schema.js";
import { JudgeError, ReviewerError } from "../../src/errors.js";
import { makeReviewPacket } from "../fixtures/reviewPacket.js";

const VERDICT: JudgeVerdict = {
  final_classification: "should_fix_before_review",
  model_score: 0.82,
  reasoning_summary: "a human reviewer would likely raise this",
};

function fakeClient(result: ModelResult): { client: ModelClient; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  const client: ModelClient = {
    async complete(req) {
      requests.push(req);
      return result;
    },
  };
  return { client, requests };
}

const cluster: FindingCluster = {
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
  line_start: 10,
  line_end: 12,
  claim: "a real, actionable claim",
  evidence: ["concrete evidence"],
  suggested_fix: null,
  suggested_test: null,
  needs_code_change: true,
};

describe("parseJudgeVerdict", () => {
  it("reads a bare JSON object (the structured-output / API path)", () => {
    expect(parseJudgeVerdict(JSON.stringify(VERDICT))).toEqual(VERDICT);
  });

  it("reads a fenced object wrapped in prose (the CLI path)", () => {
    const text = `Here is my verdict:\n\`\`\`json\n${JSON.stringify(VERDICT)}\n\`\`\``;
    expect(parseJudgeVerdict(text)).toEqual(VERDICT);
  });

  it("keeps the LAST valid verdict when an example precedes the real answer", () => {
    const example = { ...VERDICT, final_classification: "drop" as const };
    const text = `Example: ${JSON.stringify(example)}\nActual: ${JSON.stringify(VERDICT)}`;
    expect(parseJudgeVerdict(text)?.final_classification).toBe("should_fix_before_review");
  });

  it("returns null on missing / malformed / schema-invalid output", () => {
    expect(parseJudgeVerdict("no json here")).toBeNull();
    expect(parseJudgeVerdict("")).toBeNull();
    expect(parseJudgeVerdict('{"final_classification": "explode", "model_score": 1, "reasoning_summary": "x"}')).toBeNull(); // bad enum
    expect(parseJudgeVerdict('{"final_classification": "drop"}')).toBeNull(); // missing fields
    // model_score out of range is caught by Zod even though the JSON schema can't.
    expect(
      parseJudgeVerdict('{"final_classification": "drop", "model_score": 2, "reasoning_summary": "x"}'),
    ).toBeNull();
  });

  it("tolerates extra keys alongside the verdict", () => {
    const text = JSON.stringify({ ...VERDICT, notes: "extra" });
    expect(parseJudgeVerdict(text)).toEqual(VERDICT);
  });

  it("handles braces and escaped quotes inside the reasoning string", () => {
    const verdict = { ...VERDICT, reasoning_summary: 'the guard `if (x) { "drop" }` is missing' };
    expect(parseJudgeVerdict(JSON.stringify(verdict))).toEqual(verdict);
  });
});

describe("judgeFromClient", () => {
  const packet = makeReviewPacket();

  it("parses a valid verdict on a normal completion", async () => {
    const { client, requests } = fakeClient({ text: JSON.stringify(VERDICT), stopReason: "end_turn" });
    const verdict = await judgeFromClient(client)(cluster, null, packet);
    expect(verdict).toEqual(VERDICT);
    // The finding and its file make it into the prompt.
    expect(requests[0]?.user).toContain("a finding");
    expect(requests[0]?.user).toContain("src/a.ts");
    // With no skeptic result, the prompt says so rather than fabricating one.
    expect(requests[0]?.user).toContain("Skeptic: did not run");
  });

  it("includes the skeptic support level in the prompt when present", async () => {
    const { client, requests } = fakeClient({ text: JSON.stringify(VERDICT), stopReason: "end_turn" });
    await judgeFromClient(client)(
      cluster,
      {
        cluster_id: "cluster-001",
        source: "llm",
        checks: {
          hard_failures: [],
          soft_warnings: [],
          signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: true, line_near_diff: true },
          notes: [],
        },
        model_verdict: {
          is_supported: true,
          support_level: "strong",
          false_positive_risk: "low",
          reasoning_summary: "clearly supported",
          recommended_action: "keep",
        },
        decision: { action: "keep", reason: "…", softened_from_model_action: null },
        failure: null,
      },
      packet,
    );
    expect(requests[0]?.user).toContain("Skeptic support level: strong");
  });

  it("throws a typed JudgeError with the failure kind on a soft failure", async () => {
    const expected: Record<string, string> = {
      refusal: "refusal",
      max_tokens: "max_tokens",
      error: "backend_error",
    };
    for (const [stopReason, kind] of Object.entries(expected)) {
      const { client } = fakeClient({ text: "", stopReason });
      await expect(judgeFromClient(client)(cluster, null, packet)).rejects.toMatchObject({ kind });
      // Still a ReviewerError subclass, so existing handling keeps working.
      await expect(judgeFromClient(client)(cluster, null, packet)).rejects.toBeInstanceOf(ReviewerError);
    }
  });

  it("throws a parse_error JudgeError when the output has no valid verdict", async () => {
    const { client } = fakeClient({ text: "I cannot decide.", stopReason: "end_turn" });
    await expect(judgeFromClient(client)(cluster, null, packet)).rejects.toBeInstanceOf(JudgeError);
    await expect(judgeFromClient(client)(cluster, null, packet)).rejects.toMatchObject({
      kind: "parse_error",
    });
  });
});
