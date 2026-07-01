import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { getArtifactPaths } from "../../src/storage/artifactPaths.js";

describe("getArtifactPaths", () => {
  const base = "/tmp/project";
  const root = join(base, ".ai-review");
  const paths = getArtifactPaths(base);

  it("roots everything under <base>/.ai-review", () => {
    expect(paths.root).toBe(root);
    expect(paths.runMetadata).toBe(join(root, "run_metadata.json"));
  });

  it("builds per-agent raw paths", () => {
    expect(paths.raw.findingsJson("claude")).toBe(
      join(root, "raw", "claude_findings.json"),
    );
    expect(paths.raw.reviewMd("codex")).toBe(join(root, "raw", "codex_review.md"));
  });

  it("matches the PRD layout for deep paths", () => {
    expect(paths.github.diff).toBe(join(root, "github", "diff.patch"));
    expect(paths.context.packetJson).toBe(join(root, "context", "review_packet.json"));
    expect(paths.deduped.clusters).toBe(join(root, "deduped", "finding_clusters.json"));
    expect(paths.judge.ranked).toBe(join(root, "judge", "ranked_findings.json"));
    expect(paths.eval.results).toBe(join(root, "eval", "eval_results.json"));
    expect(paths.finalFindings).toBe(join(root, "final_findings.json"));
  });
});
