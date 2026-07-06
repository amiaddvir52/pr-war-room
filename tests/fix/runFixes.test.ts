import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFixes } from "../../src/fix/runFixes.js";
import type { Fixer } from "../../src/agents/FixAgent.js";
import type { FixPromptContext } from "../../src/agents/prompts/fixPrompt.js";
import { FixAgentError } from "../../src/errors.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import type { Config } from "../../src/config/types.js";
import type { ChangedFilesArtifact } from "../../src/github/schema.js";
import { silentReporter } from "../../src/ui/reporter.js";
import { makeFinalFinding } from "../fixtures/finalFinding.js";

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "pwr-runfixes-"));
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

async function seed(path: string, content: string): Promise<void> {
  const full = join(repoDir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

function makeConfig(overrides: Partial<Config["fix"]> = {}): Config {
  return { ...defaultConfig, fix: { ...defaultConfig.fix, ...overrides } };
}

function changedFiles(...filenames: string[]): ChangedFilesArtifact {
  return {
    schemaVersion: 1,
    totalCount: filenames.length,
    truncated: false,
    files: filenames.map((filename) => ({
      filename,
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      patchOmitted: false,
      patch: `@@ patch for ${filename} @@`,
    })),
  };
}

describe("runFixes", () => {
  it("returns immediately for an empty selection", async () => {
    const result = await runFixes({
      findings: [],
      repoDir,
      changedFiles: changedFiles(),
      config: makeConfig(),
      reporter: silentReporter(),
    });
    expect(result).toEqual({ outcomes: [], anyApplied: false });
  });

  it("applies a proposal and records a fixed outcome", async () => {
    await seed("src/a.ts", "const x = 1;\n");
    const contexts: FixPromptContext[] = [];
    const fixer: Fixer = async (ctx) => {
      contexts.push(ctx);
      return {
        edits: [{ path: "src/a.ts", search: "const x = 1;", replace: "const x = 2;" }],
        summary: "bumped x",
        needs_manual_review: null,
      };
    };
    const { outcomes, anyApplied } = await runFixes({
      findings: [makeFinalFinding()],
      repoDir,
      changedFiles: changedFiles("src/a.ts"),
      config: makeConfig({ backend: "claude" }),
      reporter: silentReporter(),
      makeFixer: () => fixer,
    });
    expect(anyApplied).toBe(true);
    expect(outcomes[0]).toMatchObject({
      status: "fixed",
      edits_applied: 1,
      summary: "bumped x",
      failure: null,
    });
    expect(await readFile(join(repoDir, "src/a.ts"), "utf8")).toBe("const x = 2;\n");
    // The fixer saw the real file content and the PR diff hunk.
    expect(contexts[0]?.fileContent).toBe("const x = 1;\n");
    expect(contexts[0]?.diffPatch).toBe("@@ patch for src/a.ts @@");
  });

  it("shows later findings the post-edit content of earlier fixes (sequential)", async () => {
    await seed("src/a.ts", "first\nsecond\n");
    const seen: string[] = [];
    const fixer: Fixer = async (ctx) => {
      seen.push(ctx.fileContent);
      return {
        edits: [{ path: "src/a.ts", search: "first", replace: `fixed-${seen.length}` }],
        summary: "",
        needs_manual_review: null,
      };
    };
    const findings = [
      makeFinalFinding({ cluster_id: "c1" }),
      makeFinalFinding({ cluster_id: "c2" }),
    ];
    const { outcomes } = await runFixes({
      findings,
      repoDir,
      changedFiles: changedFiles("src/a.ts"),
      config: makeConfig({ backend: "claude" }),
      reporter: silentReporter(),
      makeFixer: () => fixer,
    });
    // Finding 2's prompt contained finding 1's applied edit…
    expect(seen[1]).toContain("fixed-1");
    // …but its own search for "first" then failed — recorded, not thrown.
    expect(outcomes[0]?.status).toBe("fixed");
    expect(outcomes[1]).toMatchObject({ status: "failed", failure: { kind: "search_not_found" } });
  });

  it("shifts later findings' line anchors when an earlier fix inserts lines above", async () => {
    await seed("src/a.ts", "l1\nl2\nl3\nl4\nl5\n");
    const anchorsSeen: number[] = [];
    let call = 0;
    const fixer: Fixer = async (ctx) => {
      call++;
      anchorsSeen.push(ctx.finding.line_start);
      if (call === 1) {
        return {
          edits: [{ path: "src/a.ts", search: "l2", replace: "inserted\nl2" }],
          summary: "",
          needs_manual_review: null,
        };
      }
      return { edits: [], summary: "decline", needs_manual_review: null };
    };
    const { outcomes } = await runFixes({
      findings: [
        makeFinalFinding({ cluster_id: "c1", line_start: 2, line_end: 2 }),
        makeFinalFinding({ cluster_id: "c2", line_start: 4, line_end: 4 }),
      ],
      repoDir,
      changedFiles: changedFiles("src/a.ts"),
      config: makeConfig({ backend: "claude" }),
      reporter: silentReporter(),
      makeFixer: () => fixer,
    });
    expect(outcomes[0]?.status).toBe("fixed");
    // Finding 2's review-time anchor (line 4) sits below the inserted line, so
    // the fixer must see it shifted to the file's current coordinates (line 5).
    expect(anchorsSeen).toEqual([2, 5]);
  });

  it("records a mixed run without ever throwing", async () => {
    await seed("src/a.ts", "content a\n");
    await seed("src/c.ts", "content c\n");
    let call = 0;
    const fixer: Fixer = async () => {
      call++;
      if (call === 1) throw new FixAgentError("refused", "refusal");
      if (call === 2) {
        return { edits: [], summary: "too risky", needs_manual_review: "do it by hand" };
      }
      return {
        edits: [{ path: "src/c.ts", search: "content c", replace: "fixed c" }],
        summary: "fixed c",
        needs_manual_review: null,
      };
    };
    const findings = [
      makeFinalFinding({ cluster_id: "c1", file: "src/a.ts" }),
      makeFinalFinding({ cluster_id: "c2", file: "src/a.ts" }),
      makeFinalFinding({ cluster_id: "c3", file: "src/c.ts" }),
      makeFinalFinding({ cluster_id: "c4", file: null }),
      makeFinalFinding({ cluster_id: "c5", file: "src/not-in-pr.ts" }),
    ];
    const { outcomes, anyApplied } = await runFixes({
      findings,
      repoDir,
      changedFiles: changedFiles("src/a.ts", "src/c.ts"),
      config: makeConfig({ backend: "claude" }),
      reporter: silentReporter(),
      makeFixer: () => fixer,
    });
    expect(outcomes.map((o) => [o.status, o.failure?.kind ?? null])).toEqual([
      ["failed", "refusal"],
      ["skipped", "declined"],
      ["fixed", null],
      ["skipped", "no_file"],
      ["failed", "path_not_in_changeset"],
    ]);
    expect(anyApplied).toBe(true);
    // The declined finding keeps the model's notes for the report.
    expect(outcomes[1]).toMatchObject({ summary: "too risky", needs_manual_review: "do it by hand" });
    // c4/c5 never reached the fixer (3 calls total).
    expect(call).toBe(3);
  });

  it("records file_unreadable when the finding's file is missing from the checkout", async () => {
    const { outcomes } = await runFixes({
      findings: [makeFinalFinding({ file: "src/gone.ts" })],
      repoDir,
      changedFiles: changedFiles("src/gone.ts"),
      config: makeConfig({ backend: "claude" }),
      reporter: silentReporter(),
      makeFixer: () => async () => {
        throw new Error("should not be called");
      },
    });
    expect(outcomes[0]).toMatchObject({ status: "failed", failure: { kind: "file_unreadable" } });
  });

  it("marks every finding failed when the fixer cannot be constructed", async () => {
    await seed("src/a.ts", "x\n");
    const { outcomes, anyApplied } = await runFixes({
      findings: [makeFinalFinding({ cluster_id: "c1" }), makeFinalFinding({ cluster_id: "c2" })],
      repoDir,
      changedFiles: changedFiles("src/a.ts"),
      config: makeConfig({ backend: "claude" }),
      reporter: silentReporter(),
      makeFixer: () => {
        throw new Error("no credentials");
      },
    });
    expect(anyApplied).toBe(false);
    for (const o of outcomes) {
      expect(o).toMatchObject({ status: "failed", failure: { kind: "construction_error" } });
    }
  });

  it("uses the deterministic mock fixer for the mock backend (no makeFixer call)", async () => {
    await seed("src/a.ts", "line one\nunique anchor line\nline three\n");
    const { outcomes, anyApplied } = await runFixes({
      findings: [makeFinalFinding({ line_start: 2, line_end: 2 })],
      repoDir,
      changedFiles: changedFiles("src/a.ts"),
      config: makeConfig({ backend: "mock" }),
      reporter: silentReporter(),
      makeFixer: () => {
        throw new Error("makeFixer must not be called for mock");
      },
    });
    expect(anyApplied).toBe(true);
    expect(outcomes[0]?.status).toBe("fixed");
    const content = await readFile(join(repoDir, "src/a.ts"), "utf8");
    expect(content).toContain("// TODO(pr-war-room): off-by-one in range check");
  });
});
