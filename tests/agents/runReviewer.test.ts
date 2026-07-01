import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewer } from "../../src/agents/runReviewer.js";
import type { ModelClient } from "../../src/agents/types.js";
import { getArtifactPaths } from "../../src/storage/artifactPaths.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import type { Config } from "../../src/config/types.js";
import { FindingSchema } from "../../src/findings/schema.js";
import type { FindingCore } from "../../src/findings/schema.js";
import { ReviewerError } from "../../src/errors.js";
import { silentReporter } from "../../src/ui/reporter.js";
import { makeReviewPacket } from "../fixtures/reviewPacket.js";

function withReviewer(primaryReviewer: string): Config {
  return { ...defaultConfig, models: { ...defaultConfig.models, primaryReviewer } };
}

const packetWithFile = makeReviewPacket({
  changedFiles: [
    {
      path: "src/x.ts",
      status: "modified",
      previousPath: null,
      additions: 3,
      deletions: 1,
      patchOmitted: false,
      patch: "@@ -1 +1 @@",
      nearbyContext: null,
    },
  ],
});

function coreFinding(): FindingCore {
  return {
    title: "Null deref",
    category: "correctness",
    severity: "high",
    confidence: 0.7,
    file: "src/x.ts",
    line_start: 10,
    line_end: 12,
    claim: "x may be undefined",
    evidence: ["guard removed in diff"],
    suggested_fix: null,
    suggested_test: null,
    human_review_likelihood: 0.6,
    needs_code_change: true,
  };
}

describe("runReviewer", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-reviewer-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("mock reviewer writes the three artifacts, all schema-valid", async () => {
    const paths = getArtifactPaths(dir);
    const result = await runReviewer({
      packet: packetWithFile,
      packetMarkdown: "# packet",
      config: withReviewer("mock"),
      paths,
      reporter: silentReporter(),
    });

    expect(result.agent).toBe("mock");
    expect(result.findings.length).toBeGreaterThan(0);

    const rawMd = await readFile(paths.raw.reviewMd("mock"), "utf8");
    expect(rawMd).toContain("findings");

    const rawFindings = JSON.parse(await readFile(paths.raw.findingsJson("mock"), "utf8"));
    expect(Array.isArray(rawFindings)).toBe(true);

    const normalized = JSON.parse(await readFile(paths.normalized.allFindings, "utf8"));
    expect(() => FindingSchema.array().parse(normalized)).not.toThrow();
  });

  it("assigns mock provenance and sequential ids", async () => {
    const result = await runReviewer({
      packet: packetWithFile,
      packetMarkdown: "# packet",
      config: withReviewer("mock"),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
    });
    expect(result.findings[0]?.id).toBe("mock-001");
    expect(result.findings[0]?.source_agent).toBe("mock");
    expect(result.findings[0]?.raw_agent_output_ref).toBe("raw/mock_review.md");
  });

  it("runs the claude reviewer against an injected client (no network)", async () => {
    const client: ModelClient = {
      async complete() {
        return { text: JSON.stringify({ findings: [coreFinding()] }), stopReason: "end_turn" };
      },
    };
    const result = await runReviewer({
      packet: packetWithFile,
      packetMarkdown: "# packet",
      config: withReviewer("claude"),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
      makeClient: () => client,
    });
    expect(result.agent).toBe("claude");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.id).toBe("claude-001");
    expect(result.parseError).toBeNull();
  });

  it("still writes an empty findings artifact on a parse failure", async () => {
    const client: ModelClient = {
      async complete() {
        return { text: "not json", stopReason: "end_turn" };
      },
    };
    const paths = getArtifactPaths(dir);
    const result = await runReviewer({
      packet: packetWithFile,
      packetMarkdown: "# packet",
      config: withReviewer("claude"),
      paths,
      reporter: silentReporter(),
      makeClient: () => client,
    });
    expect(result.findings).toHaveLength(0);
    expect(result.parseError).not.toBeNull();
    const normalized = JSON.parse(await readFile(paths.normalized.allFindings, "utf8"));
    expect(normalized).toEqual([]);
  });

  it("throws ReviewerError for an unimplemented reviewer", async () => {
    await expect(
      runReviewer({
        packet: makeReviewPacket(),
        packetMarkdown: "# packet",
        config: withReviewer("codex"),
        paths: getArtifactPaths(dir),
        reporter: silentReporter(),
      }),
    ).rejects.toBeInstanceOf(ReviewerError);
  });
});
