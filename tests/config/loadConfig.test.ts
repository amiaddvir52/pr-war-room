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
    expect(merged.skeptic).toEqual(defaultConfig.skeptic);
  });

  it("replaces verification.commands entirely", () => {
    const merged = mergeConfig(defaultConfig, { verification: { commands: ["pytest"] } });
    expect(merged.verification.commands).toEqual(["pytest"]);
  });

  it("applies the dedup defaults when no dedup override is given", () => {
    const merged = mergeConfig(defaultConfig, {});
    expect(merged.dedup).toEqual(defaultConfig.dedup);
    expect(merged.dedup.llm.enabled).toBe(false);
  });

  it("deep-merges a partial dedup override, keeping sibling defaults", () => {
    const merged = mergeConfig(defaultConfig, {
      dedup: { mergeThreshold: 0.8, llm: { enabled: true } },
    });
    expect(merged.dedup.mergeThreshold).toBe(0.8);
    expect(merged.dedup.candidateThreshold).toBe(defaultConfig.dedup.candidateThreshold);
    expect(merged.dedup.llm.enabled).toBe(true);
    expect(merged.dedup.llm.backend).toBe("claude"); // sibling default preserved
  });

  it("overrides the judge backend and leaves the reviewer roster intact", () => {
    const merged = mergeConfig(defaultConfig, { judge: { backend: "codex" } });
    expect(merged.judge.backend).toBe("codex");
    expect(merged.judge.enabled).toBe(true); // sibling default preserved
    expect(merged.agents.reviewers).toEqual(defaultConfig.agents.reviewers);
  });

  it("applies the judge defaults when no judge override is given", () => {
    const merged = mergeConfig(defaultConfig, {});
    expect(merged.judge).toEqual(defaultConfig.judge);
    expect(merged.judge.enabled).toBe(true);
    expect(merged.judge.backend).toBe("claude");
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
    { dedup: { mergeThreshold: 2 } }, // must be within [0, 1]
    { dedup: { llm: { enabled: "yes" } } }, // must be a boolean
    { reviews: {} }, // unknown top-level key (strict)
    { agents: { concurrency: 0 } }, // must be a positive int
    { agents: { minUsableReviewers: 0 } }, // must be a positive int
    { agents: { reviewers: [{ name: "bad name!", backend: "mock" }] } }, // name not fs-safe
    { agents: { reviewers: [{ name: "x", backend: "nope" }] } }, // unknown backend
    // exact-duplicate reviewer names collide on artifacts + finding ids
    {
      agents: {
        reviewers: [
          { name: "dup", backend: "mock" },
          { name: "dup", backend: "mock" },
        ],
      },
    },
    // case-only-duplicate names collide on case-insensitive filesystems
    {
      agents: {
        reviewers: [
          { name: "Dup", backend: "mock" },
          { name: "dup", backend: "mock" },
        ],
      },
    },
    { models: { primaryReviewer: "mock" } }, // stale pre-Phase-6 key
    { models: { secondaryReviewer: "codex" } }, // stale pre-Phase-6 key
    { models: { judge: "codex" } }, // stale pre-Phase-9 key (moved to judge.backend)
    { judge: { backend: "nope" } }, // unknown backend
    { judge: { concurrency: 0 } }, // must be a positive int
    { judge: { enabled: "yes" } }, // must be a boolean
  ])("throws ConfigError for an invalid override (%j)", (override) => {
    expect(() => mergeConfig(defaultConfig, override)).toThrow(ConfigError);
  });

  it("rejects duplicate reviewer names with a name-focused message (case-insensitive)", () => {
    expect(() =>
      mergeConfig(defaultConfig, {
        agents: {
          reviewers: [
            { name: "Reviewer", backend: "mock" },
            { name: "reviewer", backend: "mock" },
          ],
        },
      }),
    ).toThrow(/duplicate reviewer name/i);
  });

  it("rejects stale models.primaryReviewer/secondaryReviewer, pointing to agents.reviewers", () => {
    // Regression for the silent-strip bug: an upgraded config with the old keys
    // must fail loudly (not silently drop them and swap the reviewer backend).
    let message = "";
    try {
      mergeConfig(defaultConfig, { models: { primaryReviewer: "mock", secondaryReviewer: "codex" } });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/agents\.reviewers/);
    // And it is a hard error, not a silent success that dropped the keys.
    expect(() =>
      mergeConfig(defaultConfig, { models: { primaryReviewer: "mock" } }),
    ).toThrow(ConfigError);
  });

  it("rejects the stale models.judge key, pointing to judge.backend (Phase 9 migration)", () => {
    // models.judge moved to judge.backend; an upgraded config must fail loudly
    // rather than silently ignore it and keep the default judge backend.
    let message = "";
    try {
      mergeConfig(defaultConfig, { models: { judge: "codex" } });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/judge\.backend/);
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
