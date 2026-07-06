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
export type {
  Config,
  AgentsConfig,
  AgentSpec,
  ReviewerBackend,
  ReviewerAngle,
  DedupConfig,
} from "./config/types.js";

export {
  getArtifactPaths,
  getSharedPaths,
  ARTIFACT_ROOT_DIRNAME,
} from "./storage/artifactPaths.js";
export type { ArtifactPaths, SharedArtifactPaths } from "./storage/artifactPaths.js";
export {
  newRunId,
  readLatestRunPointer,
  writeLatestRunPointer,
} from "./storage/latestRun.js";
export type { LatestRunPointer } from "./storage/latestRun.js";
export { writeTextArtifact, writeJsonArtifact } from "./storage/writeArtifact.js";

export { buildRunMetadata } from "./runMetadata.js";
export type { RunMetadata, CommandName } from "./runMetadata.js";

export { runReview } from "./cli/commands/review.js";
export type { ReviewOptions, PrepareWorkspaceFn, BuildReviewPacketFn } from "./cli/commands/review.js";

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
export type { ReporterOptions, Spinner, Board, BoardItem, BoardStatus } from "./ui/reporter.js";
export { selectBanner } from "./ui/banner.js";

// Phase 5 — findings schema + single reviewer
export {
  FindingSchema,
  FindingCoreSchema,
  FindingClusterSchema,
  ReviewerResponseSchema,
  REVIEWER_OUTPUT_JSON_SCHEMA,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
} from "./findings/schema.js";
export type {
  Finding,
  FindingCore,
  FindingCluster,
  FindingCategory,
  FindingSeverity,
} from "./findings/schema.js";
export { partitionFindings, SEVERITY_RANK } from "./findings/validateFinding.js";
export type { PartitionResult, DroppedFinding } from "./findings/validateFinding.js";
export { normalizeFindings } from "./findings/normalizeFindings.js";

// Phase 6 — multi-agent reviewer fan-out
export { runReviewers, isUsable } from "./agents/runReviewers.js";
export type {
  RunReviewers,
  RunReviewersInput,
  RunReviewersResult,
  AgentRun,
  AgentStatus,
} from "./agents/runReviewers.js";
export { Reviewer } from "./agents/Reviewer.js";
export { MockReviewer } from "./agents/MockReviewer.js";
export { createModelClient } from "./agents/modelClient.js";
export type { ModelClientOptions } from "./agents/modelClient.js";
export { createAnthropicModelClient, REVIEWER_MODEL } from "./agents/anthropicClient.js";
export { createClaudeCliModelClient } from "./agents/claudeCli.js";
export type { ClaudeCliOptions } from "./agents/claudeCli.js";
export { createCodexCliModelClient } from "./agents/codexCli.js";
export type { CodexCliOptions } from "./agents/codexCli.js";
export { spawnCliRunner } from "./agents/cliRunner.js";
export type { CliRunner, CliExecResult } from "./agents/cliRunner.js";
export type {
  ReviewerAgent,
  ReviewerInput,
  RawAgentResult,
  ModelClient,
  ModelRequest,
  ModelResult,
} from "./agents/types.js";

// Phase 7 — deduplication & clustering
export {
  deduplicateFindings,
  clusterFindings,
  mergeCluster,
  findingSimilarity,
  extractSymbols,
  SAME_ISSUE_WEIGHTS,
} from "./findings/deduplicateFindings.js";
export type {
  Adjudicator,
  ClusteringResult,
  DedupResult,
  DedupStats,
} from "./findings/deduplicateFindings.js";
export { createDedupAdjudicator } from "./agents/DedupAdjudicator.js";

export {
  CliError,
  PrUrlError,
  ConfigError,
  GitHubError,
  WorkspaceError,
  ReviewerError,
  ReviewerTimeoutError,
} from "./errors.js";
