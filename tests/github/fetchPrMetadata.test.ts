import { describe, it, expect } from "vitest";
import { fetchPrMetadata } from "../../src/github/fetchPrMetadata.js";
import { GitHubError } from "../../src/errors.js";
import type { GitHubClient } from "../../src/github/types.js";

const pr = { owner: "org", repo: "repo", number: 7 };

function clientReturning(json: unknown): GitHubClient {
  return {
    getJson: async () => json,
    requestRaw: async () => {
      throw new Error("unused");
    },
  };
}

const rawPull = {
  title: "Add feature",
  body: "Body text",
  state: "open",
  draft: false,
  merged: false,
  user: { login: "alice" },
  base: { ref: "main", repo: { full_name: "org/repo" } },
  head: { ref: "feature", repo: { full_name: "fork/repo" } },
  additions: 10,
  deletions: 2,
  changed_files: 3,
  commits: 4,
  html_url: "https://github.com/org/repo/pull/7",
};

describe("fetchPrMetadata", () => {
  it("normalizes a full PR payload", async () => {
    const meta = await fetchPrMetadata(clientReturning(rawPull), pr);
    expect(meta).toMatchObject({
      schemaVersion: 1,
      owner: "org",
      repo: "repo",
      number: 7,
      title: "Add feature",
      description: "Body text",
      author: "alice",
      state: "open",
      baseBranch: "main",
      headBranch: "feature",
      baseRepo: "org/repo",
      headRepo: "fork/repo",
      counts: { additions: 10, deletions: 2, changedFiles: 3, commits: 4 },
    });
    expect(meta.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("derives state 'merged' from merged === true", async () => {
    const meta = await fetchPrMetadata(clientReturning({ ...rawPull, state: "closed", merged: true }), pr);
    expect(meta.state).toBe("merged");
  });

  it("tolerates a null head.repo (deleted fork) and empty body", async () => {
    const meta = await fetchPrMetadata(
      clientReturning({ ...rawPull, body: null, head: { ref: "feature", repo: null } }),
      pr,
    );
    expect(meta.headRepo).toBeNull();
    expect(meta.description).toBe("");
  });

  it("throws GitHubError on a malformed payload", async () => {
    await expect(fetchPrMetadata(clientReturning({ title: 123 }), pr)).rejects.toBeInstanceOf(
      GitHubError,
    );
  });
});
