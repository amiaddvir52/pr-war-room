import { join, resolve } from "node:path";

export const ARTIFACT_ROOT_DIRNAME = ".ai-review";
export const RUNS_DIRNAME = "runs";
export const LATEST_POINTER_FILENAME = "latest.json";

/**
 * The `.ai-review/` artifact layout (PRD §11.2, evolved to run-scoped runs).
 *
 * Every review run writes its outputs under its own `runs/<run_id>/` directory,
 * so a new run can never mix its artifacts with a previous run's (the stale-
 * artifact failure the first TaskFlow demo exposed: Jul-1 `claude_findings.json`
 * files sitting next to Jul-6 outputs in one shared `raw/`). The root keeps:
 *
 *   .ai-review/
 *     latest.json          ← pointer to the most recent review run
 *     workspace/repo       ← the shared clone cache (expensive; reused across runs)
 *     runs/<run_id>/…      ← everything a single run produced
 *
 * `fix` resolves the run to operate on via `latest.json` and writes its own
 * outputs into that same run directory, so a patch always sits next to the
 * findings it was generated from.
 */

/** Paths that are shared across runs (never scoped to a run id). */
export interface SharedArtifactPaths {
  /** `.ai-review` root. */
  root: string;
  /** Pointer file naming the latest review run (see storage/latestRun.ts). */
  latestPointer: string;
  /** Parent directory of all run-scoped artifact directories. */
  runsDir: string;
  /** The shared clone cache. `repo` survives across runs; re-cloning per run
   *  would dwarf every other cost of a review. */
  workspace: { dir: string; repo: string };
  // Phase 13 — team reviewer profile (cross-run by nature).
  teamProfile: { md: string; json: string };
}

/** Compute the run-independent paths under `<baseDir>/.ai-review`. Pure — no IO. */
export function getSharedPaths(baseDir: string): SharedArtifactPaths {
  const root = resolve(baseDir, ARTIFACT_ROOT_DIRNAME);
  return {
    root,
    latestPointer: join(root, LATEST_POINTER_FILENAME),
    runsDir: join(root, RUNS_DIRNAME),
    workspace: { dir: join(root, "workspace"), repo: join(root, "workspace", "repo") },
    teamProfile: { md: join(root, "team_profile.md"), json: join(root, "team_profile.json") },
  };
}

/**
 * The complete artifact layout for ONE run. Field names mirror the PRD §11.2
 * tree; every path except `workspace.repo` (the shared clone cache) lives under
 * `runs/<run_id>/`.
 */
export interface ArtifactPaths {
  /** `.ai-review` root (shared). */
  root: string;
  /** This run's id. */
  runId: string;
  /** This run's directory: `.ai-review/runs/<run_id>`. */
  runDir: string;
  runMetadata: string;

  // Phase 2 — GitHub ingestion
  github: { dir: string; prMetadata: string; changedFiles: string; diff: string };

  // Phase 3 — local workspace + verification. `repo` is the SHARED clone cache;
  // `metadata` records what THIS run checked out (run-scoped provenance).
  workspace: { dir: string; repo: string; metadata: string };
  verification: { dir: string; initial: string; logsDir: string };

  // Phase 4 — review packet
  context: { dir: string; packetMd: string; packetJson: string };

  // Phase 5/6 — reviewer raw output (per-agent) + normalized findings
  raw: {
    dir: string;
    reviewMd: (agent: string) => string;
    findingsJson: (agent: string) => string;
    /** Phase 6 — per-agent run summary (which agents ran / failed / timed out). */
    agentRuns: string;
  };
  normalized: { dir: string; allFindings: string };

  // Phase 7 — deduplication
  deduped: { dir: string; clusters: string; stats: string };

  // Phase 8 — skeptic
  skeptic: { dir: string; results: string };

  // Phase 9 — judge
  judge: { dir: string; ranked: string };

  // Phase 9/10 — final outputs. The HTML report is the primary user-facing
  // artifact; the Markdown report is kept as a secondary/legacy rendering.
  finalFindings: string;
  reportHtml: string;
  reportMd: string;

  // Phase 11 — fix mode (written into the SAME run dir as the review it fixes)
  fix: {
    /** Fix-run metadata — separate from `runMetadata` so `fix` never clobbers the review's record. */
    metadata: string;
    patch: string;
    report: string;
    /** Machine-readable per-finding outcomes. */
    results: string;
    verification: string;
    /** Post-fix verification logs — separate from the review's `verification/logs`. */
    logsDir: string;
  };

  // Phase 12 — eval mode
  eval: { dir: string; results: string; report: string };
}

/**
 * Compute all artifact paths for run `runId` under `<baseDir>/.ai-review`.
 * Pure — no IO.
 *
 * `baseDir` is the root the `.ai-review/` folder lives in; the CLI roots it at
 * `process.cwd()`. The shared clone cache stays at `.ai-review/workspace/repo`
 * so `review` and `fix` runs reuse one checkout.
 */
export function getArtifactPaths(baseDir: string, runId: string): ArtifactPaths {
  const shared = getSharedPaths(baseDir);
  const runDir = join(shared.runsDir, runId);
  const p = (...segments: string[]): string => join(runDir, ...segments);

  return {
    root: shared.root,
    runId,
    runDir,
    runMetadata: p("run_metadata.json"),

    github: {
      dir: p("github"),
      prMetadata: p("github", "pr_metadata.json"),
      changedFiles: p("github", "changed_files.json"),
      diff: p("github", "diff.patch"),
    },

    workspace: {
      dir: shared.workspace.dir,
      repo: shared.workspace.repo,
      metadata: p("workspace_metadata.json"),
    },
    verification: {
      dir: p("verification"),
      initial: p("verification", "initial_verification.json"),
      logsDir: p("verification", "logs"),
    },

    context: {
      dir: p("context"),
      packetMd: p("context", "review_packet.md"),
      packetJson: p("context", "review_packet.json"),
    },

    raw: {
      dir: p("raw"),
      reviewMd: (agent: string) => p("raw", `${agent}_review.md`),
      findingsJson: (agent: string) => p("raw", `${agent}_findings.json`),
      agentRuns: p("raw", "agent_runs.json"),
    },
    normalized: {
      dir: p("normalized"),
      allFindings: p("normalized", "all_findings.json"),
    },

    deduped: {
      dir: p("deduped"),
      clusters: p("deduped", "finding_clusters.json"),
      stats: p("deduped", "dedup_stats.json"),
    },

    skeptic: { dir: p("skeptic"), results: p("skeptic", "skeptic_results.json") },

    judge: { dir: p("judge"), ranked: p("judge", "ranked_findings.json") },

    finalFindings: p("final_findings.json"),
    reportHtml: p("report.html"),
    reportMd: p("report.md"),

    fix: {
      metadata: p("fix_metadata.json"),
      patch: p("patch.diff"),
      report: p("fix_report.md"),
      results: p("fix_results.json"),
      verification: p("fix_verification.json"),
      logsDir: p("verification", "fix-logs"),
    },

    eval: {
      dir: p("eval"),
      results: p("eval", "eval_results.json"),
      report: p("eval", "eval_report.md"),
    },
  };
}
