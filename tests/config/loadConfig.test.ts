import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeConfig,
  deepMerge,
  loadConfig,
  CONFIG_FILENAME,
} from "../../src/config/loadConfig.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { ConfigError } from "../../src/errors.js";

describe("deepMerge", () => {
  it("merges nested objects and leaves siblings intact", () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    expect(deepMerge(base, { a: { y: 9 } })).toEqual({ a: { x: 1, y: 9 }, b: 3 });
  });

  it("replaces arrays rather than concatenating", () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  it("does not mutate the base object", () => {
    const base = { a: { x: 1 } };
    deepMerge(base, { a: { x: 2 } });
    expect(base).toEqual({ a: { x: 1 } });
  });
});

describe("mergeConfig", () => {
  it("returns defaults when the override is empty", () => {
    expect(mergeConfig(defaultConfig, {})).toEqual(defaultConfig);
  });

  it("applies a partial nested override and keeps sibling defaults", () => {
    const merged = mergeConfig(defaultConfig, { review: { maxFindings: 5 } });
    expect(merged.review.maxFindings).toBe(5);
    expect(merged.review.includeNiceToHave).toBe(false);
    expect(merged.models).toEqual(defaultConfig.models);
  });

  it("replaces verification.commands entirely", () => {
    const merged = mergeConfig(defaultConfig, { verification: { commands: ["pytest"] } });
    expect(merged.verification.commands).toEqual(["pytest"]);
  });

  it("overrides the judge and leaves the reviewer roster intact", () => {
    const merged = mergeConfig(defaultConfig, { models: { judge: "codex" } });
    expect(merged.models.judge).toBe("codex");
    expect(merged.agents.reviewers).toEqual(defaultConfig.agents.reviewers);
  });

  it("replaces agents.reviewers entirely, applying per-agent defaults, keeping siblings", () => {
    const merged = mergeConfig(defaultConfig, {
      agents: { reviewers: [{ name: "solo", backend: "mock" }] },
    });
    expect(merged.agents.reviewers).toHaveLength(1);
    // angle/enabled default in via the schema.
    expect(merged.agents.reviewers[0]).toMatchObject({
      name: "solo",
      backend: "mock",
      angle: "general",
      enabled: true,
    });
    expect(merged.agents.concurrency).toBe(defaultConfig.agents.concurrency);
  });

  it.each([
    { review: { maxFindings: -1 } },
    { review: { includeNiceToHave: "yes" } },
    { reviews: {} }, // unknown top-level key (strict)
    { agents: { concurrency: 0 } }, // must be a positive int
    { agents: { reviewers: [{ name: "bad name!", backend: "mock" }] } }, // name not fs-safe
    { agents: { reviewers: [{ name: "x", backend: "nope" }] } }, // unknown backend
  ])("throws ConfigError for an invalid override (%j)", (override) => {
    expect(() => mergeConfig(defaultConfig, override)).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-config-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", async () => {
    const result = await loadConfig(dir);
    expect(result.source).toBe("default");
    expect(result.path).toBeNull();
    expect(result.config).toEqual(defaultConfig);
  });

  it("merges a present config file over defaults", async () => {
    await writeFile(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ review: { maxFindings: 3 } }),
      "utf8",
    );
    const result = await loadConfig(dir);
    expect(result.source).toBe("file");
    expect(result.path).toBe(join(dir, CONFIG_FILENAME));
    expect(result.config.review.maxFindings).toBe(3);
    expect(result.config.review.includeNiceToHave).toBe(false);
  });

  it("throws ConfigError on malformed JSON", async () => {
    await writeFile(join(dir, CONFIG_FILENAME), "{ not json", "utf8");
    await expect(loadConfig(dir)).rejects.toThrow(ConfigError);
  });
});
