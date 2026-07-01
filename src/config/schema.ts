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
  commands: z.array(z.string()),
});

export const ReviewConfigSchema = z.object({
  maxFindings: z.number().int().positive(),
  includeNiceToHave: z.boolean(),
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
    ci: CiConfigSchema.optional(),
  })
  // Reject unknown top-level keys so typos in a user config fail loudly.
  .strict();

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type CiConfig = z.infer<typeof CiConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
