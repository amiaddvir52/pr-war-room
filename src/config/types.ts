/**
 * Public type import surface. Import config types from here so callers don't
 * depend on zod internals.
 */
export type {
  Config,
  ModelsConfig,
  VerificationConfig,
  ReviewConfig,
  CiConfig,
} from "./schema.js";
