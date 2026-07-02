import { describe, it, expect } from "vitest";
import { createCodexCliModelClient } from "../../src/agents/codexCli.js";
import type { CliExecResult, CliRunner } from "../../src/agents/cliRunner.js";
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
    return { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false, ...result };
  };
  return { run, calls };
}

describe("createCodexCliModelClient", () => {
  it("invokes `codex exec` reading the combined prompt from stdin", async () => {
    const { run, calls } = fakeRunner({ stdout: '{"findings":[]}' });
    const client = createCodexCliModelClient({ run });

    const result = await client.complete(REQ);

    expect(calls).toHaveLength(1);
    const { argv, stdin } = calls[0]!;
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv[argv.length - 1]).toBe("-");
    // Codex has no system-prompt flag: system + user are concatenated on stdin.
    expect(stdin).toContain("SYS PROMPT");
    expect(stdin).toContain("PACKET BODY");
    // Raw stdout is returned; the Reviewer's tolerant parser extracts the JSON.
    expect(result.text).toBe('{"findings":[]}');
    expect(result.stopReason).toBe("end_turn");
  });

  it("passes --model when configured", async () => {
    const { run, calls } = fakeRunner({ stdout: "{}" });
    await createCodexCliModelClient({ run, model: "gpt-5-codex" }).complete(REQ);
    expect(calls[0]?.argv[calls[0]!.argv.indexOf("--model") + 1]).toBe("gpt-5-codex");
  });

  it("throws a helpful ReviewerError when codex is not installed", async () => {
    const { run } = fakeRunner({ code: null, spawnError: "spawn codex ENOENT" });
    await expect(createCodexCliModelClient({ run }).complete(REQ)).rejects.toBeInstanceOf(
      ReviewerError,
    );
    await expect(createCodexCliModelClient({ run }).complete(REQ)).rejects.toThrow(/codex login/);
  });

  it("throws ReviewerError on a non-zero exit, surfacing stderr", async () => {
    const { run } = fakeRunner({ code: 1, stderr: "not authenticated\n" });
    await expect(createCodexCliModelClient({ run }).complete(REQ)).rejects.toThrow(
      /not authenticated/,
    );
  });

  it("throws a timeout-specific ReviewerError when the process is killed by the timeout", async () => {
    const { run } = fakeRunner({ code: null, timedOut: true });
    const attempt = () => createCodexCliModelClient({ run, timeoutMs: 4321 }).complete(REQ);
    await expect(attempt()).rejects.toBeInstanceOf(ReviewerError);
    await expect(attempt()).rejects.toThrow(/timed out after 4321ms/);
    await expect(attempt()).rejects.not.toThrow(/exit code null/);
  });
});
