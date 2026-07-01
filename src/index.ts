/**
 * Library barrel — re-exports the public/testable surface. The CLI entry point
 * (`cli/index.ts`) is intentionally NOT re-exported here so importing this
 * module never triggers CLI execution.
 */
export { parsePrUrl } from "./github/parsePrUrl.js";
export type { ParsedPr } from "./github/parsePrUrl.js";

export { resolveGitHubToken } from "./github/auth.js";
export { createGitHubClient, mapGitHubError } from "./github/client.js";
export { ingestPullRequest } from "./github/ingestPullRequest.js";
export {
  PrMetadataSchema,
  ChangedFileSchema,
  ChangedFilesArtifactSchema,
  toPrMetadata,
  toChangedFile,
} from "./github/schema.js";
export type {
  PrMetadata,
  ChangedFile,
  ChangedFilesArtifact,
  IngestResult,
  IngestContext,
  IngestPullRequest,
  ResolvedToken,
  TokenSource,
  GitHubClient,
} from "./github/types.js";

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
export type { ReviewOptions, PrepareWorkspaceFn } from "./cli/commands/review.js";

// Phase 3 — workspace prep + repo detection
export { prepareWorkspace } from "./workspace/prepareWorkspace.js";
export { prepareRepo } from "./workspace/git.js";
export { runCommand } from "./workspace/runCommand.js";
export type {
  WorkspaceMetadata,
  VerificationResults,
  CommandExecution,
  EnabledSource,
  CommandResult,
  RunCommandOptions,
  CommandRunner,
  GitRunner,
  GitRunResult,
  PrepareRepoInput,
  PreparedRepo,
  PrepareWorkspaceInput,
  WorkspaceResult,
} from "./workspace/types.js";
export {
  detectProjectTypes,
  detectPackageManager,
  PROJECT_TYPES,
  PACKAGE_MANAGERS,
} from "./context/detectProjectType.js";
export { detectVerificationCommands } from "./context/detectVerificationCommands.js";

// Phase 4 — review packet builder
export { buildReviewPacket, renderReviewPacketMarkdown } from "./context/buildReviewPacket.js";
export { collectNearbyContext } from "./context/collectNearbyContext.js";
export { collectRepoConventions } from "./context/collectRepoConventions.js";
export type {
  ProjectType,
  PackageManager,
  DetectedCommands,
  DetectVerificationInput,
  ReviewPacket,
  PacketChangedFile,
  PacketVerification,
  PacketVerificationCommand,
  RepoConventions,
  BuildReviewPacketInput,
  BuildReviewPacketResult,
} from "./context/types.js";

export { Reporter, silentReporter } from "./ui/reporter.js";
export type { ReporterOptions } from "./ui/reporter.js";
export { selectBanner } from "./ui/banner.js";

export { CliError, PrUrlError, ConfigError, GitHubError, WorkspaceError } from "./errors.js";
