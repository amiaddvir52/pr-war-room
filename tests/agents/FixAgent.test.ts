import { describe, it, expect } from "vitest";
import {
  createMockFixer,
  fixerFromClient,
  parseFixProposal,
} from "../../src/agents/FixAgent.js";
import { FIX_OUTPUT_JSON_SCHEMA, type FixProposal } from "../../src/fix/schema.js";
import {
  buildFileWindow,
  type FixPromptContext,
} from "../../src/agents/prompts/fixPrompt.js";
import type { ModelClient, ModelRequest, ModelResult } from "../../src/agents/types.js";
import { FixAgentError, ReviewerError } from "../../src/errors.js";
import { makeFinalFinding } from "../fixtures/finalFinding.js";

const PROPOSAL: FixProposal = {
  edits: [{ path: "src/a.ts", search: "i < n - 1", replace: "i < n" }],
  summary: "fixed the off-by-one",
  needs_manual_review: null,
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

function makeContext(overrides: Partial<FixPromptContext> = {}): FixPromptContext {
  return {
    finding: makeFinalFinding(),
    fileContent: "line one\nfor (i < n - 1)\nline three",
    fileWindow: { startLine: 1, endLine: 3, truncated: false },
    diffPatch: "@@ -1,3 +1,3 @@\n-old\n+for (i < n - 1)",
    ...overrides,
  };
}

describe("parseFixProposal", () => {
  it("reads a bare JSON proposal", () => {
    expect(parseFixProposal(JSON.stringify(PROPOSAL))).toEqual(PROPOSAL);
  });

  it("reads a fenced proposal wrapped in prose (the CLI path)", () => {
    const text = `Here is the fix:\n\`\`\`json\n${JSON.stringify(PROPOSAL)}\n\`\`\``;
    expect(parseFixProposal(text)).toEqual(PROPOSAL);
  });

  it("accepts an empty edits array (an explicit decline)", () => {
    const decline = { edits: [], summary: "cannot fix safely", needs_manual_review: "why" };
    expect(parseFixProposal(JSON.stringify(decline))).toEqual(decline);
  });

  it("returns null on malformed or schema-invalid output", () => {
    expect(parseFixProposal("no json")).toBeNull();
    // search must be non-empty
    expect(
      parseFixProposal(
        JSON.stringify({ edits: [{ path: "a", search: "", replace: "x" }], summary: "s", needs_manual_review: null }),
      ),
    ).toBeNull();
    // missing needs_manual_review
    expect(parseFixProposal(JSON.stringify({ edits: [], summary: "s" }))).toBeNull();
  });
});

describe("fixerFromClient", () => {
  it("sends the finding, file content, and diff, requesting the fix schema", async () => {
    const { client, requests } = fakeClient({
      text: JSON.stringify(PROPOSAL),
      stopReason: "end_turn",
    });
    const proposal = await fixerFromClient(client)(makeContext());
    expect(proposal).toEqual(PROPOSAL);
    expect(requests[0]?.jsonSchema).toBe(FIX_OUTPUT_JSON_SCHEMA);
    expect(requests[0]?.system).toContain("BYTE-EXACT");
    expect(requests[0]?.user).toContain("off-by-one in range check");
    expect(requests[0]?.user).toContain("for (i < n - 1)"); // real file bytes
    expect(requests[0]?.user).toContain("@@ -1,3 +1,3 @@"); // the PR diff hunk
  });

  it("notes the window bounds when the file was truncated", async () => {
    const { client, requests } = fakeClient({
      text: JSON.stringify(PROPOSAL),
      stopReason: "end_turn",
    });
    await fixerFromClient(client)(
      makeContext({ fileWindow: { startLine: 40, endLine: 200, truncated: true } }),
    );
    expect(requests[0]?.user).toContain("showing lines 40-200");
  });

  it("throws a typed FixAgentError with the failure kind on a soft failure", async () => {
    const expected: Record<string, string> = {
      refusal: "refusal",
      max_tokens: "max_tokens",
      error: "backend_error",
    };
    for (const [stopReason, kind] of Object.entries(expected)) {
      const { client } = fakeClient({ text: "", stopReason });
      await expect(fixerFromClient(client)(makeContext())).rejects.toMatchObject({ kind });
      await expect(fixerFromClient(client)(makeContext())).rejects.toBeInstanceOf(ReviewerError);
    }
  });

  it("throws a parse_error FixAgentError when the output has no valid proposal", async () => {
    const { client } = fakeClient({ text: "I gave up.", stopReason: "end_turn" });
    await expect(fixerFromClient(client)(makeContext())).rejects.toBeInstanceOf(FixAgentError);
    await expect(fixerFromClient(client)(makeContext())).rejects.toMatchObject({
      kind: "parse_error",
    });
  });
});

describe("createMockFixer", () => {
  it("proposes a TODO insertion above a unique anchor line", async () => {
    const proposal = await createMockFixer()(makeContext());
    expect(proposal.edits).toHaveLength(1);
    expect(proposal.edits[0]?.search).toBe("for (i < n - 1)");
    expect(proposal.edits[0]?.replace).toContain("// TODO(pr-war-room): off-by-one in range check");
    expect(proposal.edits[0]?.replace).toContain("for (i < n - 1)"); // keeps the line
  });

  it("preserves the anchor line's indentation on the TODO", async () => {
    const ctx = makeContext({
      fileContent: "function f() {\n    return 1;\n}",
      finding: makeFinalFinding({ line_start: 2, line_end: 2 }),
    });
    const proposal = await createMockFixer()(ctx);
    expect(proposal.edits[0]?.replace.startsWith("    // TODO")).toBe(true);
  });

  it("declines when the anchor line is not unique in the shown content", async () => {
    const ctx = makeContext({
      fileContent: "dup\ndup\ndup",
      finding: makeFinalFinding({ line_start: 2, line_end: 2 }),
    });
    const proposal = await createMockFixer()(ctx);
    expect(proposal.edits).toEqual([]);
    expect(proposal.needs_manual_review).toContain("manually");
  });

  it("declines when the file is shown as a truncated window", async () => {
    // Uniqueness inside a window cannot prove uniqueness in the whole file
    // (which is what applyFixEdits enforces), so windowed files are declined.
    const ctx = makeContext({ fileWindow: { startLine: 1, endLine: 3, truncated: true } });
    const proposal = await createMockFixer()(ctx);
    expect(proposal.edits).toEqual([]);
    expect(proposal.needs_manual_review).toContain("manually");
  });

  it("declines when the anchor is outside the window or blank", async () => {
    const outOfRange = await createMockFixer()(
      makeContext({ finding: makeFinalFinding({ line_start: 99, line_end: 99 }) }),
    );
    expect(outOfRange.edits).toEqual([]);
    const blank = await createMockFixer()(
      makeContext({
        fileContent: "a\n\nb",
        finding: makeFinalFinding({ line_start: 2, line_end: 2 }),
      }),
    );
    expect(blank.edits).toEqual([]);
  });
});

describe("buildFileWindow", () => {
  it("returns the whole file when small", () => {
    const window = buildFileWindow("a\nb\nc", 2, 2);
    expect(window).toEqual({ content: "a\nb\nc", startLine: 1, endLine: 3, truncated: false });
  });

  it("windows a large file around the line anchor", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`);
    const window = buildFileWindow(lines.join("\n"), 1000, 1002);
    expect(window.truncated).toBe(true);
    expect(window.startLine).toBe(920); // 1000 - 80
    expect(window.endLine).toBe(1082); // 1002 + 80
    expect(window.content.split("\n")[0]).toBe("line 920 " + "x".repeat(20));
  });

  it("clamps the window to the file bounds", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${"y".repeat(300)}`);
    const window = buildFileWindow(lines.join("\n"), 5, 5);
    expect(window.startLine).toBe(1);
    expect(window.endLine).toBe(85);
  });

  it("falls back to the head window for a stale anchor beyond the current EOF", () => {
    // A finding anchored past the file's end (the PR head moved since the
    // review) must not produce an inverted, empty window like "lines 820-300".
    const stale = Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${"w".repeat(300)}`);
    const window = buildFileWindow(stale.join("\n"), 900, 900);
    expect(window.startLine).toBe(1);
    expect(window.endLine).toBe(200);
    expect(window.content).not.toBe("");
    expect(window.truncated).toBe(true);
  });

  it("falls back to the head of an anchorless large file", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"z".repeat(20)}`);
    const window = buildFileWindow(lines.join("\n"), 0, 0);
    expect(window.startLine).toBe(1);
    expect(window.endLine).toBe(200);
    expect(window.truncated).toBe(true);
  });
});
