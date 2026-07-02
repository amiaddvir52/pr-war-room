import { describe, it, expect } from "vitest";
import { ClaudeReviewer } from "../../src/agents/ClaudeReviewer.js";
import { createClaudeCliModelClient } from "../../src/agents/claudeCli.js";
import type { CliRunner } from "../../src/agents/claudeCli.js";
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

  it("extracts the JSON object even when the surrounding prose contains braces", async () => {
    // The old outermost-`{`-to-`}` span grabbed `{curly}` … `{ok}` and failed.
    const text = 'Use {curly} placeholders.\n{"findings":[]}\nDone {ok}.';
    const { client } = fakeClient({ text, stopReason: "end_turn" });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(0);
  });

  it("extracts a populated findings object embedded in brace-laden prose", async () => {
    const text = `Notes {a}: ${JSON.stringify({ findings: [coreFinding()] })} — done {b}.`;
    const { client } = fakeClient({ text, stopReason: "end_turn" });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Null deref");
  });

  it("does not miscount braces that appear inside JSON string values", async () => {
    const finding = { ...coreFinding(), claim: "handles a literal { and } in text" };
    const { client } = fakeClient({
      text: JSON.stringify({ findings: [finding] }),
      stopReason: "end_turn",
    });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
  });

  it("reports a backend error distinctly (not as invalid JSON) on stop_reason error", async () => {
    const { client } = fakeClient({ text: "Error: rate limit exceeded", stopReason: "error" });
    const result = await new ClaudeReviewer(client, REVIEW).review(input);
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toMatch(/stop_reason: error/);
    expect(result.parseError).toMatch(/rate limit exceeded/);
    expect(result.parseError).not.toMatch(/valid JSON/);
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

/**
 * Regression tests for the DEFAULT (Claude CLI) backend, wiring the real
 * `createClaudeCliModelClient` to `ClaudeReviewer` through a fake `CliRunner`.
 * The API path is already covered above; these lock in that CLI errors and
 * truncation reach the reviewer's benign-outcome branches rather than the
 * generic "did not contain valid JSON".
 */
describe("ClaudeReviewer over the CLI backend", () => {
  const cliRunner =
    (stdout: string): CliRunner =>
    async () => ({ code: 0, stdout, stderr: "", spawnError: null, timedOut: false });

  function reviewViaCli(stdout: string) {
    const client = createClaudeCliModelClient({ run: cliRunner(stdout) });
    return new ClaudeReviewer(client, REVIEW).review(input);
  }

  it("parses findings from a normal CLI result envelope", async () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify({ findings: [coreFinding()] }),
    });
    const result = await reviewViaCli(stdout);
    expect(result.parseError).toBeNull();
    expect(result.findings).toHaveLength(1);
  });

  it("surfaces a CLI `is_error` envelope as a real error, not invalid JSON", async () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Error: model overloaded",
    });
    const result = await reviewViaCli(stdout);
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toMatch(/stop_reason: error/);
    expect(result.parseError).not.toMatch(/valid JSON/);
  });

  it("surfaces a CLI truncated turn as a truncation failure", async () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: '{"findings":[',
    });
    const result = await reviewViaCli(stdout);
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).toMatch(/max_tokens/);
  });
});
