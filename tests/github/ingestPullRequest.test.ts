import { describe, it, expect, vi } from "vitest";
import { ingestPullRequest } from "../../src/github/ingestPullRequest.js";
import { silentReporter } from "../../src/ui/reporter.js";
import { jsonResponse, textResponse, routedFetch } from "./fakeFetch.js";

const pr = { owner: "org", repo: "repo", number: 7 };
const env = { GITHUB_TOKEN: "t" };

const rawPull = {
  title: "Feature",
  body: "b",
  state: "open",
  draft: false,
  merged: false,
  user: { login: "alice" },
  base: { ref: "main", repo: { full_name: "org/repo" } },
  head: { ref: "feature", repo: { full_name: "org/repo" } },
  additions: 3,
  deletions: 1,
  changed_files: 1,
  commits: 1,
  html_url: "https://github.com/org/repo/pull/7",
};
const oneFile = [
  { filename: "a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@" },
];

describe("ingestPullRequest", () => {
  it("fetches metadata, changed files, and diff concurrently", async () => {
    const fetchImpl = routedFetch(async (url, accept) => {
      if (url.includes("/files")) {
        const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
        return jsonResponse(page === 1 ? oneFile : []);
      }
      if (accept.includes("diff")) return textResponse("DIFF TEXT");
      return jsonResponse(rawPull);
    });

    const reporter = silentReporter();
    const warn = vi.spyOn(reporter, "warn");
    const result = await ingestPullRequest(pr, { version: "1.0.0", reporter, env, fetchImpl });

    expect(result.metadata.title).toBe("Feature");
    expect(result.changedFiles.totalCount).toBe(1);
    expect(result.changedFiles.truncated).toBe(false);
    expect(result.diff).toBe("DIFF TEXT");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and returns null diff when the diff is too large", async () => {
    const fetchImpl = routedFetch(async (url, accept) => {
      if (url.includes("/files")) return jsonResponse(oneFile);
      if (accept.includes("diff")) return textResponse("", { status: 406 });
      return jsonResponse(rawPull);
    });
    const reporter = silentReporter();
    const warn = vi.spyOn(reporter, "warn");
    const result = await ingestPullRequest(pr, { version: "1.0.0", reporter, env, fetchImpl });

    expect(result.diff).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/too large/i));
  });

  it("warns when the changed-file list is truncated", async () => {
    const fetchImpl = routedFetch(async (url, accept) => {
      if (url.includes("/files")) {
        return jsonResponse(
          Array.from({ length: 100 }, (_, k) => ({
            filename: `f/${k}.ts`,
            status: "modified",
            additions: 1,
            deletions: 0,
            changes: 1,
            patch: "@@",
          })),
        );
      }
      if (accept.includes("diff")) return textResponse("D");
      return jsonResponse(rawPull);
    });
    const reporter = silentReporter();
    const warn = vi.spyOn(reporter, "warn");
    const result = await ingestPullRequest(pr, { version: "1.0.0", reporter, env, fetchImpl });

    expect(result.changedFiles.truncated).toBe(true);
    expect(result.changedFiles.totalCount).toBe(3000);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/truncated/i));
  });
});
