import { describe, it, expect } from "vitest";
import { ClaudeReviewer } from "../../src/agents/ClaudeReviewer.js";
import type { ModelClient, ModelRequest, ModelResult } from "../../src/agents/types.js";
import type { FindingCore } from "../../src/findings/schema.js";
import type { ReviewConfig } from "../../src/config/schema.js";
import { makeReviewPacket } from "../fixtures/reviewPacket.js";

const REVIEW: ReviewConfig = { maxFindings: 20, includeNiceToHave: false };

function coreFinding(): FindingCore {
  return {
    title: "Null deref",
    category: "correctness",
    severity: "high",
    confidence: 0.7,
    file: "src/a.ts",
    line_start: 10,
    line_end: 12,
    claim: "x may be undefined",
    evidence: ["guard removed in diff"],
    suggested_fix: null,
    suggested_test: null,
    human_review_likelihood: 0.6,
    needs_code_change: true,
  };
}

/** A ModelClient that returns a canned result and records the request. */
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

const input = { packet: makeReviewPacket(), packetMarkdown: "# HELLO PACKET" };

describe("ClaudeReviewer", () => {
  it("parses structured findings on a normal completion", async () => {
    const { client } = fakeClient({
      text: JSON.stringify({ findings: [coreFinding()] }),
      stopReason: "end_turn",
    });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Null deref");
  });

  it("passes the packet markdown to the model", async () => {
    const { client, requests } = fakeClient({
      text: JSON.stringify({ findings: [] }),
      stopReason: "end_turn",
    });
    await new ClaudeReviewer(client, REVIEW).review(input);
    expect(requests[0]?.user).toContain("# HELLO PACKET");
    expect(requests[0]?.jsonSchema).toBeTypeOf("object");
  });

  it("reports a soft failure when the model output is truncated", async () => {
    const { client } = fakeClient({ text: "{", stopReason: "max_tokens" });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toMatch(/max_tokens/);
  });

  it("reports a soft failure when the model refuses", async () => {
    const { client } = fakeClient({ text: "", stopReason: "refusal" });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.parseError).toMatch(/refus/);
  });

  it("tolerates JSON wrapped in a markdown code fence (CLI path)", async () => {
    const fenced = "Here are the findings:\n```json\n" + JSON.stringify({ findings: [coreFinding()] }) + "\n```";
    const { client } = fakeClient({ text: fenced, stopReason: "end_turn" });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
  });

  it("reports a parse failure on non-JSON output", async () => {
    const { client } = fakeClient({ text: "sorry, here are my thoughts…", stopReason: "end_turn" });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toMatch(/JSON/);
  });

  it("reports a schema mismatch when JSON doesn't fit the finding shape", async () => {
    const { client } = fakeClient({
      text: JSON.stringify({ findings: [{ title: "incomplete" }] }),
      stopReason: "end_turn",
    });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toMatch(/schema/);
  });
});
