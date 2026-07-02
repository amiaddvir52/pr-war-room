import type { Config } from "./types.js";

/**
 * Default configuration. Type-annotated as `Config` so it is guaranteed to be
 * schema-complete at compile time.
 */
export const defaultConfig: Config = {
  // Phase 6 — the multi-agent reviewer roster. Three Claude-backed angles run
  // in parallel by default, so `review` works with just `claude login`. Add a
  // `codex`-backed agent (opt-in) for cross-model independence; `security` and
  // `performance` are supported angles you can enable here too.
  agents: {
    reviewers: [
      { name: "claude_general_reviewer", backend: "claude", angle: "general", enabled: true },
      { name: "claude_test_gap_reviewer", backend: "claude", angle: "test-gap", enabled: true },
      {
        name: "claude_correctness_reviewer",
        backend: "claude",
        angle: "correctness",
        enabled: true,
      },
    ],
    concurrency: 4,
    timeoutMs: 300_000,
  },
  models: {
    judge: "claude",
  },
  verification: {
    // Empty by default so Phase 3's detection drives which commands run; set
    // commands here to override detection. `enabled: false` means detect-only —
    // pass `--verify` (or set `enabled: true`) to actually execute them.
    commands: [],
    enabled: false,
    installDeps: true,
    timeoutMs: 600_000,
  },
  review: {
    maxFindings: 20,
    includeNiceToHave: false,
  },
  context: {
    maxPacketBytes: 524_288,
    nearbyContextLines: 20,
    maxNearbyLinesPerFile: 400,
  },
};
