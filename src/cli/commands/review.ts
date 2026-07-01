import { relative } from "node:path";
import { parsePrUrl } from "../../github/parsePrUrl.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getArtifactPaths } from "../../storage/artifactPaths.js";
import { writeJsonArtifact, writeTextArtifact } from "../../storage/writeArtifact.js";
import { buildRunMetadata } from "../../runMetadata.js";
import { Reporter } from "../../ui/reporter.js";
import { selectBanner } from "../../ui/banner.js";
import { ingestPullRequest, type IngestPullRequest } from "../../github/ingestPullRequest.js";

export interface ReviewOptions {
  version: string;
  /** Base directory the `.ai-review/` tree is rooted in. Defaults to cwd. */
  cwd?: string;
  /** Output reporter. Defaults to a console reporter; inject a silent one in tests. */
  reporter?: Reporter;
  /** GitHub ingestion. Defaults to the real fetcher; inject a fake in tests to avoid the network. */
  ingest?: IngestPullRequest;
}

/**
 * The `review` command. It parses the PR URL, resolves config, writes
 * `run_metadata.json`, then ingests the PR from GitHub (metadata, changed
 * files, diff). This function is the seam every later phase extends: workspace
 * prep, review packet, agents, dedupe, skeptic, judge, and report generation
 * all append steps here.
 */
export async function runReview(prUrl: string, options: ReviewOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const reporter = options.reporter ?? new Reporter();
  const ingest = options.ingest ?? ingestPullRequest;

  const pr = parsePrUrl(prUrl);
  const { config, source, path } = await loadConfig(cwd);
  const paths = getArtifactPaths(cwd);

  // Written first so the run is recorded even if ingestion later fails.
  const metadata = buildRunMetadata({
    command: "review",
    version: options.version,
    pr,
    prUrl,
    config,
    configSource: source,
    configPath: path,
    cwd,
  });
  await writeJsonArtifact(paths.runMetadata, metadata);

  const summary: ReadonlyArray<readonly [string, string]> = [
    ["PR", `${pr.owner}/${pr.repo}#${pr.number}`],
    ["Config", source === "file" && path ? relative(cwd, path) : "defaults"],
    ["Artifacts", relative(cwd, paths.root)],
  ];

  const art = selectBanner();
  if (art) {
    reporter.logo(art, `v${options.version} · multi-agent AI pre-review`);
  } else {
    reporter.banner("PR War Room", `v${options.version}`);
  }
  reporter.keyValues(summary);
  reporter.blank();
  reporter.step("parsed PR URL");
  reporter.step("loaded config");
  reporter.step(`wrote ${relative(paths.root, paths.runMetadata)}`);

  const result = await ingest(pr, { version: options.version, reporter });
  await writeJsonArtifact(paths.github.prMetadata, result.metadata);
  await writeJsonArtifact(paths.github.changedFiles, result.changedFiles);
  if (result.diff !== null) await writeTextArtifact(paths.github.diff, result.diff);

  reporter.step("fetched PR metadata");
  reporter.step(`fetched ${result.changedFiles.totalCount} changed files`);
  reporter.step(result.diff !== null ? "fetched diff" : "diff skipped (too large)", result.diff !== null);
  reporter.blank();
  reporter.note("Phase 2 — review packet and AI agents are not wired up yet.");
}
