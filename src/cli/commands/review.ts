import { relative } from "node:path";
import { parsePrUrl } from "../../github/parsePrUrl.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getArtifactPaths } from "../../storage/artifactPaths.js";
import { writeJsonArtifact, writeTextArtifact } from "../../storage/writeArtifact.js";
import { buildRunMetadata } from "../../runMetadata.js";
import { Reporter } from "../../ui/reporter.js";
import { selectBanner } from "../../ui/banner.js";
import { ingestPullRequest, type IngestPullRequest } from "../../github/ingestPullRequest.js";
import { prepareWorkspace } from "../../workspace/prepareWorkspace.js";
import type { PrepareWorkspaceInput, WorkspaceResult } from "../../workspace/prepareWorkspace.js";
import { buildReviewPacket } from "../../context/buildReviewPacket.js";
import type {
  BuildReviewPacketInput,
  BuildReviewPacketResult,
} from "../../context/buildReviewPacket.js";

/** Phase-3 workspace prep. Injected so tests avoid git/subprocess side effects. */
export type PrepareWorkspaceFn = (input: PrepareWorkspaceInput) => Promise<WorkspaceResult>;

/** Phase-4 review-packet builder. Injected so tests avoid filesystem coupling. */
export type BuildReviewPacketFn = (
  input: BuildReviewPacketInput,
) => Promise<BuildReviewPacketResult>;

export interface ReviewOptions {
  version: string;
  /** Base directory the `.ai-review/` tree is rooted in. Defaults to cwd. */
  cwd?: string;
  /** Output reporter. Defaults to a console reporter; inject a silent one in tests. */
  reporter?: Reporter;
  /** GitHub ingestion. Defaults to the real fetcher; inject a fake in tests to avoid the network. */
  ingest?: IngestPullRequest;
  /** `--verify` flag: run verification commands. Overrides config.verification.enabled when set. */
  verify?: boolean;
  /** Workspace preparation. Defaults to the real one; inject a fake in tests. */
  prepareWorkspace?: PrepareWorkspaceFn;
  /** Review-packet builder. Defaults to the real one; inject a fake in tests. */
  buildReviewPacket?: BuildReviewPacketFn;
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
  const prepareWs = options.prepareWorkspace ?? prepareWorkspace;
  const buildPacket = options.buildReviewPacket ?? buildReviewPacket;

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

  // Phase 3 — local workspace + repo detection (+ optional verification).
  const workspace = await prepareWs({
    pr,
    config,
    paths,
    cwd,
    ...(options.verify !== undefined ? { verify: options.verify } : {}),
  });
  const ws = workspace.metadata;
  reporter.step(ws.reused ? "reused workspace" : "checked out PR head");
  reporter.step(`detected ${ws.projectTypes.join(", ") || "unknown"} project`);
  if (workspace.verification.ran) {
    reporter.step("ran verification", workspace.verification.allPassed);
    if (!workspace.verification.allPassed) {
      reporter.warn(
        `Some verification commands failed — see ${relative(paths.root, paths.verification.initial)}`,
      );
    }
  } else {
    reporter.note("Verification skipped — pass --verify to run install + test/lint/build.");
  }

  // Phase 4 — assemble the structured review packet from everything gathered.
  const { packet } = await buildPacket({
    pr,
    prMetadata: result.metadata,
    changedFiles: result.changedFiles,
    workspace,
    config,
    paths,
    cwd,
  });
  reporter.step(`built review packet (${packet.changedFiles.length} files)`);
  if (packet.limits.truncated) {
    reporter.warn(
      `Review packet trimmed to fit ${packet.limits.maxPacketBytes} bytes — see ${relative(paths.root, paths.context.packetJson)}`,
    );
  }

  reporter.blank();
  reporter.note("Phase 4 — AI review agents are not wired up yet.");
}
