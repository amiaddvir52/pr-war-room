import { describe, it, expect } from "vitest";
import { parseSkepticVerdict, skepticFromClient } from "../../src/agents/SkepticAgent.js";
import type { ModelClient, ModelRequest, ModelResult } from "../../src/agents/types.js";
import type { EvidenceChecks, FindingCluster, SkepticVerdict } from "../../src/findings/schema.js";
import { ReviewerError, SkepticError } from "../../src/errors.js";
import { makeReviewPacket } from "../fixtures/reviewPacket.js";

const VERDICT: SkepticVerdict = {
  is_supported: true,
  support_level: "strong",
  false_positive_risk: "low",
  reasoning_summary: "supported by the diff",
  recommended_action: "keep",
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

const checks: EvidenceChecks = {
  hard_failures: [],
  soft_warnings: [],
  signals: { file_in_changeset: true, has_line_anchor: true, line_in_diff: true, line_near_diff: true },
  notes: [],
};

describe("parseSkepticVerdict", () => {
  it("reads a bare JSON object (the structured-output / API path)", () => {
    expect(parseSkepticVerdict(JSON.stringify(VERDICT))).toEqual(VERDICT);
  });

  it("reads a fenced object wrapped in prose (the CLI path)", () => {
    const text = `Here is my verdict:\n\`\`\`json\n${JSON.stringify(VERDICT)}\n\`\`\``;
    expect(parseSkepticVerdict(text)).toEqual(VERDICT);
  });

  it("keeps the LAST valid verdict when an example precedes the real answer", () => {
    const example = { ...VERDICT, recommended_action: "drop" as const };
    const text = `Example: ${JSON.stringify(example)}\nActual: ${JSON.stringify(VERDICT)}`;
    expect(parseSkepticVerdict(text)?.recommended_action).toBe("keep");
  });

  it("returns null on missing / malformed / schema-invalid output", () => {
    expect(parseSkepticVerdict("no json here")).toBeNull();
    expect(parseSkepticVerdict("")).toBeNull();
    expect(parseSkepticVerdict('{"recommended_action": "explode"}')).toBeNull(); // bad enum
    expect(parseSkepticVerdict('{"is_supported": true}')).toBeNull(); // missing fields
  });

  it("tolerates extra keys alongside the verdict", () => {
    const text = JSON.stringify({ ...VERDICT, notes: "extra" });
    expect(parseSkepticVerdict(text)).toEqual(VERDICT);
  });

  it("handles braces inside the reasoning_summary string value", () => {
    const verdict = { ...VERDICT, reasoning_summary: "the guard `if (x) { drop() }` is missing" };
    expect(parseSkepticVerdict(JSON.stringify(verdict))).toEqual(verdict);
  });

  it("handles escaped quotes inside string values", () => {
    const verdict = { ...VERDICT, reasoning_summary: 'the call to "foo" is unguarded' };
    expect(parseSkepticVerdict(JSON.stringify(verdict))).toEqual(verdict);
  });

  it("skips an invalid balanced object before the valid verdict", () => {
    const text = `Scratch: {x} {not: json}\nAnswer: ${JSON.stringify(VERDICT)}`;
    expect(parseSkepticVerdict(text)).toEqual(VERDICT);
  });

  it("recovers the verdict after an unbalanced quote in the model's prose", () => {
    // A lone opening quote before the JSON must not swallow the real verdict.
    const text = `He said "the diff looks risky. Verdict: ${JSON.stringify(VERDICT)}`;
    expect(parseSkepticVerdict(text)).toEqual(VERDICT);
  });
});

describe("skepticFromClient", () => {
  const packet = makeReviewPacket();

  it("parses a valid verdict on a normal completion", async () => {
    const { client, requests } = fakeClient({ text: JSON.stringify(VERDICT), stopReason: "end_turn" });
    const verdict = await skepticFromClient(client)(cluster, packet, checks);
    expect(verdict).toEqual(VERDICT);
    // The finding and its file/lines make it into the prompt.
    expect(requests[0]?.user).toContain("a finding");
    expect(requests[0]?.user).toContain("src/a.ts");
  });

  it("throws a typed SkepticError with the failure kind on a soft failure", async () => {
    const expected: Record<string, string> = {
      refusal: "refusal",
      max_tokens: "max_tokens",
      error: "backend_error",
    };
    for (const [stopReason, kind] of Object.entries(expected)) {
      const { client } = fakeClient({ text: "", stopReason });
      await expect(skepticFromClient(client)(cluster, packet, checks)).rejects.toMatchObject({
        kind,
      });
      // Still a ReviewerError subclass, so existing handling keeps working.
      await expect(skepticFromClient(client)(cluster, packet, checks)).rejects.toBeInstanceOf(
        ReviewerError,
      );
    }
  });

  it("throws a parse_error SkepticError when the output has no valid verdict", async () => {
    const { client } = fakeClient({ text: "I cannot decide.", stopReason: "end_turn" });
    const call = skepticFromClient(client)(cluster, packet, checks);
    await expect(call).rejects.toBeInstanceOf(SkepticError);
    await expect(skepticFromClient(client)(cluster, packet, checks)).rejects.toMatchObject({
      kind: "parse_error",
    });
  });
});
