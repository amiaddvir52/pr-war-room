import type { ParsedPr } from "./parsePrUrl.js";
import type { Reporter } from "../ui/reporter.js";
import type { PrMetadata, ChangedFilesArtifact } from "./schema.js";
import { resolveGitHubToken } from "./auth.js";
import { createGitHubClient } from "./client.js";
import { fetchPrMetadata } from "./fetchPrMetadata.js";
import { fetchChangedFiles } from "./fetchChangedFiles.js";
import { fetchPrDiff } from "./fetchPrDiff.js";

export interface IngestResult {
  metadata: PrMetadata;
  changedFiles: ChangedFilesArtifact;
  /** Raw unified diff, or `null` when GitHub could not generate it (too large). */
  diff: string | null;
}

export interface IngestContext {
  version: string;
  reporter: Reporter;
  /** Injected in tests. Defaults to `process.env` inside the resolver. */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests to avoid the network. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export type IngestPullRequest = (pr: ParsedPr, ctx: IngestContext) => Promise<IngestResult>;

/**
 * High-level GitHub ingestion: resolve auth, then fetch metadata, changed
 * files, and the diff concurrently. This is the single seam `runReview`
 * depends on — tests inject a fake in its place instead of touching the network.
 */
export const ingestPullRequest: IngestPullRequest = async (pr, ctx) => {
  const { token } = await resolveGitHubToken(ctx.env ?? process.env);
  const client = createGitHubClient({
    token,
    version: ctx.version,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });

  const [metadata, changedFiles, diff] = await Promise.all([
    fetchPrMetadata(client, pr),
    fetchChangedFiles(client, pr),
    fetchPrDiff(client, pr),
  ]);

  if (changedFiles.truncated) {
    ctx.reporter.warn(
      `Changed-file list truncated at ${changedFiles.totalCount} files (GitHub API cap).`,
    );
  }
  if (diff === null) {
    ctx.reporter.warn(
      "PR diff was too large to fetch; relying on per-file patches in changed_files.json.",
    );
  }

  return { metadata, changedFiles, diff };
};
