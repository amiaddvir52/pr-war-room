import { z } from "zod";

/**
 * Configuration schema — the single source of truth for both runtime validation
 * and the inferred `Config` TypeScript type. Later phases follow this same
 * pattern for the Finding / cluster / skeptic / judge schemas.
 */

export const ModelsConfigSchema = z.object({
  // Kept as free strings (not z.enum) so later phases can add reviewers like
  // `test_gap_reviewer` without a schema change.
  primaryReviewer: z.string(),
  secondaryReviewer: z.string(),
  judge: z.string(),
});

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
    models: ModelsConfigSchema,
    verification: VerificationConfigSchema,
    review: ReviewConfigSchema,
    context: ContextConfigSchema.default({}),
    ci: CiConfigSchema.optional(),
  })
  // Reject unknown top-level keys so typos in a user config fail loudly.
  .strict();

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type ContextConfig = z.infer<typeof ContextConfigSchema>;
export type CiConfig = z.infer<typeof CiConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
