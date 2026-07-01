import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReviewPacket } from "../../src/context/buildReviewPacket.js";
import { getArtifactPaths } from "../../src/storage/artifactPaths.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { mergeConfig } from "../../src/config/loadConfig.js";
import type { PrMetadata, ChangedFilesArtifact } from "../../src/github/types.js";
import type { WorkspaceResult } from "../../src/workspace/types.js";
import type { CommandExecution } from "../../src/workspace/types.js";

const PR = { owner: "org", repo: "repo", number: 123 };

function prMetadata(): PrMetadata {
  return {
    schemaVersion: 1,
    owner: "org",
    repo: "repo",
    number: 123,
    title: "Add feature",
    description: "Implements the thing.",
    author: "alice",
    state: "open",
    draft: false,
    baseBranch: "main",
    headBranch: "feature",
    baseRepo: "org/repo",
    headRepo: "fork/repo",
    counts: { additions: 3, deletions: 0, changedFiles: 1, commits: 1 },
    htmlUrl: "https://github.com/org/repo/pull/123",
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

function changedFiles(patch: string): ChangedFilesArtifact {
  return {
    schemaVersion: 1,
    totalCount: 1,
    truncated: false,
    files: [
      {
        filename: "src/f.ts",
        status: "modified",
        additions: 3,
        deletions: 0,
        changes: 3,
        patchOmitted: false,
        patch,
      },
    ],
  };
}

function exec(
  command: string,
  exitCode = 0,
  over: Partial<CommandExecution> = {},
): CommandExecution {
  return {
    command,
    exitCode,
    passed: exitCode === 0,
    durationMs: 5,
    timedOut: false,
    spawnError: null,
    stdoutPreview: "",
    stderrPreview: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    logFile: null,
    ...over,
  };
}

function workspace(): WorkspaceResult {
  return {
    metadata: {
      schemaVersion: 1,
      repoDir: ".ai-review/workspace/repo",
      remote: "https://github.com/org/repo.git",
      ref: "pull/123/head",
      headSha: "abcdef1234567890",
      reused: false,
      projectTypes: ["node"],
      packageManager: "npm",
      detected: { install: "npm ci", commands: ["npm run test"] },
      verification: {
        enabled: true,
        enabledSource: "flag",
        installPlanned: "npm ci",
        commandsPlanned: ["npm run test"],
      },
      preparedAt: "2026-01-01T00:00:00.000Z",
    },
    verification: {
      schemaVersion: 1,
      enabled: true,
      enabledSource: "flag",
      ran: true,
      skipReason: null,
      detectedCommands: ["npm run test"],
      configuredCommands: [],
      installCommand: "npm ci",
      executedCommands: ["npm run test"],
      skippedCommands: [],
      install: exec("npm ci"),
      results: [exec("npm run test")],
      allPassed: true,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

describe("buildReviewPacket", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "prwr-packet-"));
    // Place the changed file in the checkout so nearby context can be read.
    const repoDir = getArtifactPaths(cwd).workspace.repo;
    await mkdir(join(repoDir, "src"), { recursive: true });
    await writeFile(
      join(repoDir, "src", "f.ts"),
      Array.from({ length: 8 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n"),
      "utf8",
    );
    await writeFile(join(repoDir, "README.md"), "# Repo\n\nA thing.", "utf8");
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function readJson(...segments: string[]): Promise<Record<string, unknown>> {
    const raw = await readFile(join(cwd, ".ai-review", ...segments), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  }

  it("assembles the packet with PR, repo, verification, diff and nearby context", async () => {
    const { packet } = await buildReviewPacket({
      pr: PR,
      prMetadata: prMetadata(),
      changedFiles: changedFiles("@@ -2,1 +2,1 @@"),
      workspace: workspace(),
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
    });

    expect(packet.schemaVersion).toBe(1);
    expect(packet.pr.title).toBe("Add feature");
    expect(packet.repository.detectedCommands).toEqual(["npm run test"]);
    expect(packet.verification.commands[0]).toMatchObject({
      command: "npm run test",
      exitCode: 0,
      passed: true,
    });
    const file = packet.changedFiles[0];
    expect(file?.patch).toContain("@@");
    expect(file?.nearbyContext).toContain("const v2");
    expect(packet.limits.truncated).toBe(false);

    const json = await readJson("context", "review_packet.json");
    expect(json["schemaVersion"]).toBe(1);
    const md = await readFile(join(cwd, ".ai-review", "context", "review_packet.md"), "utf8");
    expect(md).toContain("# Review Packet: org/repo#123");
    expect(md).toContain("npm run test");
    expect(md).toContain("Diff:");
  });

  it("trims patches and flags truncation when over the size limit", async () => {
    const bigPatch = `@@ -1,1 +1,200 @@\n${"+ x\n".repeat(500)}`;
    const config = mergeConfig(defaultConfig, { context: { maxPacketBytes: 500 } });
    const { packet } = await buildReviewPacket({
      pr: PR,
      prMetadata: prMetadata(),
      changedFiles: changedFiles(bigPatch),
      workspace: workspace(),
      config,
      paths: getArtifactPaths(cwd),
      cwd,
    });

    expect(packet.limits.truncated).toBe(true);
    expect(packet.limits.trimmedFiles).toBeGreaterThanOrEqual(1);
    expect(packet.changedFiles[0]?.patch).toBeNull();
    expect(packet.changedFiles[0]?.patchOmitted).toBe(true);
  });

  it("embeds failed verification command output as evidence", async () => {
    const ws = workspace();
    ws.verification.allPassed = false;
    ws.verification.results = [
      exec("npm run test", 1, { stderrPreview: "Error: expected 2 to equal 3" }),
    ];
    const { packet, markdown } = await buildReviewPacket({
      pr: PR,
      prMetadata: prMetadata(),
      changedFiles: changedFiles("@@ -2,1 +2,1 @@"),
      workspace: ws,
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
    });

    expect(packet.verification.commands[0]?.stderrPreview).toContain("expected 2 to equal 3");
    expect(markdown).toContain("expected 2 to equal 3");
    expect(markdown).toContain("<details><summary>output</summary>");
  });

  it("preserves the old path for renamed files", async () => {
    const renamed: ChangedFilesArtifact = {
      schemaVersion: 1,
      totalCount: 1,
      truncated: false,
      files: [
        {
          filename: "src/f.ts",
          status: "renamed",
          additions: 1,
          deletions: 1,
          changes: 2,
          patchOmitted: false,
          patch: "@@ -2,1 +2,1 @@",
          previousFilename: "src/old.ts",
        },
      ],
    };
    const { packet, markdown } = await buildReviewPacket({
      pr: PR,
      prMetadata: prMetadata(),
      changedFiles: renamed,
      workspace: workspace(),
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
    });

    expect(packet.changedFiles[0]?.previousPath).toBe("src/old.ts");
    expect(markdown).toContain("(from `src/old.ts`)");
  });

  it("degrades nearbyContext to null when collection throws (never aborts)", async () => {
    const { packet } = await buildReviewPacket({
      pr: PR,
      prMetadata: prMetadata(),
      changedFiles: changedFiles("@@ -2,1 +2,1 @@"),
      workspace: workspace(),
      config: defaultConfig,
      paths: getArtifactPaths(cwd),
      cwd,
      collectContext: async () => {
        throw new Error("boom");
      },
    });

    expect(packet.changedFiles).toHaveLength(1);
    expect(packet.changedFiles[0]?.nearbyContext).toBeNull();
  });
});
