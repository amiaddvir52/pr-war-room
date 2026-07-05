import { cloneRoster, STANDARD_ROSTER } from "./presets.js";
import type { Config } from "./types.js";

/**
 * Default configuration. Type-annotated as `Config` so it is guaranteed to be
 * schema-complete at compile time.
 */
export const defaultConfig: Config = {
  // Phase 6 — the multi-agent reviewer roster (PRD §10.4). The default is the
  // `standard` preset: all eight review angles — seven Claude-backed lenses
  // (general, test-gap, correctness, repo-pattern, security, performance,
  // product-intent) — plus three independent cross-vendor Codex reviewers
  // (general, correctness, security), ten agents total. The Claude agents
  // work with just `claude login`; the Codex agents are enabled by default
  // but only *run* when a usable `codex` CLI is detected (otherwise each is
  // reported as skipped, never a silent omission — see
  // backendAvailability.ts). Set `agents.preset` to "fast" / "standard" /
  // "deep" / "demo" to pick a different roster, or list `agents.reviewers` to
  // replace or (with a preset) override it by name — see config/presets.ts.
  // `preset` is deliberately unset here so a run's metadata only records a
  // preset the user actually chose.
  agents: {
    reviewers: cloneRoster(STANDARD_ROSTER),
    // Three waves for the 10-agent roster — see the schema comment for why
    // this stays below the roster size (subprocess memory + shared rate limits).
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
