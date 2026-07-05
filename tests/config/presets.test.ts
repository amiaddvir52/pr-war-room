import { describe, it, expect } from "vitest";
import { mergeConfig } from "../../src/config/loadConfig.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { PRESET_ROSTERS, STANDARD_ROSTER } from "../../src/config/presets.js";
import { ConfigError } from "../../src/errors.js";

/**
 * Preset resolution semantics (config/presets.ts + mergeConfig):
 *   - neither preset nor reviewers → default standard roster
 *   - preset only → that preset's roster
 *   - reviewers only → exact replacement (legacy behavior, unchanged)
 *   - both → preset base, user entries override by name or append
 */

const STANDARD_NAMES = [
  "claude_general_reviewer",
  "codex_general_reviewer",
  "claude_test_gap_reviewer",
  "claude_correctness_reviewer",
  "claude_repo_pattern_reviewer",
  "claude_security_reviewer",
  "claude_performance_reviewer",
  "claude_product_intent_reviewer",
];

describe("preset resolution in mergeConfig", () => {
  it("defaults to the standard 8-agent roster when neither preset nor reviewers is set", () => {
    const merged = mergeConfig(defaultConfig, {});
    expect(merged.agents.reviewers.map((r) => r.name)).toEqual(STANDARD_NAMES);
    expect(merged.agents.reviewers).toEqual(defaultConfig.agents.reviewers);
    expect(merged.agents.preset).toBeUndefined();
  });

  it("expands `preset` alone into that preset's roster and records the preset", () => {
    const fast = mergeConfig(defaultConfig, { agents: { preset: "fast" } });
    expect(fast.agents.preset).toBe("fast");
    expect(fast.agents.reviewers.map((r) => r.name)).toEqual([
      "claude_general_reviewer",
      "codex_general_reviewer",
      "claude_correctness_reviewer",
    ]);

    const deep = mergeConfig(defaultConfig, { agents: { preset: "deep" } });
    expect(deep.agents.reviewers).toHaveLength(10);
    expect(deep.agents.reviewers.map((r) => r.name)).toEqual([
      ...STANDARD_NAMES,
      "codex_correctness_reviewer",
      "codex_security_reviewer",
    ]);

    // demo is a pinned copy of the 8-angle roster.
    const demo = mergeConfig(defaultConfig, { agents: { preset: "demo" } });
    expect(demo.agents.reviewers.map((r) => r.name)).toEqual(STANDARD_NAMES);
  });

  it("keeps legacy semantics: `reviewers` alone replaces the roster exactly, no preset", () => {
    const merged = mergeConfig(defaultConfig, {
      agents: { reviewers: [{ name: "solo", backend: "mock" }] },
    });
    expect(merged.agents.reviewers).toHaveLength(1);
    expect(merged.agents.reviewers[0]?.name).toBe("solo");
    expect(merged.agents.preset).toBeUndefined();
  });

  it("merges a partial entry onto its preset member by name (disable one of eight)", () => {
    const merged = mergeConfig(defaultConfig, {
      agents: {
        preset: "standard",
        reviewers: [{ name: "claude_security_reviewer", enabled: false }],
      },
    });
    expect(merged.agents.reviewers.map((r) => r.name)).toEqual(STANDARD_NAMES);
    const security = merged.agents.reviewers.find((r) => r.name === "claude_security_reviewer");
    // Only `enabled` was overridden; backend/angle inherited from the preset.
    expect(security).toMatchObject({ backend: "claude", angle: "security", enabled: false });
  });

  it("matches preset members case-insensitively (same rule as the uniqueness check)", () => {
    const merged = mergeConfig(defaultConfig, {
      agents: {
        preset: "standard",
        reviewers: [{ name: "CLAUDE_SECURITY_REVIEWER", enabled: false }],
      },
    });
    expect(merged.agents.reviewers).toHaveLength(8);
    // The member keeps its canonical name casing — the name is its artifact
    // filename stem and finding-id prefix, so a case-variant override must not
    // silently rename it.
    expect(merged.agents.reviewers.map((r) => r.name)).toEqual(STANDARD_NAMES);
    const security = merged.agents.reviewers.find((r) => r.name === "claude_security_reviewer");
    expect(security?.enabled).toBe(false);
  });

  it("overrides a preset member's backend while preserving its angle", () => {
    const merged = mergeConfig(defaultConfig, {
      agents: {
        preset: "standard",
        reviewers: [{ name: "claude_correctness_reviewer", backend: "claude-api" }],
      },
    });
    const spec = merged.agents.reviewers.find((r) => r.name === "claude_correctness_reviewer");
    expect(spec).toMatchObject({ backend: "claude-api", angle: "correctness", enabled: true });
  });

  it("appends a fully-specified entry that matches no preset member", () => {
    const merged = mergeConfig(defaultConfig, {
      agents: {
        preset: "standard",
        reviewers: [{ name: "my_extra_reviewer", backend: "mock", angle: "security" }],
      },
    });
    expect(merged.agents.reviewers).toHaveLength(9);
    expect(merged.agents.reviewers.at(-1)).toMatchObject({
      name: "my_extra_reviewer",
      backend: "mock",
      angle: "security",
      enabled: true, // schema default applied to the appended entry
    });
  });

  it("fails loudly when an unmatched entry is partial (typo'd override name)", () => {
    // "claude_securty_reviewer" matches nothing and has no backend/angle, so
    // it can only be a typo'd override — rejected with the entry's index in
    // the USER's array and the preset member names, not a post-merge index.
    const attempt = () =>
      mergeConfig(defaultConfig, {
        agents: {
          preset: "standard",
          reviewers: [{ name: "claude_securty_reviewer", enabled: false }],
        },
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/agents\.reviewers\[0\] \("claude_securty_reviewer"\)/);
    expect(attempt).toThrow(/claude_security_reviewer/);
  });

  it("rejects appending a full-spec entry that is disabled (typo'd disable)", () => {
    // A full spec with a misspelled name would otherwise silently append a
    // ninth agent while the real one stays enabled; `enabled: false` on a NEW
    // agent is a no-op, so it is always a typo'd override — fail loudly.
    const attempt = () =>
      mergeConfig(defaultConfig, {
        agents: {
          preset: "standard",
          reviewers: [
            { name: "claude_securty_reviewer", backend: "claude", angle: "security", enabled: false },
          ],
        },
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/disable a `standard` preset member/);
  });

  it("requires appended new agents to be a full spec — angle included", () => {
    // The schema alone would default a missing `angle` to "general", silently
    // running the wrong persona; the resolver requires it explicitly.
    const attempt = () =>
      mergeConfig(defaultConfig, {
        agents: {
          preset: "standard",
          reviewers: [{ name: "my_security_reviewer", backend: "claude" }],
        },
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/is not a full spec/);
  });

  it("rejects a typo'd field key on an override entry instead of silently ignoring it", () => {
    // Non-strict parsing would strip "enable" and run the reviewer enabled.
    const attempt = () =>
      mergeConfig(defaultConfig, {
        agents: {
          preset: "standard",
          reviewers: [{ name: "claude_security_reviewer", enable: false }],
        },
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/agents\.reviewers\[0\] \("claude_security_reviewer"\)/);
    expect(attempt).toThrow(/'enable'/);
  });

  it("fails loudly when `reviewers` is not an array even though a preset is set", () => {
    // The resolver must not substitute the preset roster for a malformed
    // user value — the schema has to see (and reject) what the user wrote.
    expect(() =>
      mergeConfig(defaultConfig, {
        agents: {
          preset: "standard",
          reviewers: { claude_security_reviewer: { enabled: false } },
        },
      }),
    ).toThrow(/agents\.reviewers/);
  });

  it("rejects a typo'd `preset` key instead of silently running the default roster", () => {
    const attempt = () => mergeConfig(defaultConfig, { agents: { presets: "fast" } });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/presets/);
  });

  it("rejects an unknown preset name via the schema enum (no silent fallback)", () => {
    expect(() => mergeConfig(defaultConfig, { agents: { preset: "fastt" } })).toThrow(ConfigError);
    expect(() => mergeConfig(defaultConfig, { agents: { preset: "fastt" } })).toThrow(/preset/);
  });

  it("rejects duplicate same-name user entries (same rule as the roster uniqueness check)", () => {
    // Without a preset the uniqueness superRefine rejects a duplicated name;
    // silently collapsing it here would make the same mistake fail loudly in
    // one mode and be resolved quietly in the other.
    const attempt = () =>
      mergeConfig(defaultConfig, {
        agents: {
          preset: "standard",
          reviewers: [
            { name: "claude_security_reviewer", enabled: false },
            { name: "claude_security_reviewer", backend: "claude-api" },
          ],
        },
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/duplicate entry for reviewer "claude_security_reviewer"/);
  });

  it("drops a stale preset label when a later layer replaces the roster (layered mergeConfig)", () => {
    // Exported-API layering: the second merge rewrites the roster without a
    // preset, so the "fast" label inherited from the base must not survive
    // into run metadata describing a roster it didn't produce.
    const base = mergeConfig(defaultConfig, { agents: { preset: "fast" } });
    const layered = mergeConfig(base, {
      agents: { reviewers: [{ name: "solo", backend: "mock", angle: "general" }] },
    });
    expect(layered.agents.reviewers.map((r) => r.name)).toEqual(["solo"]);
    expect(layered.agents.preset).toBeUndefined();
    // A layer that does NOT touch the roster keeps the label.
    const untouched = mergeConfig(base, { review: { maxFindings: 5 } });
    expect(untouched.agents.preset).toBe("fast");
    expect(untouched.agents.reviewers).toHaveLength(3);
  });

  it("never mutates the shared preset roster constants", () => {
    mergeConfig(defaultConfig, {
      agents: {
        preset: "standard",
        reviewers: [{ name: "claude_security_reviewer", enabled: false }],
      },
    });
    const pristine = PRESET_ROSTERS.standard.find((r) => r.name === "claude_security_reviewer");
    expect(pristine?.enabled).toBe(true);
    expect(STANDARD_ROSTER).toHaveLength(8);
  });
});
