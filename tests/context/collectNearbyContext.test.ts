import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectNearbyContext,
  parseHunkNewRanges,
  mergeRanges,
} from "../../src/context/collectNearbyContext.js";

describe("parseHunkNewRanges", () => {
  it("parses new-file ranges from hunk headers", () => {
    const patch = "@@ -1,3 +1,4 @@ ctx\n line\n@@ -20,0 +25,2 @@ func\n";
    expect(parseHunkNewRanges(patch)).toEqual([
      [1, 4],
      [25, 26],
    ]);
  });

  it("treats a header without a length as one line", () => {
    expect(parseHunkNewRanges("@@ -5 +7 @@")).toEqual([[7, 7]]);
  });

  it("returns [] when there are no hunks", () => {
    expect(parseHunkNewRanges("not a diff")).toEqual([]);
  });
});

describe("mergeRanges", () => {
  it("merges overlapping and adjacent ranges", () => {
    expect(
      mergeRanges([
        [1, 5],
        [6, 8],
        [20, 22],
      ]),
    ).toEqual([
      [1, 8],
      [20, 22],
    ]);
  });
});

describe("collectNearbyContext", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-nearby-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns line-numbered context around a hunk", async () => {
    await writeFile(
      join(dir, "f.ts"),
      Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"),
      "utf8",
    );
    const out = await collectNearbyContext({
      repoDir: dir,
      filePath: "f.ts",
      patch: "@@ -3,1 +3,1 @@",
      status: "modified",
      contextLines: 1,
    });
    expect(out).toContain("@@ lines 2-4 @@");
    expect(out).toContain("2\tline2");
    expect(out).toContain("4\tline4");
    expect(out).not.toContain("line6");
  });

  it("caps total emitted lines at maxTotalLines", async () => {
    await writeFile(
      join(dir, "big.ts"),
      Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n"),
      "utf8",
    );
    const out = await collectNearbyContext({
      repoDir: dir,
      filePath: "big.ts",
      patch: "@@ -1,50 +1,50 @@",
      status: "modified",
      contextLines: 0,
      maxTotalLines: 5,
    });
    const bodyLines = (out ?? "").split("\n").filter((l) => /^\d+\t/.test(l));
    expect(bodyLines).toHaveLength(5);
  });

  it("returns null for a removed file", async () => {
    expect(
      await collectNearbyContext({
        repoDir: dir,
        filePath: "x.ts",
        patch: "@@ -1 +1 @@",
        status: "removed",
        contextLines: 2,
      }),
    ).toBeNull();
  });

  it("returns null when the file is missing from the checkout", async () => {
    expect(
      await collectNearbyContext({
        repoDir: dir,
        filePath: "missing.ts",
        patch: "@@ -1,1 +1,1 @@",
        status: "modified",
        contextLines: 2,
      }),
    ).toBeNull();
  });

  it("returns null when there is no patch", async () => {
    await writeFile(join(dir, "f.ts"), "a\nb\n", "utf8");
    expect(
      await collectNearbyContext({
        repoDir: dir,
        filePath: "f.ts",
        patch: null,
        status: "modified",
        contextLines: 2,
      }),
    ).toBeNull();
  });
});
