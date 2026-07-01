import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "../../src/workspace/prepareWorkspace.js";
import { getArtifactPaths } from "../../src/storage/artifactPaths.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { mergeConfig } from "../../src/config/loadConfig.js";
import type { GitRunner } from "../../src/workspace/git.js";
import type { CommandResult, CommandRunner } from "../../src/workspace/runCommand.js";

const PR = { owner: "org", repo: "repo", number: 123 };

function fakeGit(): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    if (args.includes("rev-parse")) return { stdout: "abc123def456\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { runner, calls };
}

interface FakeCmdOptions {
  exit?: (command: string) => number;
  stdout?: (command: string) => string;
}

function fakeCmd(opts: FakeCmdOptions = {}): { runner: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: CommandRunner = async (command, o) => {
    calls.push(command);
    const stdout = opts.stdout?.(command) ?? "";
    return {
      command,
      cwd: o.cwd,
      exitCode: opts.exit?.(command) ?? 0,
      stdout,
      stderr: "",
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 1,
      timedOut: false,
      spawnError: null,
    } satisfies CommandResult;
  };
  return { runner, calls };
}

describe("prepareWorkspace", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "prwr-ws-"));
    const repoDir = getArtifactPaths(cwd).workspace.repo;
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }), "utf8");
    await writeFile(join(repoDir, "package-lock.json"), "{}", "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function readJson(...segments: string[]): Promise<Record<string, unknown>> {
    const raw = await readFile(join(cwd, ".ai-review", ...segments), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("detects the project and skips verification by default", async () => {
    const git = fakeGit();
    const cmd = fakeCmd();
    const result = await prepareWorkspace({
      pr: PR,
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
      token: null,
      gitRunner: git.runner,
      cmdRunner: cmd.runner,
    });

    const v = result.verification;
    expect(v.ran).toBe(false);
    expect(v.enabled).toBe(false);
    expect(v.enabledSource).toBe("default");
    expect(v.detectedCommands).toEqual(["npm run test"]);
    expect(v.executedCommands).toEqual([]);
    expect(v.skippedCommands).toEqual(["npm run test"]);
    expect(v.skipReason).toContain("disabled");
    expect(cmd.calls).toEqual([]);

    expect(result.metadata.projectTypes).toEqual(["node"]);
    expect(result.metadata.packageManager).toBe("npm");
    expect(result.metadata.headSha).toBe("abc123def456");
    expect(result.metadata.reused).toBe(false);

    expect((await readJson("verification", "initial_verification.json"))["ran"]).toBe(false);
    expect((await readJson("workspace", "workspace_metadata.json"))["schemaVersion"]).toBe(1);
  });

  it("installs deps then runs detected commands when verify is on (source=flag)", async () => {
    const cmd = fakeCmd();
    const result = await prepareWorkspace({
      pr: PR,
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
      verify: true,
      token: null,
      gitRunner: fakeGit().runner,
      cmdRunner: cmd.runner,
    });

    expect(result.verification.enabledSource).toBe("flag");
    expect(result.verification.ran).toBe(true);
    expect(result.verification.allPassed).toBe(true);
    expect(result.verification.executedCommands).toEqual(["npm run test"]);
    expect(result.verification.install?.passed).toBe(true);
    expect(cmd.calls).toEqual(["npm ci", "npm run test"]);
  });

  it("records a failing command without throwing (allPassed:false)", async () => {
    const cmd = fakeCmd({ exit: (c) => (c.includes("test") ? 1 : 0) });
    const result = await prepareWorkspace({
      pr: PR,
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
      verify: true,
      token: null,
      gitRunner: fakeGit().runner,
      cmdRunner: cmd.runner,
    });

    expect(result.verification.ran).toBe(true);
    expect(result.verification.allPassed).toBe(false);
    expect(result.verification.executedCommands).toEqual(["npm run test"]);
    expect(result.verification.results[0]?.passed).toBe(false);
    expect((await readJson("verification", "initial_verification.json"))["allPassed"]).toBe(false);
  });

  it("skips verification commands when dependency install fails", async () => {
    const cmd = fakeCmd({ exit: (c) => (c.includes("npm ci") ? 1 : 0) });
    const result = await prepareWorkspace({
      pr: PR,
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
      verify: true,
      token: null,
      gitRunner: fakeGit().runner,
      cmdRunner: cmd.runner,
    });

    expect(result.verification.install?.passed).toBe(false);
    expect(result.verification.executedCommands).toEqual([]);
    expect(result.verification.skippedCommands).toEqual(["npm run test"]);
    expect(result.verification.skipReason).toBe("dependency install failed");
    expect(result.verification.allPassed).toBe(false);
    expect(cmd.calls).toEqual(["npm ci"]); // command never ran
  });

  it("lets config.verification.commands override detected commands (source=config)", async () => {
    const cmd = fakeCmd();
    const config = mergeConfig(defaultConfig, {
      verification: { commands: ["echo custom"], enabled: true },
    });
    const result = await prepareWorkspace({
      pr: PR,
      config,
      paths: getArtifactPaths(cwd),
      cwd,
      token: null,
      gitRunner: fakeGit().runner,
      cmdRunner: cmd.runner,
    });
    expect(result.verification.enabledSource).toBe("config");
    expect(result.verification.detectedCommands).toEqual(["npm run test"]);
    expect(result.verification.configuredCommands).toEqual(["echo custom"]);
    expect(result.verification.executedCommands).toEqual(["echo custom"]);
    expect(cmd.calls).toEqual(["npm ci", "echo custom"]); // install from detection, command from config
  });

  it("redacts secrets from previews and stored logs, and stores a log file", async () => {
    const TOKEN = "supersecretvalue123";
    const cmd = fakeCmd({ stdout: (c) => (c.includes("test") ? `leaked ${TOKEN} here` : "") });
    const result = await prepareWorkspace({
      pr: PR,
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
      verify: true,
      token: TOKEN,
      gitRunner: fakeGit().runner,
      cmdRunner: cmd.runner,
    });

    const testExec = result.verification.results[0];
    expect(testExec?.stdoutPreview).not.toContain(TOKEN);
    expect(testExec?.stdoutPreview).toContain("***REDACTED***");
    expect(testExec?.logFile).toBeTruthy();
    const log = await readFile(join(cwd, testExec!.logFile!), "utf8");
    expect(log).not.toContain(TOKEN);
    expect(log).toContain("***REDACTED***");
    // The token must never appear anywhere in the JSON artifact either.
    const rawArtifact = await readFile(
      join(cwd, ".ai-review", "verification", "initial_verification.json"),
      "utf8",
    );
    expect(rawArtifact).not.toContain(TOKEN);
  });

  it("fetches with the token but never persists it to the stored remote", async () => {
    const git = fakeGit();
    const result = await prepareWorkspace({
      pr: PR,
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
      token: "secrettoken",
      gitRunner: git.runner,
      cmdRunner: fakeCmd().runner,
    });

    const fetchCall = git.calls.find((args) => args.includes("fetch"));
    expect(fetchCall?.some((arg) => arg.includes("secrettoken"))).toBe(true);
    expect(result.metadata.remote).toBe("https://github.com/org/repo.git");
    const meta = await readJson("workspace", "workspace_metadata.json");
    expect(JSON.stringify(meta)).not.toContain("secrettoken");
  });

  it("always forces a clean checkout (reset --hard + clean -fd) and reuses an existing repo", async () => {
    // Simulate an existing checkout so the reuse path is taken.
    await mkdir(join(getArtifactPaths(cwd).workspace.repo, ".git"), { recursive: true });
    const git = fakeGit();
    const result = await prepareWorkspace({
      pr: PR,
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
      token: null,
      gitRunner: git.runner,
      cmdRunner: fakeCmd().runner,
    });

    expect(result.metadata.reused).toBe(true);
    expect(git.calls.some((a) => a.includes("reset") && a.includes("--hard"))).toBe(true);
    expect(git.calls.some((a) => a.includes("clean") && a.includes("-fd"))).toBe(true);
    // Never commit, never push.
    expect(git.calls.some((a) => a.includes("commit") || a.includes("push"))).toBe(false);
  });
});
