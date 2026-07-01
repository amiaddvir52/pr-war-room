import { describe, it, expect, vi } from "vitest";
import { fetchChangedFiles } from "../../src/github/fetchChangedFiles.js";
import { GitHubError } from "../../src/errors.js";
import type { GitHubClient } from "../../src/github/types.js";

const pr = { owner: "org", repo: "repo", number: 7 };

const mkFile = (name: string, extra: Record<string, unknown> = {}) => ({
  filename: name,
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  patch: "@@ -1 +1 @@",
  ...extra,
});
const fullPage = (prefix: string) =>
  Array.from({ length: 100 }, (_, k) => mkFile(`${prefix}/${k}.ts`));

/** A client whose getJson returns successive pages (repeats the last). */
function pagedClient(pages: unknown[][]) {
  let i = 0;
  const getJson = vi.fn(async () => pages[Math.min(i++, pages.length - 1)]);
  const client: GitHubClient = {
    getJson,
    requestRaw: async () => {
      throw new Error("unused");
    },
  };
  return { client, getJson };
}

describe("fetchChangedFiles", () => {
  it("returns a single short page without paginating further", async () => {
    const { client, getJson } = pagedClient([[mkFile("a.ts"), mkFile("b.ts")]]);
    const result = await fetchChangedFiles(client, pr);
    expect(result.totalCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("paginates across full pages until a short page (100 -> 100 -> 50)", async () => {
    const { client, getJson } = pagedClient([
      fullPage("p1"),
      fullPage("p2"),
      Array.from({ length: 50 }, (_, k) => mkFile(`p3/${k}.ts`)),
    ]);
    const result = await fetchChangedFiles(client, pr);
    expect(result.totalCount).toBe(250);
    expect(result.truncated).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(3);
  });

  it("handles an empty PR", async () => {
    const { client, getJson } = pagedClient([[]]);
    const result = await fetchChangedFiles(client, pr);
    expect(result.totalCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it("stops at the 3000-file cap and marks truncated", async () => {
    const { client, getJson } = pagedClient([fullPage("x")]); // always a full page
    const result = await fetchChangedFiles(client, pr);
    expect(result.totalCount).toBe(3000);
    expect(result.truncated).toBe(true);
    expect(getJson).toHaveBeenCalledTimes(30);
  });

  it("records patchOmitted for a file without a patch and previousFilename on renames", async () => {
    const { client } = pagedClient([
      [
        mkFile("logo.png", { patch: undefined, additions: 0, deletions: 0 }),
        mkFile("new.ts", { status: "renamed", previous_filename: "old.ts" }),
      ],
    ]);
    const result = await fetchChangedFiles(client, pr);
    expect(result.files[0]).toMatchObject({ filename: "logo.png", patchOmitted: true });
    expect(result.files[0]?.patch).toBeUndefined();
    expect(result.files[1]).toMatchObject({
      status: "renamed",
      previousFilename: "old.ts",
      patchOmitted: false,
    });
  });

  it("throws GitHubError on a malformed page", async () => {
    const { client } = pagedClient([[{ filename: 5 }]]);
    await expect(fetchChangedFiles(client, pr)).rejects.toBeInstanceOf(GitHubError);
  });
});
