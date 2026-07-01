/**
 * Library barrel — re-exports the public/testable surface. The CLI entry point
 * (`cli/index.ts`) is intentionally NOT re-exported here so importing this
 * module never triggers CLI execution.
 */
export { parsePrUrl } from "./github/parsePrUrl.js";
export type { ParsedPr } from "./github/parsePrUrl.js";

export {
  loadConfig,
  mergeConfig,
  deepMerge,
  CONFIG_FILENAME,
} from "./config/loadConfig.js";
export type { LoadedConfig } from "./config/loadConfig.js";
export { defaultConfig } from "./config/defaultConfig.js";
export { ConfigSchema } from "./config/schema.js";
export type { Config } from "./config/types.js";

export {
  getArtifactPaths,
  ARTIFACT_ROOT_DIRNAME,
} from "./storage/artifactPaths.js";
export type { ArtifactPaths } from "./storage/artifactPaths.js";
export { writeTextArtifact, writeJsonArtifact } from "./storage/writeArtifact.js";

export { buildRunMetadata } from "./runMetadata.js";
export type { RunMetadata, CommandName } from "./runMetadata.js";

export { runReview } from "./cli/commands/review.js";
export type { ReviewOptions } from "./cli/commands/review.js";

export { CliError, PrUrlError, ConfigError } from "./errors.js";
