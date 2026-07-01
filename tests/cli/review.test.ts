import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../../src/cli/commands/review.js";
import { PrUrlError, GitHubError } from "../../src/errors.js";
import { CONFIG_FILENAME } from "../../src/config/loadConfig.js";
import { silentReporter } from "../../src/ui/reporter.js";
import type { IngestPullRequest, IngestResult } from "../../src/github/types.js";

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

describe("runReview (integration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-review-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes run_metadata.json with the parsed PR and default config", async () => {
    await runReview("https://github.com/org/repo/pull/123", {
      version: "0.1.0",
      cwd: dir,
      reporter: silentReporter(),
      ingest: fakeIngest(),
    });
    const meta = await readJson(dir, "run_metadata.json");
    expect(meta["pr"]).toEqual({ owner: "org", repo: "repo", number: 123 });
    expect(meta["configSource"]).toBe("default");
    expect(meta["phase"]).toBe(1);
    expect((meta["config"] as { review: { maxFindings: number } }).review.maxFindings).toBe(20);
  });

  it("reflects a user config override", async () => {
    await writeFile(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ review: { maxFindings: 5 } }),
      "utf8",
    );
    await runReview("https://github.com/org/repo/pull/1", {
      version: "0.1.0",
      cwd: dir,
      reporter: silentReporter(),
      ingest: fakeIngest(),
    });
    const meta = await readJson(dir, "run_metadata.json");
    expect(meta["configSource"]).toBe("file");
    expect((meta["config"] as { review: { maxFindings: number } }).review.maxFindings).toBe(5);
  });

  it("writes the three GitHub ingestion artifacts", async () => {
    await runReview("https://github.com/org/repo/pull/123", {
      version: "0.1.0",
      cwd: dir,
      reporter: silentReporter(),
      ingest: fakeIngest(),
    });
    const prMeta = await readJson(dir, "github", "pr_metadata.json");
    expect(prMeta["number"]).toBe(123);
    const changed = await readJson(dir, "github", "changed_files.json");
    expect(changed["totalCount"]).toBe(1);
    const diff = await readFile(join(dir, ".ai-review", "github", "diff.patch"), "utf8");
    expect(diff).toBe("DIFF TEXT");
  });

  it("does not write diff.patch when the diff is null", async () => {
    await runReview("https://github.com/org/repo/pull/123", {
      version: "0.1.0",
      cwd: dir,
      reporter: silentReporter(),
      ingest: fakeIngest({ diff: null }),
    });
    await expect(stat(join(dir, ".ai-review", "github", "diff.patch"))).rejects.toThrow();
  });

  it("propagates a GitHubError raised during ingestion", async () => {
    const failing: IngestPullRequest = async () => {
      throw new GitHubError("auth failed");
    };
    await expect(
      runReview("https://github.com/org/repo/pull/123", {
        version: "0.1.0",
        cwd: dir,
        reporter: silentReporter(),
        ingest: failing,
      }),
    ).rejects.toBeInstanceOf(GitHubError);
  });

  it("rejects an invalid URL and writes no artifact", async () => {
    await expect(
      runReview("not-a-url", {
        version: "0.1.0",
        cwd: dir,
        reporter: silentReporter(),
        ingest: fakeIngest(),
      }),
    ).rejects.toThrow(PrUrlError);
    await expect(stat(join(dir, ".ai-review"))).rejects.toThrow();
  });
});
