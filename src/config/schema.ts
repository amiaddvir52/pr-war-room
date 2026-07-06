import { z } from "zod";

/**
 * Configuration schema — the single source of truth for both runtime validation
 * and the inferred `Config` TypeScript type. Later phases follow this same
 * pattern for the Finding / cluster / skeptic / judge schemas.
 */

/** Model backends a reviewer agent can run on (Phase 6). */
export const REVIEWER_BACKENDS = ["claude", "claude-api", "codex", "mock"] as const;
export const ReviewerBackendSchema = z.enum(REVIEWER_BACKENDS);

/**
 * Review "angles" — the persona/focus a reviewer takes (Phase 6). `general` is
 * the broad reviewer; the rest are focused lenses (PRD §10.4). Every angle has
 * a persona in `ANGLE_PROMPTS` (type-enforced); the default `standard` preset
 * enables all of them (see presets.ts).
 */
export const REVIEWER_ANGLES = [
  "general",
  "test-gap",
  "correctness",
  "security",
  "performance",
  "repo-pattern",
  "product-intent",
] as const;
export const ReviewerAngleSchema = z.enum(REVIEWER_ANGLES);

/**
 * Reviewer roster presets. A preset name expands into a concrete
 * `agents.reviewers` roster (see presets.ts) inside `mergeConfig`, BEFORE
 * validation — so the parsed config always carries the resolved roster, and an
 * explicit `agents.reviewers` in the same config overrides preset members by
 * name (or appends new agents).
 */
export const PRESET_NAMES = ["fast", "standard", "deep", "demo"] as const;
export const PresetNameSchema = z.enum(PRESET_NAMES);

/**
 * Canonical identity key for a reviewer name. Names are compared
 * case-insensitively everywhere — the roster uniqueness check below and the
 * preset merge-by-name in presets.ts — because `name` becomes an artifact
 * filename stem, and case-only-distinct names collide on case-insensitive
 * filesystems. One function so the two rules cannot drift.
 */
export function reviewerNameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * One reviewer agent in the multi-agent fan-out (Phase 6). A reviewer is a
 * `backend` × `angle`: the backend picks the model client, the angle picks the
 * prompt persona. `name` must be filesystem-safe — it becomes the artifact
 * filename stem (`raw/<name>_review.md`) and the finding-id prefix (`<name>-001`).
 */
export const AgentSpecSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/, "must be filesystem-safe (letters, digits, '_' or '-')"),
    backend: ReviewerBackendSchema,
    angle: ReviewerAngleSchema.default("general"),
    enabled: z.boolean().default(true),
    // Per-agent timeout override; falls back to `agents.timeoutMs` when unset.
    timeoutMs: z.number().int().positive().optional(),
  })
  // Strict so a typo'd field key (`"enable"`, `"timeout"`) fails loudly instead
  // of being stripped — under preset merge-by-name a silently stripped key
  // would turn an intended override (e.g. a disable) into a no-op.
  .strict();

export const AgentsConfigSchema = z
  .object({
    // Roster preset. Expanded into `reviewers` by `mergeConfig` before this
    // schema runs (config/presets.ts); kept in the parsed config so
    // run_metadata.json records which preset a run used. Unset when the roster
    // was written out explicitly (or is the built-in default).
    preset: PresetNameSchema.optional(),
    // The reviewer roster. Runs in parallel; disabled entries are skipped.
    reviewers: z.array(AgentSpecSchema).default([]),
    // Max reviewers running at once (each may spawn a subprocess / model call).
    // Deliberately below the 10-agent `standard` roster (three waves): each
    // `claude` reviewer is a full CLI subprocess holding the whole packet, and
    // all of them share one account's rate limits — raise to 10 to run the
    // standard roster in a single wave if your machine/limits absorb it.
    concurrency: z.number().int().positive().default(4),
    // Default per-agent timeout in ms (a hung reviewer is recorded, not fatal).
    timeoutMs: z.number().int().positive().default(300_000),
    // The review succeeds only when at least this many reviewers produce *usable*
    // output (findings, or a valid empty result). If fewer do — e.g. every
    // reviewer refused, timed out, or emitted unparseable output — the run fails
    // (non-zero exit) instead of reporting a misleading clean review.
    minUsableReviewers: z.number().int().positive().default(1),
  })
  // Strict so a typo'd key fails loudly: non-strict, `{"presets": "fast"}`
  // would be silently stripped and the run would fall back to the full
  // default roster — the opposite of what the user asked for.
  .strict()
  .superRefine((agents, ctx) => {
    // `name` is the stem of each agent's `raw/<name>_*` artifacts and the prefix
    // of its finding ids, so names must be unique. Compare case-insensitively:
    // case-only-distinct names (`Reviewer` vs `reviewer`) collide on
    // case-insensitive filesystems (macOS, Windows), silently clobbering one
    // agent's artifacts and minting colliding finding ids.
    const seen = new Map<string, string>();
    agents.reviewers.forEach((reviewer, index) => {
      const key = reviewerNameKey(reviewer.name);
      const prior = seen.get(key);
      if (prior !== undefined) {
        const caseNote = prior === reviewer.name ? "" : ` (case-insensitively collides with "${prior}")`;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reviewers", index, "name"],
          message:
            `duplicate reviewer name "${reviewer.name}"${caseNote} — names must be unique; ` +
            "each is the stem of its `raw/<name>_*` artifacts and finding ids",
        });
      } else {
        seen.set(key, reviewer.name);
      }
    });
  });

/**
 * Deprecated `models` block. Every key it ever held has moved to a dedicated,
 * validated home:
 *   - `models.judge` → `judge.backend` (Phase 9)
 *   - `models.primaryReviewer` / `models.secondaryReviewer` → `agents.reviewers`
 *     (Phase 6)
 * It now accepts no keys, so any `models.*` in a config fails loudly with a
 * pointer to the new home rather than being silently ignored (which would have
 * swapped a user's judge/reviewer backend without warning). The block is
 * optional — a config that has already migrated simply omits it.
 */
export const ModelsConfigSchema = z
  .object({})
  .strict(
    "unknown key in `models` — `models.judge` moved to `judge.backend` (Phase 9) and the " +
      "reviewer roster moved to `agents.reviewers` (Phase 6). Configure the judge under `judge` " +
      "and reviewers under `agents.reviewers`, then remove the `models` block.",
  );

export const VerificationConfigSchema = z.object({
  // When non-empty, these run instead of the auto-detected commands (Phase 3).
  commands: z.array(z.string()).default([]),
  // Whether verification commands actually execute. Detection always runs; a
  // false value (the default) means "detect only". The `--verify` CLI flag
  // overrides this to true. Opt-in because running a PR's scripts executes
  // untrusted code locally.
  enabled: z.boolean().default(false),
  // Install dependencies (npm ci / pip install / go mod download) before
  // verification. Ignored when verification does not run.
  installDeps: z.boolean().default(true),
  // Per-command timeout in milliseconds (applies to install and each command).
  timeoutMs: z.number().int().positive().default(600_000),
});

export const ReviewConfigSchema = z.object({
  maxFindings: z.number().int().positive(),
  includeNiceToHave: z.boolean(),
});

export const ContextConfigSchema = z.object({
  // Soft cap on the serialized review packet. When exceeded, the largest file
  // patches are trimmed (Phase 4) and a warning is emitted.
  maxPacketBytes: z.number().int().positive().default(524_288),
  // Lines of surrounding code to include around each changed hunk.
  nearbyContextLines: z.number().int().nonnegative().default(20),
  // Total cap on nearby-context lines emitted per changed file (across all
  // hunks), independent of the per-hunk `nearbyContextLines` window.
  maxNearbyLinesPerFile: z.number().int().positive().default(400),
});

/**
 * Deduplication & clustering (Phase 7). The heuristic core is always on; the
 * thresholds tune it, and `llm` scaffolds the PRD's optional "ask an LLM when
 * heuristic confidence is unclear" adjudicator — OFF by default so runs stay
 * deterministic and free of extra model calls.
 *
 * The thresholds apply to the composite SAME-ISSUE score (title/claim word
 * overlap + shared code symbols + span overlap — see deduplicateFindings.ts),
 * and their defaults were tuned against the TaskFlow demo run's 57 real
 * findings: every cross-root-cause pair there scored ≤ 0.43 while every group
 * of rephrasings of one issue connected at ≥ 0.46.
 */
export const DedupConfigSchema = z
  .object({
    // Same-file findings whose line ranges are within this many lines are merge
    // candidates (0 = require overlap).
    proximityLines: z.number().int().nonnegative().default(10),
    // Same-issue score at/above this triggers a merge of a candidate pair
    // (subject to the complete-linkage guardrail below).
    mergeThreshold: z.number().min(0).max(1).default(0.46),
    // Score in [candidateThreshold, mergeThreshold) is the "gray zone" the
    // LLM adjudicator (when enabled) decides; below it, never merge a pair.
    candidateThreshold: z.number().min(0).max(1).default(0.35),
    // Complete-linkage guardrail (the anti-chaining rule): two clusters may
    // only merge when EVERY cross pair scores at least this. Prevents transitive
    // proximity chains from fusing distinct root causes in a dense file, while
    // still letting a large cluster absorb a tersely-worded duplicate whose
    // pairwise score with some far member is weak. Must be ≤ candidateThreshold.
    minLinkScore: z.number().min(0).max(1).default(0.15),
    llm: z
      .object({
        enabled: z.boolean().default(false),
        backend: ReviewerBackendSchema.default("claude"),
        timeoutMs: z.number().int().positive().default(60_000),
      })
      .default({}),
  })
  // Enforce the threshold ordering the clustering logic assumes. In particular
  // a minLinkScore above mergeThreshold would make `clustersCompatible` refuse
  // even the pair that triggered the merge — dedup would silently degenerate
  // into no clustering at all rather than fail loudly here.
  .superRefine((dedup, ctx) => {
    if (dedup.minLinkScore > dedup.candidateThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minLinkScore"],
        message: `minLinkScore (${dedup.minLinkScore}) must be ≤ candidateThreshold (${dedup.candidateThreshold}) — it is the complete-linkage floor, below the gray zone`,
      });
    }
    if (dedup.candidateThreshold > dedup.mergeThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidateThreshold"],
        message: `candidateThreshold (${dedup.candidateThreshold}) must be ≤ mergeThreshold (${dedup.mergeThreshold}) — the gray zone sits below the auto-merge bar`,
      });
    }
  })
  .default({});

/**
 * Skeptic / evidence validation (Phase 8, PRD §10.7). Unlike the dedup
 * adjudicator, the skeptic is ON by default — it is the product's precision
 * gate, and it runs on the same `claude` backend as the reviewers. Deterministic
 * file/line/diff checks always run inside the phase; the LLM skeptic runs unless
 * the backend is `mock` (which validates deterministically for offline runs).
 */
export const SkepticConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    backend: ReviewerBackendSchema.default("claude"),
    // Max clusters validated at once (each may spawn a subprocess / model call).
    concurrency: z.number().int().positive().default(4),
    // BASE per-cluster timeout in ms; the effective budget scales up with
    // cluster size (see agents/clusterTimeout.ts), capped at 3× this value.
    // A skeptic that still hangs is recorded and the finding is kept
    // (recall-first), never dropped on an infra hiccup. 120s (up from 60s):
    // demo runs hit 60s and even 90s on ordinary singleton clusters.
    timeoutMs: z.number().int().positive().default(120_000),
  })
  .default({});

/**
 * Judge / LLM-as-a-judge ranking (Phase 9, PRD §10.8). Mirrors the skeptic: ON
 * by default (the ranker that produces the report input), on the same `claude`
 * backend as the reviewers. A `mock` backend ranks deterministically from
 * severity/support/agreement with no model call (offline / CI / demo). The
 * `backend` field replaces the old free-string `models.judge`.
 */
export const JudgeConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    backend: ReviewerBackendSchema.default("claude"),
    // Max clusters ranked at once (each may spawn a subprocess / model call).
    concurrency: z.number().int().positive().default(4),
    // BASE per-cluster timeout in ms; the effective budget scales up with
    // cluster size (see agents/clusterTimeout.ts), capped at 3× this value.
    // A judge that still hangs is recorded and the finding is classified
    // deterministically and kept (recall-first), never dropped.
    timeoutMs: z.number().int().positive().default(90_000),
  })
  .default({});

/**
 * Fix mode (Phase 11, PRD §10.10). No `enabled` key: running `pr-war-room fix`
 * is explicit intent, and a config that turns an explicit command into a no-op
 * is a footgun. The fix agent runs one model call per selected finding.
 */
export const FixConfigSchema = z
  .object({
    backend: ReviewerBackendSchema.default("claude"),
    // Per-finding timeout in ms. Patch generation reads a whole file and writes
    // edits, so this is deliberately above the skeptic/judge verdict timeouts.
    timeoutMs: z.number().int().positive().default(120_000),
    // Cap on findings attempted per run, taken from the head of
    // final_findings.json (already sorted blocker-first, score-descending).
    maxFindings: z.number().int().positive().default(5),
  })
  // Strict so a typo'd key (`maxFindngs`) fails loudly instead of silently
  // falling back to the default cap (FOLLOWUPS #8).
  .strict()
  .default({});

/**
 * CI options are pre-declared (optional/inert) so a config can already set them
 * and Phase 15 can activate them without breaking existing configs.
 */
export const CiConfigSchema = z
  .object({
    failOnBlocker: z.boolean(),
    publishSummary: z.boolean(),
  })
  .partial();

export const ConfigSchema = z
  .object({
    agents: AgentsConfigSchema,
    // Deprecated (see `ModelsConfigSchema`): optional so a migrated config omits
    // it, but any `models.*` key still fails loudly with a pointer to its new home.
    models: ModelsConfigSchema.optional(),
    verification: VerificationConfigSchema,
    review: ReviewConfigSchema,
    context: ContextConfigSchema.default({}),
    dedup: DedupConfigSchema,
    skeptic: SkepticConfigSchema,
    judge: JudgeConfigSchema,
    fix: FixConfigSchema,
    ci: CiConfigSchema.optional(),
  })
  // Reject unknown top-level keys so typos in a user config fail loudly.
  .strict();

export type ReviewerBackend = z.infer<typeof ReviewerBackendSchema>;
export type ReviewerAngle = z.infer<typeof ReviewerAngleSchema>;
export type PresetName = z.infer<typeof PresetNameSchema>;
export type AgentSpec = z.infer<typeof AgentSpecSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type ContextConfig = z.infer<typeof ContextConfigSchema>;
export type DedupConfig = z.infer<typeof DedupConfigSchema>;
export type SkepticConfig = z.infer<typeof SkepticConfigSchema>;
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;
export type FixConfig = z.infer<typeof FixConfigSchema>;
export type CiConfig = z.infer<typeof CiConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
