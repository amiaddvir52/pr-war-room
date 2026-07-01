import { describe, it, expect } from "vitest";
import { fetchPrDiff } from "../../src/github/fetchPrDiff.js";
import { GitHubError } from "../../src/errors.js";
import type { GitHubClient, GitHubRawResult } from "../../src/github/types.js";

const pr = { owner: "org", repo: "repo", number: 7 };

function clientRaw(over: Partial<GitHubRawResult>): GitHubClient {
  const result: GitHubRawResult = {
    status: 200,
    ok: true,
    headers: new Headers(),
    body: "diff --git a b",
    ...over,
  };
  return {
    getJson: async () => {
      throw new Error("unused");
    },
    requestRaw: async () => result,
  };
}

describe("fetchPrDiff", () => {
  it("returns the diff text on success", async () => {
    await expect(fetchPrDiff(clientRaw({}), pr)).resolves.toBe("diff --git a b");
  });

  it("returns null when the diff is too large (406)", async () => {
    await expect(fetchPrDiff(clientRaw({ status: 406, ok: false, body: "" }), pr)).resolves.toBeNull();
  });

  it("returns null on a transient 5xx", async () => {
    await expect(fetchPrDiff(clientRaw({ status: 503, ok: false, body: "" }), pr)).resolves.toBeNull();
  });

  it("throws GitHubError on other error statuses (e.g. 404)", async () => {
    await expect(fetchPrDiff(clientRaw({ status: 404, ok: false, body: "" }), pr)).rejects.toBeInstanceOf(
      GitHubError,
    );
  });
});
