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
    minUsableReviewers: 1,
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
  // Phase 7 — deduplication. Heuristic clustering is always on; the LLM
  // adjudicator is off by default so runs stay deterministic and call-free.
  dedup: {
    proximityLines: 10,
    mergeThreshold: 0.6,
    candidateThreshold: 0.4,
    llm: {
      enabled: false,
      backend: "claude",
      timeoutMs: 60_000,
    },
  },
  // Phase 8 — skeptic / evidence validation. ON by default (the precision gate);
  // deterministic checks always run, the LLM skeptic runs on `claude` unless the
  // backend is `mock`.
  skeptic: {
    enabled: true,
    backend: "claude",
    concurrency: 4,
    timeoutMs: 60_000,
  },
  // Phase 9 — LLM-as-a-judge ranking. ON by default (produces the report input),
  // on `claude` unless the backend is `mock` (which ranks deterministically).
  judge: {
    enabled: true,
    backend: "claude",
    concurrency: 4,
    timeoutMs: 60_000,
  },
};
