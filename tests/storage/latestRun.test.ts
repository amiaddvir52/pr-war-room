import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId,
  readLatestRunPointer,
  writeLatestRunPointer,
} from "../../src/storage/latestRun.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "prwr-latest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("newRunId", () => {
  it("is filesystem-safe and lexicographically sortable by time", () => {
    const a = newRunId(new Date("2026-07-06T09:00:00.000Z"));
    const b = newRunId(new Date("2026-07-06T09:00:01.000Z"));
    expect(a).toMatch(/^2026-07-06T09-00-00Z-[0-9a-f]{4}$/);
    expect(a < b).toBe(true);
    expect(a).not.toMatch(/[:/\\]/);
  });

  it("cannot collide for two runs in the same second (random suffix)", () => {
    const now = new Date("2026-07-06T09:00:00.000Z");
    const ids = new Set(Array.from({ length: 32 }, () => newRunId(now)));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe("latest-run pointer", () => {
  it("round-trips through write + read", async () => {
    await writeLatestRunPointer({
      baseDir: dir,
      runId: "run-42",
      command: "review",
      pr: { owner: "org", repo: "repo", number: 7 },
      prUrl: "https://github.com/org/repo/pull/7",
    });
    const pointer = await readLatestRunPointer(dir);
    expect(pointer).toMatchObject({
      schemaVersion: 1,
      runId: "run-42",
      runDir: "runs/run-42",
      command: "review",
      pr: { owner: "org", repo: "repo", number: 7 },
    });
  });

  it("returns null when there is no pointer file", async () => {
    expect(await readLatestRunPointer(dir)).toBeNull();
  });

  it("returns null (not a throw) on a corrupt or shapeless pointer", async () => {
    await mkdir(join(dir, ".ai-review"), { recursive: true });
    await writeFile(join(dir, ".ai-review", "latest.json"), "{not json", "utf8");
    expect(await readLatestRunPointer(dir)).toBeNull();
    await writeFile(join(dir, ".ai-review", "latest.json"), JSON.stringify({ foo: 1 }), "utf8");
    expect(await readLatestRunPointer(dir)).toBeNull();
  });

  it("a second write supersedes the first (the pointer always names the latest run)", async () => {
    const base = {
      baseDir: dir,
      command: "review",
      pr: { owner: "org", repo: "repo", number: 7 },
      prUrl: "https://github.com/org/repo/pull/7",
    };
    await writeLatestRunPointer({ ...base, runId: "run-1" });
    await writeLatestRunPointer({ ...base, runId: "run-2" });
    expect((await readLatestRunPointer(dir))?.runId).toBe("run-2");
  });
});
