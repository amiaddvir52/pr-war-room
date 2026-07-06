import { cloneRoster, STANDARD_ROSTER } from "./presets.js";
import type { Config } from "./types.js";

/**
 * Default configuration. Type-annotated as `Config` so it is guaranteed to be
 * schema-complete at compile time.
 */
export const defaultConfig: Config = {
  // Phase 6 — the multi-agent reviewer roster (PRD §10.4): the `standard`
  // preset. Composition, rationale, and the Codex detection-gating semantics
  // are documented once, on STANDARD_ROSTER in config/presets.ts. Set
  // `agents.preset` to "fast" / "standard" / "deep" / "demo" to pick a
  // different roster, or list `agents.reviewers` to replace or (with a
  // preset) override it by name. `preset` is deliberately unset here so a
  // run's metadata only records a preset the user actually chose.
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
  // Phase 7 — deduplication. Heuristic same-issue clustering is always on; the
  // LLM adjudicator is off by default so runs stay deterministic and call-free.
  // Threshold rationale lives on DedupConfigSchema (tuned against the TaskFlow
  // demo run's 57 real findings).
  dedup: {
    proximityLines: 10,
    mergeThreshold: 0.46,
    candidateThreshold: 0.35,
    minLinkScore: 0.15,
    llm: {
      enabled: false,
      backend: "claude",
      timeoutMs: 60_000,
    },
  },
  // Phase 8 — skeptic / evidence validation. ON by default (the precision gate);
  // deterministic checks always run, the LLM skeptic runs on `claude` unless the
  // backend is `mock`. timeoutMs is the BASE per-cluster budget; big clusters
  // scale up to 3× (agents/clusterTimeout.ts).
  skeptic: {
    enabled: true,
    backend: "claude",
    concurrency: 4,
    timeoutMs: 120_000,
  },
  // Phase 9 — LLM-as-a-judge ranking. ON by default (produces the report input),
  // on `claude` unless the backend is `mock` (which ranks deterministically).
  // timeoutMs scales with cluster size like the skeptic's.
  judge: {
    enabled: true,
    backend: "claude",
    concurrency: 4,
    timeoutMs: 90_000,
  },
  // Phase 11 — fix mode. One model call per selected finding; the cap takes
  // the highest-priority findings first. No `enabled` key — running `fix` is
  // explicit intent.
  fix: {
    backend: "claude",
    timeoutMs: 120_000,
    maxFindings: 5,
  },
};
