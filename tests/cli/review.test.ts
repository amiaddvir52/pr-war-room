import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../../src/cli/commands/review.js";
import { PrUrlError } from "../../src/errors.js";
import { CONFIG_FILENAME } from "../../src/config/loadConfig.js";

const silent = (): void => {};

async function readMetadata(dir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(dir, ".ai-review", "run_metadata.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("runReview (integration)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-review-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes run_metadata.json with the parsed PR and default config", async () => {
    await runReview("https://github.com/org/repo/pull/123", {
      version: "0.1.0",
      cwd: dir,
      log: silent,
    });
    const meta = await readMetadata(dir);
    expect(meta["pr"]).toEqual({ owner: "org", repo: "repo", number: 123 });
    expect(meta["configSource"]).toBe("default");
    expect(meta["phase"]).toBe(1);
    expect((meta["config"] as { review: { maxFindings: number } }).review.maxFindings).toBe(20);
  });

  it("reflects a user config override", async () => {
    await writeFile(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ review: { maxFindings: 5 } }),
      "utf8",
    );
    await runReview("https://github.com/org/repo/pull/1", {
      version: "0.1.0",
      cwd: dir,
      log: silent,
    });
    const meta = await readMetadata(dir);
    expect(meta["configSource"]).toBe("file");
    expect((meta["config"] as { review: { maxFindings: number } }).review.maxFindings).toBe(5);
  });

  it("rejects an invalid URL and writes no artifact", async () => {
    await expect(
      runReview("not-a-url", { version: "0.1.0", cwd: dir, log: silent }),
    ).rejects.toThrow(PrUrlError);
    await expect(stat(join(dir, ".ai-review"))).rejects.toThrow();
  });
});
