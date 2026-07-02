import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../../src/cli/commands/review.js";
import type { PrepareWorkspaceFn, BuildReviewPacketFn } from "../../src/cli/commands/review.js";
import type { RunReviewers, RunReviewersInput } from "../../src/agents/runReviewers.js";
import { PrUrlError, GitHubError, ReviewerError } from "../../src/errors.js";
import { CONFIG_FILENAME } from "../../src/config/loadConfig.js";
import { silentReporter } from "../../src/ui/reporter.js";
import type { IngestPullRequest, IngestResult } from "../../src/github/types.js";
import type { PrepareWorkspaceInput, WorkspaceResult } from "../../src/workspace/types.js";
import type { BuildReviewPacketInput, ReviewPacket } from "../../src/context/types.js";

async function readJson(dir: string, ...segments: string[]): Promise<Record<string, unknown>> {
  const raw = await readFile(join(dir, ".ai-review", ...segments), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function makeIngestResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    metadata: {
      schemaVersion: 1,
      owner: "org",
      repo: "repo",
      number: 123,
      title: "Test PR",
      description: "",
      author: "alice",
      state: "open",
      draft: false,
      baseBranch: "main",
      headBranch: "feature",
      baseRepo: "org/repo",
      headRepo: "org/repo",
      counts: { additions: 1, deletions: 0, changedFiles: 1, commits: 1 },
      htmlUrl: "https://github.com/org/repo/pull/123",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    },
    changedFiles: {
      schemaVersion: 1,
      totalCount: 1,
      truncated: false,
      files: [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patchOmitted: false, patch: "@@" },
      ],
    },
    diff: "DIFF TEXT",
    ...overrides,
  };
}

const fakeIngest =
  (overrides?: Partial<IngestResult>): IngestPullRequest =>
  async () =>
    makeIngestResult(overrides);

function makeWorkspaceResult(overrides: { allPassed?: boolean; ran?: boolean } = {}): WorkspaceResult {
  const ran = overrides.ran ?? false;
  return {
    metadata: {
      schemaVersion: 1,
      repoDir: ".ai-review/workspace/repo",
      remote: "https://github.com/org/repo.git",
      ref: "pull/123/head",
      headSha: "deadbeef",
      reused: false,
      projectTypes: ["node"],
      packageManager: "npm",
      detected: { install: "npm ci", commands: ["npm run test"] },
      verification: {
        enabled: ran,
        enabledSource: ran ? "flag" : "default",
        installPlanned: "npm ci",
        commandsPlanned: ["npm run test"],
      },
      preparedAt: "2026-01-01T00:00:00.000Z",
    },
    verification: {
      schemaVersion: 1,
      enabled: ran,
      enabledSource: ran ? "flag" : "default",
      ran,
      skipReason: ran ? null : "disabled",
      detectedCommands: ["npm run test"],
      configuredCommands: [],
      installCommand: "npm ci",
      executedCommands: ran ? ["npm run test"] : [],
      skippedCommands: ran ? [] : ["npm run test"],
      install: null,
      results: [],
      allPassed: overrides.allPassed ?? true,
      startedAt: null,
      finishedAt: null,
    },
  };
}

function capturingWorkspace(): { fn: PrepareWorkspaceFn; calls: PrepareWorkspaceInput[] } {
  const calls: PrepareWorkspaceInput[] = [];
  const fn: PrepareWorkspaceFn = async (input) => {
    calls.push(input);
    return makeWorkspaceResult();
  };
  return { fn, calls };
}
const fakeWorkspace = (): PrepareWorkspaceFn => capturingWorkspace().fn;

function makePacket(overrides: { truncated?: boolean } = {}): ReviewPacket {
  return {
    schemaVersion: 1,
    pr: {
      owner: "org",
      repo: "repo",
      number: 123,
      title: "Test PR",
      description: "",
      author: "alice",
      state: "open",
      draft: false,
      baseBranch: "main",
      headBranch: "feature",
      htmlUrl: "https://github.com/org/repo/pull/123",
    },
    repository: { projectTypes: ["node"], packageManager: "npm", detectedCommands: ["npm run test"], headSha: "deadbeef" },
    verification: { enabled: false, ran: false, allPassed: true, install: null, commands: [] },
    changedFiles: [],
    repoConventions: { readmeSummary: null, testConventions: null, errorHandlingPatterns: null, apiPatterns: null },
    limits: { maxPacketBytes: 524_288, approxBytes: 100, truncated: overrides.truncated ?? false, trimmedFiles: 0 },
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function capturingBuildPacket(): { fn: BuildReviewPacketFn; calls: BuildReviewPacketInput[] } {
  const calls: BuildReviewPacketInput[] = [];
  const fn: BuildReviewPacketFn = async (input) => {
    calls.push(input);
    return { packet: makePacket(), markdown: "# packet" };
  };
  return { fn, calls };
}
const fakeBuildPacket = (): BuildReviewPacketFn => capturingBuildPacket().fn;

function capturingReviewer(): { fn: RunReviewers; calls: RunReviewersInput[] } {
  const calls: RunReviewersInput[] = [];
  const fn: RunReviewers = async (input) => {
    calls.push(input);
    return { findings: [], agents: [] };
  };
  return { fn, calls };
}
const fakeReviewer = (): RunReviewers => capturingReviewer().fn;

/** Common injected fakes for the whole pipeline (Phases 1–5). */
function fakes(extra: Partial<Parameters<typeof runReview>[1]> = {}) {
  return {
    version: "0.1.0",
    reporter: silentReporter(),
    ingest: fakeIngest(),
    prepareWorkspace: fakeWorkspace(),
    buildReviewPacket: fakeBuildPacket(),
    runReviewers: fakeReviewer(),
    ...extra,
  };
}

describe("runReview (integration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-review-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes run_metadata.json with the parsed PR and default config", async () => {
    await runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir }));
    const meta = await readJson(dir, "run_metadata.json");
    expect(meta["pr"]).toEqual({ owner: "org", repo: "repo", number: 123 });
    expect(meta["configSource"]).toBe("default");
    expect((meta["config"] as { review: { maxFindings: number } }).review.maxFindings).toBe(20);
  });

  it("reflects a user config override", async () => {
    await writeFile(join(dir, CONFIG_FILENAME), JSON.stringify({ review: { maxFindings: 5 } }), "utf8");
    await runReview("https://github.com/org/repo/pull/1", fakes({ cwd: dir }));
    const meta = await readJson(dir, "run_metadata.json");
    expect(meta["configSource"]).toBe("file");
    expect((meta["config"] as { review: { maxFindings: number } }).review.maxFindings).toBe(5);
  });

  it("writes the three GitHub ingestion artifacts", async () => {
    await runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir }));
    expect((await readJson(dir, "github", "pr_metadata.json"))["number"]).toBe(123);
    expect((await readJson(dir, "github", "changed_files.json"))["totalCount"]).toBe(1);
    const diff = await readFile(join(dir, ".ai-review", "github", "diff.patch"), "utf8");
    expect(diff).toBe("DIFF TEXT");
  });

  it("does not write diff.patch when the diff is null", async () => {
    await runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir, ingest: fakeIngest({ diff: null }) }));
    await expect(stat(join(dir, ".ai-review", "github", "diff.patch"))).rejects.toThrow();
  });

  it("invokes workspace prep once, without verify by default", async () => {
    const ws = capturingWorkspace();
    await runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir, prepareWorkspace: ws.fn }));
    expect(ws.calls).toHaveLength(1);
    expect(ws.calls[0]?.verify).toBeUndefined();
    expect(ws.calls[0]?.pr).toEqual({ owner: "org", repo: "repo", number: 123 });
  });

  it("threads verify=true through to workspace prep", async () => {
    const ws = capturingWorkspace();
    await runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir, verify: true, prepareWorkspace: ws.fn }));
    expect(ws.calls[0]?.verify).toBe(true);
  });

  it("builds the review packet with the ingested + workspace data", async () => {
    const bp = capturingBuildPacket();
    await runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir, buildReviewPacket: bp.fn }));
    expect(bp.calls).toHaveLength(1);
    expect(bp.calls[0]?.pr).toEqual({ owner: "org", repo: "repo", number: 123 });
    expect(bp.calls[0]?.changedFiles.totalCount).toBe(1);
    expect(bp.calls[0]?.workspace.metadata.projectTypes).toEqual(["node"]);
  });

  it("does not fail the review when verification reports allPassed:false", async () => {
    const failingWorkspace: PrepareWorkspaceFn = async () => makeWorkspaceResult({ ran: true, allPassed: false });
    await expect(
      runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir, verify: true, prepareWorkspace: failingWorkspace })),
    ).resolves.toBeUndefined();
  });

  it("passes the packet, markdown and config to the reviewer fan-out", async () => {
    const rv = capturingReviewer();
    await runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir, runReviewers: rv.fn }));
    expect(rv.calls).toHaveLength(1);
    expect(rv.calls[0]?.packetMarkdown).toBe("# packet");
    expect(rv.calls[0]?.packet.schemaVersion).toBe(1);
    expect(rv.calls[0]?.config.agents.reviewers).toHaveLength(3);
    expect(rv.calls[0]?.config.agents.reviewers[0]?.backend).toBe("claude");
  });

  it("propagates a ReviewerError raised by the reviewer fan-out", async () => {
    const failing: RunReviewers = async () => {
      throw new ReviewerError("all reviewer agents failed");
    };
    await expect(
      runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir, runReviewers: failing })),
    ).rejects.toBeInstanceOf(ReviewerError);
  });

  it("runs the real mock reviewer end-to-end and writes normalized findings", async () => {
    await writeFile(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ agents: { reviewers: [{ name: "mock", backend: "mock" }] } }),
      "utf8",
    );
    const buildPacketWithFile: BuildReviewPacketFn = async () => ({
      packet: {
        ...makePacket(),
        changedFiles: [
          {
            path: "src/x.ts",
            status: "modified",
            previousPath: null,
            additions: 3,
            deletions: 1,
            patchOmitted: false,
            patch: "@@ -1 +1 @@",
            nearbyContext: null,
          },
        ],
      },
      markdown: "# packet",
    });

    // Note: no `runReviewers` injected — the real fan-out (with MockReviewer) runs.
    await runReview("https://github.com/org/repo/pull/123", {
      version: "0.1.0",
      reporter: silentReporter(),
      ingest: fakeIngest(),
      prepareWorkspace: fakeWorkspace(),
      buildReviewPacket: buildPacketWithFile,
      cwd: dir,
    });

    const findings = JSON.parse(
      await readFile(join(dir, ".ai-review", "normalized", "all_findings.json"), "utf8"),
    ) as Array<{ id: string; source_agent: string }>;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.source_agent).toBe("mock");
    expect(findings[0]?.id).toMatch(/^mock-\d{3}$/);
  });

  it("propagates a GitHubError raised during ingestion", async () => {
    const failing: IngestPullRequest = async () => {
      throw new GitHubError("auth failed");
    };
    await expect(
      runReview("https://github.com/org/repo/pull/123", fakes({ cwd: dir, ingest: failing })),
    ).rejects.toBeInstanceOf(GitHubError);
  });

  it("rejects an invalid URL and writes no artifact", async () => {
    await expect(runReview("not-a-url", fakes({ cwd: dir }))).rejects.toThrow(PrUrlError);
    await expect(stat(join(dir, ".ai-review"))).rejects.toThrow();
  });
});
