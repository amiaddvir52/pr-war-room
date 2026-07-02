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
  ModelsConfig,
  VerificationConfig,
  ReviewConfig,
  ContextConfig,
  DedupConfig,
  CiConfig,
} from "./schema.js";
