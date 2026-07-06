import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeVerification } from "../../src/workspace/executeVerification.js";
import type { CommandResult, CommandRunner } from "../../src/workspace/runCommand.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pwr-exec-verify-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeResult(command: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command,
    cwd: dir,
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 5,
    timedOut: false,
    spawnError: null,
    ...overrides,
  };
}

function fakeRunner(
  results: Record<string, Partial<CommandResult>> = {},
): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = async (command) => {
    calls.push(command);
    return makeResult(command, results[command] ?? {});
  };
  return { runner, calls };
}

function input(overrides: Partial<Parameters<typeof executeVerification>[0]> = {}) {
  return {
    repoDir: join(dir, "repo"),
    logsDir: join(dir, ".ai-review", "verification", "fix-logs"),
    cwd: dir,
    installCommand: null,
    commands: ["npm test"],
    timeoutMs: 1000,
    secrets: [],
    ...overrides,
  };
}

describe("executeVerification", () => {
  it("runs install first, then every command in order", async () => {
    const { runner, calls } = fakeRunner();
    const result = await executeVerification(
      input({ installCommand: "npm ci", commands: ["npm test", "npm run lint"], cmdRunner: runner }),
    );
    expect(calls).toEqual(["npm ci", "npm test", "npm run lint"]);
    expect(result.allPassed).toBe(true);
    expect(result.executedCommands).toEqual(["npm test", "npm run lint"]);
    expect(result.install?.passed).toBe(true);
    expect(result.skipReason).toBeNull();
  });

  it("skips the commands (with a reason) when the install fails", async () => {
    const { runner, calls } = fakeRunner({ "npm ci": { exitCode: 1 } });
    const result = await executeVerification(
      input({ installCommand: "npm ci", commands: ["npm test"], cmdRunner: runner }),
    );
    expect(calls).toEqual(["npm ci"]);
    expect(result.allPassed).toBe(false);
    expect(result.skippedCommands).toEqual(["npm test"]);
    expect(result.skipReason).toBe("dependency install failed");
  });

  it("runs ALL commands even when an earlier one fails", async () => {
    const { runner, calls } = fakeRunner({ "npm test": { exitCode: 1, stderr: "2 tests failed" } });
    const result = await executeVerification(
      input({ commands: ["npm test", "npm run lint"], cmdRunner: runner }),
    );
    expect(calls).toEqual(["npm test", "npm run lint"]);
    expect(result.allPassed).toBe(false);
    expect(result.results.map((r) => r.passed)).toEqual([false, true]);
  });

  it("redacts secrets from previews and writes full logs under logsDir", async () => {
    const { runner } = fakeRunner({
      "npm test": { exitCode: 1, stdout: "token=hunter2 leaked", stdoutBytes: 20 },
    });
    const result = await executeVerification(
      input({ commands: ["npm test"], secrets: ["hunter2"], cmdRunner: runner }),
    );
    expect(result.results[0]?.stdoutPreview).toContain("token=***REDACTED*** leaked");
    expect(result.results[0]?.stdoutPreview).not.toContain("hunter2");
    const logsDir = join(dir, ".ai-review", "verification", "fix-logs");
    const logs = await readdir(logsDir);
    expect(logs).toHaveLength(1);
    const body = await readFile(join(logsDir, logs[0] ?? ""), "utf8");
    expect(body).toContain("token=***REDACTED***");
    expect(body).not.toContain("hunter2");
    expect(result.results[0]?.logFile).toContain("fix-logs");
  });
});
