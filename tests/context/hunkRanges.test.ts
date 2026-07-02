import { describe, it, expect } from "vitest";
import { mergeRanges, parseHunkNewRanges } from "../../src/context/hunkRanges.js";

describe("parseHunkNewRanges", () => {
  it("reads the new-file range from a hunk header with a count", () => {
    expect(parseHunkNewRanges("@@ -10,5 +20,3 @@")).toEqual([[20, 22]]);
  });

  it("treats a missing count as a single line", () => {
    expect(parseHunkNewRanges("@@ -5 +7 @@")).toEqual([[7, 7]]);
  });

  it("collects multiple hunks and ignores non-header lines", () => {
    const patch = "@@ -1,2 +1,2 @@\n context\n@@ -40,1 +45,4 @@\n+x";
    expect(parseHunkNewRanges(patch)).toEqual([
      [1, 2],
      [45, 48],
    ]);
  });

  it("returns nothing for a non-diff string", () => {
    expect(parseHunkNewRanges("not a diff")).toEqual([]);
  });

  it("drops pure-deletion hunks by default (no new-file lines to show)", () => {
    expect(parseHunkNewRanges("@@ -5,2 +5,0 @@")).toEqual([]);
  });

  it("keeps a pure-deletion hunk as a zero-width point when keepEmpty is set", () => {
    expect(parseHunkNewRanges("@@ -5,2 +5,0 @@", { keepEmpty: true })).toEqual([[5, 5]]);
  });
});

describe("mergeRanges", () => {
  it("merges overlapping and adjacent ranges", () => {
    expect(
      mergeRanges([
        [1, 3],
        [4, 6],
        [10, 12],
      ]),
    ).toEqual([
      [1, 6],
      [10, 12],
    ]);
  });
});
