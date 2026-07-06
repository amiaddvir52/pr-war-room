import { join, resolve } from "node:path";

export const ARTIFACT_ROOT_DIRNAME = ".ai-review";

/**
 * The complete `.ai-review/` artifact layout (PRD §11.2). The entire tree is
 * declared here — even paths that no phase writes yet — so every later phase
 * imports its paths from one place instead of hardcoding strings.
 */
export interface ArtifactPaths {
  root: string;
  runMetadata: string;

  // Phase 2 — GitHub ingestion
  github: { dir: string; prMetadata: string; changedFiles: string; diff: string };

  // Phase 3 — local workspace + verification
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
  deduped: { dir: string; clusters: string };

  // Phase 8 — skeptic
  skeptic: { dir: string; results: string };

  // Phase 9 — judge
  judge: { dir: string; ranked: string };

  // Phase 9/10 — final outputs
  finalFindings: string;
  reportMd: string;

  // Phase 11 — fix mode
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

  // Phase 13 — team reviewer profile
  teamProfile: { md: string; json: string };
}

/**
 * Compute all artifact paths under `<baseDir>/.ai-review`. Pure — no IO.
 *
 * `baseDir` is the root the `.ai-review/` folder lives in; the CLI roots it at
 * `process.cwd()`. The Phase-3 cloned repo becomes `.ai-review/workspace/repo`,
 * a subdirectory, so `baseDir = cwd` stays stable across all phases.
 */
export function getArtifactPaths(baseDir: string): ArtifactPaths {
  const root = resolve(baseDir, ARTIFACT_ROOT_DIRNAME);
  const p = (...segments: string[]): string => join(root, ...segments);

  return {
    root,
    runMetadata: p("run_metadata.json"),

    github: {
      dir: p("github"),
      prMetadata: p("github", "pr_metadata.json"),
      changedFiles: p("github", "changed_files.json"),
      diff: p("github", "diff.patch"),
    },

    workspace: {
      dir: p("workspace"),
      repo: p("workspace", "repo"),
      metadata: p("workspace", "workspace_metadata.json"),
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

    deduped: { dir: p("deduped"), clusters: p("deduped", "finding_clusters.json") },

    skeptic: { dir: p("skeptic"), results: p("skeptic", "skeptic_results.json") },

    judge: { dir: p("judge"), ranked: p("judge", "ranked_findings.json") },

    finalFindings: p("final_findings.json"),
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

    teamProfile: { md: p("team_profile.md"), json: p("team_profile.json") },
  };
}
