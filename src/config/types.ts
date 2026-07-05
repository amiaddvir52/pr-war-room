/**
 * Public type import surface. Import config types from here so callers don't
 * depend on zod internals.
 */
export type {
  Config,
  AgentsConfig,
  AgentSpec,
  ReviewerBackend,
  ReviewerAngle,
  PresetName,
  VerificationConfig,
  ReviewConfig,
  ContextConfig,
  DedupConfig,
  SkepticConfig,
  JudgeConfig,
  CiConfig,
} from "./schema.js";
