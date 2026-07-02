import { describe, it, expect } from "vitest";
import { resolveGitHubToken, type ExecFileRunner } from "../../src/github/auth.js";
import { GitHubError } from "../../src/errors.js";

const ghMissing: ExecFileRunner = async () => {
  throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
};
const ghNotLoggedIn: ExecFileRunner = async () => {
  throw Object.assign(new Error("exit 1"), {
    code: 1,
    stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate.",
  });
};
const ghToken = (stdout: string): ExecFileRunner => async () => ({ stdout, stderr: "" });

describe("resolveGitHubToken", () => {
  it("prefers GITHUB_TOKEN and trims it", async () => {
    const r = await resolveGitHubToken({ GITHUB_TOKEN: "  gt  ", GH_TOKEN: "ght" }, ghMissing);
    expect(r).toEqual({ token: "gt", source: "env:GITHUB_TOKEN" });
  });

  it("falls back to GH_TOKEN", async () => {
    const r = await resolveGitHubToken({ GH_TOKEN: "ght" }, ghMissing);
    expect(r).toEqual({ token: "ght", source: "env:GH_TOKEN" });
  });

  it("falls back to GITHUB_PERSONAL_ACCESS_TOKEN (the GitHub MCP var)", async () => {
    const r = await resolveGitHubToken({ GITHUB_PERSONAL_ACCESS_TOKEN: "  ghp_mcp  " }, ghMissing);
    expect(r).toEqual({ token: "ghp_mcp", source: "env:GITHUB_PERSONAL_ACCESS_TOKEN" });
  });

  it("prefers GITHUB_TOKEN over the MCP token var", async () => {
    const r = await resolveGitHubToken(
      { GITHUB_TOKEN: "gt", GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_mcp" },
      ghMissing,
    );
    expect(r.source).toBe("env:GITHUB_TOKEN");
  });

  it("falls back to `gh auth token` (trimming the trailing newline)", async () => {
    const r = await resolveGitHubToken({}, ghToken("ghp_abc\n"));
    expect(r).toEqual({ token: "ghp_abc", source: "gh" });
  });

  it("errors with an install hint when gh is missing (ENOENT)", async () => {
    await expect(resolveGitHubToken({}, ghMissing)).rejects.toBeInstanceOf(GitHubError);
    await expect(resolveGitHubToken({}, ghMissing)).rejects.toThrow(/not installed/i);
  });

  it("errors with a login hint when gh is not authenticated", async () => {
    await expect(resolveGitHubToken({}, ghNotLoggedIn)).rejects.toThrow(/gh auth login/i);
  });

  it("errors when gh returns empty stdout", async () => {
    await expect(resolveGitHubToken({}, ghToken("  \n"))).rejects.toBeInstanceOf(GitHubError);
  });

  it("gives an actionable setup message and never echoes a token", async () => {
    await expect(resolveGitHubToken({}, ghMissing)).rejects.toThrow(/GITHUB_TOKEN/);
    // The env path returns the token; the error path has no token to leak.
    let message = "";
    try {
      await resolveGitHubToken({}, ghMissing);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/GITHUB_TOKEN/);
    expect(message).not.toMatch(/Bearer/);
  });
});
