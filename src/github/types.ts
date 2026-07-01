/**
 * Public type import surface for GitHub ingestion. Import these types from here
 * so callers don't reach into zod internals (mirrors `config/types.ts`).
 */
export type {
  PrMetadata,
  ChangedFile,
  ChangedFilesArtifact,
  PrState,
  FileStatus,
  GitHubPullResponse,
  GitHubFile,
} from "./schema.js";

export type {
  IngestResult,
  IngestContext,
  IngestPullRequest,
} from "./ingestPullRequest.js";

export type { ResolvedToken, TokenSource } from "./auth.js";
export type { GitHubClient, GitHubClientOptions, GitHubRawResult } from "./client.js";
