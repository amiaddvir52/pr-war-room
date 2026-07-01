import { parsePrUrl } from "../../github/parsePrUrl.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getArtifactPaths } from "../../storage/artifactPaths.js";
import { writeJsonArtifact } from "../../storage/writeArtifact.js";
import { buildRunMetadata } from "../../runMetadata.js";

export interface ReviewOptions {
  version: string;
  /** Base directory the `.ai-review/` tree is rooted in. Defaults to cwd. */
  cwd?: string;
  /** Injectable logger (defaults to console.log). Keeps this testable. */
  log?: (message: string) => void;
}

/**
 * The `review` command. In Phase 1 it parses the PR URL, resolves config, and
 * writes `run_metadata.json`. This function is the seam every later phase
 * extends: GitHub ingestion, workspace prep, review packet, agents, dedupe,
 * skeptic, judge, and report generation all append steps here.
 */
export async function runReview(prUrl: string, options: ReviewOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((message: string) => console.log(message));

  const pr = parsePrUrl(prUrl);
  const { config, source, path } = await loadConfig(cwd);
  const paths = getArtifactPaths(cwd);

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

  log(`PR War Room — parsed ${pr.owner}/${pr.repo}#${pr.number}`);
  log(`Config: ${source === "file" ? path : "defaults"}`);
  log(`Artifacts: ${paths.root}`);
  log(`Wrote ${paths.runMetadata}`);
  log("GitHub ingestion and AI agents are not implemented yet (Phase 1).");
}
