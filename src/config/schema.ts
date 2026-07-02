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
 * the broad reviewer; the rest are focused lenses (PRD §10.4). `security` and
 * `performance` are supported but not enabled by default.
 */
export const REVIEWER_ANGLES = [
  "general",
  "test-gap",
  "correctness",
  "security",
  "performance",
] as const;
export const ReviewerAngleSchema = z.enum(REVIEWER_ANGLES);

/**
 * One reviewer agent in the multi-agent fan-out (Phase 6). A reviewer is a
 * `backend` × `angle`: the backend picks the model client, the angle picks the
 * prompt persona. `name` must be filesystem-safe — it becomes the artifact
 * filename stem (`raw/<name>_review.md`) and the finding-id prefix (`<name>-001`).
 */
export const AgentSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/, "must be filesystem-safe (letters, digits, '_' or '-')"),
  backend: ReviewerBackendSchema,
  angle: ReviewerAngleSchema.default("general"),
  enabled: z.boolean().default(true),
  // Per-agent timeout override; falls back to `agents.timeoutMs` when unset.
  timeoutMs: z.number().int().positive().optional(),
});

export const AgentsConfigSchema = z.object({
  // The reviewer roster. Runs in parallel; disabled entries are skipped.
  reviewers: z.array(AgentSpecSchema).default([]),
  // Max reviewers running at once (each may spawn a subprocess / model call).
  concurrency: z.number().int().positive().default(4),
  // Default per-agent timeout in ms (a hung reviewer is recorded, not fatal).
  timeoutMs: z.number().int().positive().default(300_000),
});

export const ModelsConfigSchema = z.object({
  // The reviewer roster moved to `agents.reviewers` (Phase 6). `judge` stays a
  // free string here for the Phase 9 LLM-as-a-judge step.
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
    agents: AgentsConfigSchema,
    models: ModelsConfigSchema,
    verification: VerificationConfigSchema,
    review: ReviewConfigSchema,
    context: ContextConfigSchema.default({}),
    ci: CiConfigSchema.optional(),
  })
  // Reject unknown top-level keys so typos in a user config fail loudly.
  .strict();

export type ReviewerBackend = z.infer<typeof ReviewerBackendSchema>;
export type ReviewerAngle = z.infer<typeof ReviewerAngleSchema>;
export type AgentSpec = z.infer<typeof AgentSpecSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;
export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type ContextConfig = z.infer<typeof ContextConfigSchema>;
export type CiConfig = z.infer<typeof CiConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
