import { describe, it, expect } from "vitest";
import { parsePrUrl } from "../../src/github/parsePrUrl.js";
import { PrUrlError } from "../../src/errors.js";

describe("parsePrUrl", () => {
  it("parses a canonical PR URL", () => {
    expect(parsePrUrl("https://github.com/org/repo/pull/123")).toEqual({
      owner: "org",
      repo: "repo",
      number: 123,
    });
  });

  it.each([
    ["https://github.com/org/repo/pull/123/files", 123],
    ["https://github.com/org/repo/pull/123/commits", 123],
    ["https://github.com/org/repo/pull/7?diff=split", 7],
    ["https://github.com/org/repo/pull/42#discussion_r1", 42],
  ] as const)("tolerates trailing/query/fragment (%s)", (url, expected) => {
    expect(parsePrUrl(url).number).toBe(expected);
  });

  it("normalizes a scheme-less URL", () => {
    expect(parsePrUrl("github.com/org/repo/pull/9")).toEqual({
      owner: "org",
      repo: "repo",
      number: 9,
    });
  });

  it("accepts the http scheme", () => {
    expect(parsePrUrl("http://github.com/org/repo/pull/5").number).toBe(5);
  });

  it("strips a .git suffix from the repo", () => {
    expect(parsePrUrl("https://github.com/org/repo.git/pull/1").repo).toBe("repo");
  });

  it("handles dashed and dotted owner/repo", () => {
    expect(parsePrUrl("https://github.com/my-org/repo.js/pull/2")).toEqual({
      owner: "my-org",
      repo: "repo.js",
      number: 2,
    });
  });

  it.each([
    "",
    "   ",
    "not-a-url",
    "https://github.com/org/repo",
    "https://github.com/org/repo/issues/5",
    "https://gitlab.com/org/repo/pull/1",
    "https://github.com/org/repo/pull/abc",
    "git@github.com:org/repo.git", // SSH not supported yet
  ])("throws PrUrlError for invalid input (%j)", (input) => {
    expect(() => parsePrUrl(input)).toThrow(PrUrlError);
  });
});
