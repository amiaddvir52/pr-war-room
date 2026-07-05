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
import { runReviewers, isUsable } from "../../agents/runReviewers.js";
import type { RunReviewers } from "../../agents/runReviewers.js";
import { deduplicateFindings } from "../../findings/deduplicateFindings.js";
import { createDedupAdjudicator } from "../../agents/DedupAdjudicator.js";
import { runSkeptic, selectSupportedClusters } from "../../agents/runSkeptic.js";
import type { RunSkeptic } from "../../agents/runSkeptic.js";
import { runJudge } from "../../agents/runJudge.js";
import type { RunJudge } from "../../agents/runJudge.js";
import { selectFinalFindings } from "../../findings/scoreFindings.js";
import { renderMarkdownReport } from "../../report/generateMarkdownReport.js";
import type {
  FinalFinding,
  FindingCluster,
  JudgeClassification,
  JudgeResult,
  SkepticResult,
} from "../../findings/schema.js";

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
  /** Phase-6 multi-agent reviewer fan-out. Defaults to the real one; inject a fake in tests. */
  runReviewers?: RunReviewers;
  /** Phase-8 skeptic / evidence validation. Defaults to the real one; inject a fake in tests. */
  skeptic?: RunSkeptic;
  /** Phase-9 LLM-as-a-judge ranking. Defaults to the real one; inject a fake in tests. */
  judge?: RunJudge;
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
  const review = options.runReviewers ?? runReviewers;
  const skeptic = options.skeptic ?? runSkeptic;
  const judge = options.judge ?? runJudge;

  const pr = parsePrUrl(prUrl);
  const { config, source, path } = await loadConfig(cwd);
  const paths = getArtifactPaths(cwd);

  // Render an artifact path as a Cmd-clickable link. The short label is relative
  // to cwd (e.g. `.ai-review/normalized/all_findings.json`); the link target is
  // always the absolute path. The Reporter picks the on-screen form per terminal
  // (OSC 8 link, bare file:// URL, or plain text) — see Reporter.fileLink.
  const artifactLink = (absolutePath: string): string =>
    reporter.fileLink(relative(cwd, absolutePath), absolutePath);

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
        `Some verification commands failed — see ${artifactLink(paths.verification.initial)}`,
      );
    }
  } else {
    reporter.note("Verification skipped — pass --verify to run install + test/lint/build.");
  }

  // Phase 4 — assemble the structured review packet from everything gathered.
  const { packet, markdown } = await buildPacket({
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
      `Review packet trimmed to fit ${packet.limits.maxPacketBytes} bytes — see ${artifactLink(paths.context.packetJson)}`,
    );
  }

  // Phase 6 — fan out to multiple reviewer agents in parallel and merge their
  // validated, normalized findings. Individual agents may fail, time out, or
  // return nothing without aborting the run; only an all-agents failure throws.
  reporter.blank();
  const reviewResult = await review({
    packet,
    packetMarkdown: markdown,
    config,
    paths,
    reporter,
  });

  // We only reach here when the run met `agents.minUsableReviewers` (otherwise
  // runReviewers threw). `usable` reviewers returned valid output; the rest
  // (unusable output / failed / timed out) are reported as a caveat, not success.
  const total = reviewResult.agents.length;
  const usable = reviewResult.agents.filter((a) => isUsable(a.status)).length;
  const incomplete = reviewResult.agents.filter((a) => !isUsable(a.status));

  reporter.blank();
  const n = reviewResult.findings.length;
  reporter.success(
    `${n} finding${n === 1 ? "" : "s"} from ${usable}/${total} reviewer${total === 1 ? "" : "s"} — ` +
      `see ${artifactLink(paths.normalized.allFindings)}`,
  );
  if (incomplete.length > 0) {
    reporter.warn(
      `${incomplete.length} reviewer${incomplete.length === 1 ? "" : "s"} did not complete ` +
        `(${incomplete.map((a) => `${a.name}: ${a.status}`).join(", ")}) — ` +
        `see ${artifactLink(paths.raw.agentRuns)}`,
    );
  }

  // Phase 7 — deduplicate & cluster. Overlapping findings from the independent
  // reviewers are merged into one cluster per underlying issue (singletons
  // included), so the later skeptic/judge phases work on a single uniform unit.
  // Deterministic heuristics by default; the optional LLM adjudicator (§10.6
  // step 4) is only built when configured on.
  const adjudicate = config.dedup.llm.enabled ? createDedupAdjudicator(config) : undefined;
  const clusters = await deduplicateFindings(reviewResult.findings, config.dedup, adjudicate);
  await writeJsonArtifact(paths.deduped.clusters, clusters);

  const merged = reviewResult.findings.length - clusters.length;
  reporter.blank();
  reporter.success(
    `${n} finding${n === 1 ? "" : "s"} deduplicated into ${clusters.length} cluster${clusters.length === 1 ? "" : "s"}` +
      (merged > 0 ? ` (${merged} merged as duplicate${merged === 1 ? "" : "s"})` : "") +
      ` — see ${artifactLink(paths.deduped.clusters)}`,
  );

  // Phase 8 — skeptic / evidence validation. Each cluster is challenged with
  // deterministic file/line/diff checks and (unless disabled) an LLM skeptic that
  // tries to disprove it. Clusters the skeptic drops are excluded from the
  // candidate list that feeds the judge; borderline ones are kept, annotated.
  let skepticResults: SkepticResult[] = [];
  let candidates: FindingCluster[] = clusters;
  if (config.skeptic.enabled) {
    reporter.blank();
    const { results } = await skeptic({ clusters, packet, config, reporter });
    await writeJsonArtifact(paths.skeptic.results, results);
    skepticResults = results;
    candidates = selectSupportedClusters(clusters, results);

    const droppedCount = clusters.length - candidates.length;
    reporter.success(
      `${candidates.length}/${clusters.length} cluster${clusters.length === 1 ? "" : "s"} supported by the skeptic` +
        (droppedCount > 0 ? ` (${droppedCount} dropped as unsupported)` : "") +
        ` — see ${artifactLink(paths.skeptic.results)}`,
    );
    for (const r of results.filter((res) => res.decision.action === "drop")) {
      const cluster = clusters.find((c) => c.cluster_id === r.cluster_id);
      reporter.warn(`dropped ${cluster?.merged_title ?? r.cluster_id} — ${r.decision.reason}`);
    }
  } else {
    reporter.note("Skeptic disabled (skeptic.enabled = false) — all clusters kept as candidates.");
  }

  // Phase 9 — LLM-as-a-judge ranking. Each supported cluster is classified
  // (blocker / should_fix_before_review / nice_to_have / drop) and given a
  // deterministic priority score. The full record (including drops, with reasons)
  // is written to ranked_findings.json; the non-dropped, report-ready subset to
  // final_findings.json. Dropping is recall-guarded: an over-eager drop on a
  // well-supported high-severity finding is softened to nice_to_have.
  // Hoisted (like skepticResults) so the Phase-10 report can read them after the
  // gate; both stay null when the judge is disabled and the report degrades.
  let ranked: JudgeResult[] | null = null;
  let final: FinalFinding[] | null = null;
  if (config.judge.enabled) {
    reporter.blank();
    ({ ranked } = await judge({ clusters: candidates, skepticResults, packet, config, reporter }));
    await writeJsonArtifact(paths.judge.ranked, ranked);

    final = selectFinalFindings(candidates, ranked, skepticResults);
    await writeJsonArtifact(paths.finalFindings, final);

    const counts: Record<JudgeClassification, number> = {
      blocker: 0,
      should_fix_before_review: 0,
      nice_to_have: 0,
      drop: 0,
    };
    for (const r of ranked) counts[r.decision.classification]++;
    reporter.success(
      `${final.length}/${ranked.length} ranked finding${ranked.length === 1 ? "" : "s"} in the report ` +
        `(${counts.blocker} blocker, ${counts.should_fix_before_review} should-fix, ${counts.nice_to_have} optional; ` +
        `${counts.drop} dropped) — see ${artifactLink(paths.finalFindings)}`,
    );
  } else {
    reporter.note("Judge disabled (judge.enabled = false) — no ranking or final_findings.json produced.");
  }

  // Phase 10 — render the concise, human-facing report from the in-memory
  // pipeline outputs (no disk round-trip). Degrades gracefully when the judge
  // and/or skeptic are disabled (ranked/final null, skepticResults empty).
  const reportMarkdown = renderMarkdownReport({
    packet,
    clusters,
    candidates,
    skepticResults,
    ranked,
    final,
    rawFindingCount: reviewResult.findings.length,
    meta: { toolVersion: options.version, generatedAt: metadata.timestamp },
    options: {
      maxFindings: config.review.maxFindings,
      includeNiceToHave: config.review.includeNiceToHave,
      judgeEnabled: config.judge.enabled,
      skepticEnabled: config.skeptic.enabled,
    },
    paths,
  });
  await writeTextArtifact(paths.reportMd, reportMarkdown);
  reporter.blank();
  reporter.success(`report written — see ${artifactLink(paths.reportMd)}`);
}
