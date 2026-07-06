import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { getArtifactPaths, getSharedPaths } from "../../src/storage/artifactPaths.js";

describe("getArtifactPaths (run-scoped)", () => {
  const base = "/tmp/project";
  const root = join(base, ".ai-review");
  const runDir = join(root, "runs", "run-A");
  const paths = getArtifactPaths(base, "run-A");

  it("scopes a run's artifacts under <base>/.ai-review/runs/<runId>", () => {
    expect(paths.root).toBe(root);
    expect(paths.runId).toBe("run-A");
    expect(paths.runDir).toBe(runDir);
    expect(paths.runMetadata).toBe(join(runDir, "run_metadata.json"));
  });

  it("gives two runs disjoint artifact trees (no stale mixing)", () => {
    const other = getArtifactPaths(base, "run-B");
    expect(other.runDir).not.toBe(paths.runDir);
    expect(other.raw.dir).not.toBe(paths.raw.dir);
    expect(other.finalFindings).not.toBe(paths.finalFindings);
    expect(other.reportHtml).not.toBe(paths.reportHtml);
    // …while sharing the one deliberately-shared path: the clone cache.
    expect(other.workspace.repo).toBe(paths.workspace.repo);
  });

  it("keeps the shared clone cache at the root, but run-scopes its metadata", () => {
    expect(paths.workspace.repo).toBe(join(root, "workspace", "repo"));
    expect(paths.workspace.metadata).toBe(join(runDir, "workspace_metadata.json"));
  });

  it("builds per-agent raw paths", () => {
    expect(paths.raw.findingsJson("claude")).toBe(
      join(runDir, "raw", "claude_findings.json"),
    );
    expect(paths.raw.reviewMd("codex")).toBe(join(runDir, "raw", "codex_review.md"));
  });

  it("builds the per-run agent summary path", () => {
    expect(paths.raw.agentRuns).toBe(join(runDir, "raw", "agent_runs.json"));
  });

  it("matches the PRD layout (run-scoped) for deep paths", () => {
    expect(paths.github.diff).toBe(join(runDir, "github", "diff.patch"));
    expect(paths.context.packetJson).toBe(join(runDir, "context", "review_packet.json"));
    expect(paths.deduped.clusters).toBe(join(runDir, "deduped", "finding_clusters.json"));
    expect(paths.deduped.stats).toBe(join(runDir, "deduped", "dedup_stats.json"));
    expect(paths.judge.ranked).toBe(join(runDir, "judge", "ranked_findings.json"));
    expect(paths.eval.results).toBe(join(runDir, "eval", "eval_results.json"));
    expect(paths.finalFindings).toBe(join(runDir, "final_findings.json"));
  });

  it("names the HTML report as the primary report artifact", () => {
    expect(paths.reportHtml).toBe(join(runDir, "report.html"));
    expect(paths.reportMd).toBe(join(runDir, "report.md"));
  });
});

describe("getSharedPaths", () => {
  it("exposes the latest-run pointer, runs dir, and shared workspace", () => {
    const shared = getSharedPaths("/tmp/project");
    const root = join("/tmp/project", ".ai-review");
    expect(shared.latestPointer).toBe(join(root, "latest.json"));
    expect(shared.runsDir).toBe(join(root, "runs"));
    expect(shared.workspace.repo).toBe(join(root, "workspace", "repo"));
  });
});
