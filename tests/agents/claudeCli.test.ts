import { describe, it, expect } from "vitest";
import { createClaudeCliModelClient } from "../../src/agents/claudeCli.js";
import type { CliExecResult, CliRunner } from "../../src/agents/claudeCli.js";
import { ReviewerError } from "../../src/errors.js";
import type { ModelRequest } from "../../src/agents/types.js";

const REQ: ModelRequest = { system: "SYS PROMPT", user: "PACKET BODY", jsonSchema: {} };

/** A fake CLI runner that records its invocation and returns a canned result. */
function fakeRunner(result: Partial<CliExecResult>): {
  run: CliRunner;
  calls: Array<{ argv: string[]; stdin: string }>;
} {
  const calls: Array<{ argv: string[]; stdin: string }> = [];
  const run: CliRunner = async (argv, stdin) => {
    calls.push({ argv, stdin });
    return { code: 0, stdout: "", stderr: "", spawnError: null, ...result };
  };
  return { run, calls };
}

function envelope(result: string, isError = false): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: isError, result });
}

describe("createClaudeCliModelClient", () => {
  it("invokes `claude -p` in JSON mode with the system prompt and packet on stdin", async () => {
    const inner = JSON.stringify({ findings: [] });
    const { run, calls } = fakeRunner({ stdout: envelope(inner) });
    const client = createClaudeCliModelClient({ run });

    const result = await client.complete(REQ);

    expect(calls).toHaveLength(1);
    const { argv, stdin } = calls[0]!;
    expect(argv).toContain("-p");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("SYS PROMPT");
    expect(stdin).toBe("PACKET BODY");
    expect(result.text).toBe(inner);
    expect(result.stopReason).toBe("end_turn");
  });

  it("passes --model when configured", async () => {
    const { run, calls } = fakeRunner({ stdout: envelope("{}") });
    await createClaudeCliModelClient({ run, model: "opus" }).complete(REQ);
    expect(calls[0]?.argv[calls[0]!.argv.indexOf("--model") + 1]).toBe("opus");
  });

  it("throws ReviewerError when the CLI is not installed", async () => {
    const { run } = fakeRunner({ code: null, spawnError: "spawn claude ENOENT" });
    await expect(createClaudeCliModelClient({ run }).complete(REQ)).rejects.toBeInstanceOf(
      ReviewerError,
    );
    await expect(createClaudeCliModelClient({ run }).complete(REQ)).rejects.toThrow(/claude login/);
  });

  it("throws ReviewerError on a non-zero exit, surfacing stderr", async () => {
    const { run } = fakeRunner({ code: 1, stderr: "Not logged in\n" });
    await expect(createClaudeCliModelClient({ run }).complete(REQ)).rejects.toThrow(/Not logged in/);
  });

  it("marks an is_error envelope with a non-terminal stop reason", async () => {
    const { run } = fakeRunner({ stdout: envelope("", true) });
    const result = await createClaudeCliModelClient({ run }).complete(REQ);
    expect(result.stopReason).toBe("error");
  });

  it("falls back to raw stdout when output is not the expected envelope", async () => {
    const { run } = fakeRunner({ stdout: '{"findings":[]}' });
    const result = await createClaudeCliModelClient({ run }).complete(REQ);
    // Not a `{result: ...}` envelope, so the raw stdout is returned as the text.
    expect(result.text).toBe('{"findings":[]}');
  });
});
