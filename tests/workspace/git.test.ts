import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrHeadWorkspace,
  gitDiff,
  restoreWorkspace,
} from "../../src/workspace/git.js";
import type { GitRunner } from "../../src/workspace/git.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pwr-git-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeRunner(
  respond: (args: string[]) => string = () => "",
): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    return { stdout: respond(args), stderr: "" };
  };
  return { runner, calls };
}

describe("gitDiff", () => {
  it("returns the working-tree diff with the output format pinned against user git config", async () => {
    const { runner, calls } = fakeRunner((args) => (args.includes("diff") ? "DIFF" : ""));
    expect(await gitDiff("/repo", runner)).toBe("DIFF");
    // Pinning matters: a global diff.noprefix/diff.external/color.diff would
    // otherwise make patch.diff unusable by `git apply`.
    expect(calls).toEqual([
      [
        "-C",
        "/repo",
        "-c",
        "diff.noprefix=false",
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ],
    ]);
  });
});

describe("restoreWorkspace", () => {
  it("hard-resets and cleans WITHOUT -x (keeps node_modules)", async () => {
    const { runner, calls } = fakeRunner();
    await restoreWorkspace("/repo", runner);
    expect(calls).toEqual([
      ["-C", "/repo", "reset", "--hard", "HEAD"],
      ["-C", "/repo", "clean", "-fd"],
    ]);
  });
});

describe("ensurePrHeadWorkspace", () => {
  const base = { owner: "org", repo: "repo", number: 123, token: null };

  it("reuses (restore only, no fetch) when HEAD matches the reviewed sha", async () => {
    const repoDir = join(dir, "repo");
    await mkdir(join(repoDir, ".git"), { recursive: true });
    const { runner, calls } = fakeRunner((args) =>
      args.includes("rev-parse") ? "abc123\n" : "",
    );
    const result = await ensurePrHeadWorkspace({
      ...base,
      repoDir,
      expectedHeadSha: "abc123",
      runner,
    });
    expect(result).toMatchObject({ reused: true, headMoved: false, headSha: "abc123" });
    // No fetch/checkout — offline reuse of the reviewed commit.
    expect(calls.some((args) => args.includes("fetch"))).toBe(false);
    expect(calls.some((args) => args.includes("reset"))).toBe(true);
  });

  it("re-fetches and flags headMoved when the checkout is at a different sha", async () => {
    const repoDir = join(dir, "repo");
    await mkdir(join(repoDir, ".git"), { recursive: true });
    const { runner, calls } = fakeRunner((args) =>
      args.includes("rev-parse") ? "newhead\n" : "",
    );
    const result = await ensurePrHeadWorkspace({
      ...base,
      repoDir,
      expectedHeadSha: "oldhead",
      runner,
    });
    expect(calls.some((args) => args.includes("fetch"))).toBe(true);
    expect(result).toMatchObject({ headMoved: true, headSha: "newhead" });
  });

  it("falls back to a full prepare when there is no checkout", async () => {
    const repoDir = join(dir, "repo");
    const { runner, calls } = fakeRunner((args) =>
      args.includes("rev-parse") ? "abc123\n" : "",
    );
    const result = await ensurePrHeadWorkspace({
      ...base,
      repoDir,
      expectedHeadSha: "abc123",
      runner,
    });
    expect(calls.some((args) => args.includes("fetch"))).toBe(true);
    // Fetched head equals the reviewed sha — not stale.
    expect(result).toMatchObject({ headMoved: false, headSha: "abc123" });
  });

  it("always re-fetches when the reviewed sha is unknown", async () => {
    const repoDir = join(dir, "repo");
    await mkdir(join(repoDir, ".git"), { recursive: true });
    const { runner, calls } = fakeRunner((args) =>
      args.includes("rev-parse") ? "abc123\n" : "",
    );
    const result = await ensurePrHeadWorkspace({
      ...base,
      repoDir,
      expectedHeadSha: null,
      runner,
    });
    expect(calls.some((args) => args.includes("fetch"))).toBe(true);
    // Unknown baseline: nothing to compare against, so never flagged stale.
    expect(result.headMoved).toBe(false);
  });
});
