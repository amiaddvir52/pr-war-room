import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runFix, type EnsureWorkspaceFn, type ExecuteVerificationFn, type FixOptions } from "../../src/cli/commands/fix.js";
import type { RunFixes, RunFixesInput } from "../../src/fix/runFixes.js";
import type { FixFindingOutcome } from "../../src/fix/schema.js";
import { ConfigError, FixError } from "../../src/errors.js";
import { CONFIG_FILENAME } from "../../src/config/loadConfig.js";
import { silentReporter } from "../../src/ui/reporter.js";
import type { GitRunner } from "../../src/workspace/git.js";
import type { EnsureWorkspaceInput } from "../../src/workspace/git.js";
import type { ExecuteVerificationInput } from "../../src/workspace/executeVerification.js";
import { makeFinalFinding } from "../fixtures/finalFinding.js";

const PR_URL = "https://github.com/org/repo/pull/123";

/** The seeded review run's id; fix must resolve it via `.ai-review/latest.json`. */
const RUN_ID = "run-fix-test";
const RUN_REL = `.ai-review/runs/${RUN_ID}`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pwr-fix-cmd-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedFile(relPath: string, content: unknown): Promise<void> {
  const full = join(dir, relPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(
    full,
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
}

async function readJson(...segments: string[]): Promise<Record<string, unknown>> {
  const raw = await readFile(join(dir, RUN_REL, ...segments), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function exists(...segments: string[]): Promise<boolean> {
  try {
    await stat(join(dir, RUN_REL, ...segments));
    return true;
  } catch {
    return false;
  }
}

/** Point `.ai-review/latest.json` at the seeded run, as a real review would. */
async function seedLatestPointer(): Promise<void> {
  await seedFile(".ai-review/latest.json", {
    schemaVersion: 1,
    runId: RUN_ID,
    runDir: `runs/${RUN_ID}`,
    command: "review",
    pr: { owner: "org", repo: "repo", number: 123 },
    prUrl: PR_URL,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

/** Seed a complete prior review run (the fix command's required inputs). */
async function seedReviewRun(
  options: { findings?: unknown[]; pr?: { owner: string; repo: string; number: number } } = {},
): Promise<void> {
  await seedLatestPointer();
  const findings = options.findings ?? [makeFinalFinding()];
  await seedFile(`${RUN_REL}/final_findings.json`, findings);
  await seedFile(`${RUN_REL}/run_metadata.json`, {
    command: "review",
    pr: options.pr ?? { owner: "org", repo: "repo", number: 123 },
    marker: "written-by-review",
  });
  await seedFile(`${RUN_REL}/github/changed_files.json`, {
    schemaVersion: 1,
    totalCount: 1,
    truncated: false,
    files: [
      {
        filename: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patchOmitted: false,
        patch: "@@ -1 +1 @@",
      },
    ],
  });
  await seedFile(`${RUN_REL}/workspace_metadata.json`, { headSha: "reviewedsha" });
}

function fakeEnsureWorkspace(
  overrides: { headMoved?: boolean } = {},
): { fn: EnsureWorkspaceFn; calls: EnsureWorkspaceInput[] } {
  const calls: EnsureWorkspaceInput[] = [];
  const fn: EnsureWorkspaceFn = async (input) => {
    calls.push(input);
    return {
      repoDir: input.repoDir,
      remote: "https://github.com/org/repo.git",
      ref: "pull/123/head",
      headSha: "reviewedsha",
      reused: true,
      headMoved: overrides.headMoved ?? false,
    };
  };
  return { fn, calls };
}

function fakeRunFixes(
  outcomes: FixFindingOutcome[],
): { fn: RunFixes; calls: RunFixesInput[] } {
  const calls: RunFixesInput[] = [];
  const fn: RunFixes = async (input) => {
    calls.push(input);
    return { outcomes, anyApplied: outcomes.some((o) => o.status === "fixed") };
  };
  return { fn, calls };
}

function fixedOutcome(overrides: Partial<FixFindingOutcome> = {}): FixFindingOutcome {
  return {
    cluster_id: "cluster-001",
    title: "off-by-one in range check",
    file: "src/a.ts",
    classification: "should_fix_before_review",
    final_score: 0.8,
    status: "fixed",
    summary: "fixed",
    needs_manual_review: null,
    edits_applied: 1,
    failure: null,
    ...overrides,
  };
}

function fakeGitRunner(diff = "diff --git a/src/a.ts b/src/a.ts\n"): {
  runner: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    return { stdout: args.includes("diff") ? diff : "", stderr: "" };
  };
  return { runner, calls };
}

function baseOptions(overrides: Partial<FixOptions> = {}): FixOptions {
  return {
    version: "0.0.0-test",
    cwd: dir,
    reporter: silentReporter(),
    ensureWorkspace: fakeEnsureWorkspace().fn,
    runFixes: fakeRunFixes([fixedOutcome()]).fn,
    gitRunner: fakeGitRunner().runner,
    resolveToken: async () => null,
    ...overrides,
  };
}

describe("runFix", () => {
  it("fails with FixError (exit 7) and review guidance when no review run exists at all", async () => {
    const promise = runFix(PR_URL, baseOptions());
    await expect(promise).rejects.toBeInstanceOf(FixError);
    await expect(runFix(PR_URL, baseOptions())).rejects.toMatchObject({ exitCode: 7 });
    await expect(runFix(PR_URL, baseOptions())).rejects.toThrow(/pr-war-room review/);
    expect(await exists("fix_report.md")).toBe(false);
    expect(await exists("fix_results.json")).toBe(false);
  });

  it("fails with FixError (exit 7) when the latest run has no final_findings.json", async () => {
    // The pointer names a run, but the run is incomplete (aborted mid-review).
    await seedLatestPointer();
    await expect(runFix(PR_URL, baseOptions())).rejects.toBeInstanceOf(FixError);
    await expect(runFix(PR_URL, baseOptions())).rejects.toThrow(/final findings/i);
    expect(await exists("fix_report.md")).toBe(false);
  });

  it("fails with FixError when the findings belong to a different PR", async () => {
    await seedReviewRun({ pr: { owner: "other", repo: "elsewhere", number: 9 } });
    await expect(runFix(PR_URL, baseOptions())).rejects.toThrow(/other\/elsewhere#9/);
  });

  it("rejects invalid final findings with guidance to re-run review", async () => {
    await seedReviewRun({ findings: [{ not: "a finding" }] });
    await expect(runFix(PR_URL, baseOptions())).rejects.toThrow(/re-run/);
  });

  it("handles zero fixable findings: writes report + results, never prepares the workspace", async () => {
    await seedReviewRun({
      findings: [
        makeFinalFinding({ needs_code_change: false }),
        makeFinalFinding({ cluster_id: "c2", final_classification: "nice_to_have" }),
      ],
    });
    const workspace = fakeEnsureWorkspace();
    const fixes = fakeRunFixes([]);
    await runFix(PR_URL, baseOptions({ ensureWorkspace: workspace.fn, runFixes: fixes.fn }));

    expect(workspace.calls).toHaveLength(0);
    expect(fixes.calls).toHaveLength(0);
    const results = await readJson("fix_results.json");
    expect(results).toMatchObject({ fixableCount: 0, selectedCount: 0, patchWritten: false });
    const report = await readFile(join(dir, RUN_REL, "fix_report.md"), "utf8");
    expect(report).toContain("0 of 0 fixable findings attempted");
    expect(await exists("patch.diff")).toBe(false);
    expect(await exists("fix_verification.json")).toBe(false);
  });

  it("writes every fix artifact on the happy path and leaves run_metadata.json untouched", async () => {
    await seedReviewRun();
    const fixes = fakeRunFixes([fixedOutcome()]);
    await runFix(PR_URL, baseOptions({ runFixes: fixes.fn }));

    // The five fix artifacts.
    expect(await readFile(join(dir, RUN_REL, "patch.diff"), "utf8")).toContain("diff --git");
    expect(await exists("fix_report.md")).toBe(true);
    const results = await readJson("fix_results.json");
    expect(results).toMatchObject({
      schemaVersion: 1,
      totalFinalFindings: 1,
      fixableCount: 1,
      selectedCount: 1,
      patchWritten: true,
      workspaceLeftPatched: false,
    });
    const verification = await readJson("fix_verification.json");
    expect(verification).toMatchObject({ ran: false });
    const metadata = await readJson("fix_metadata.json");
    expect(metadata).toMatchObject({ command: "fix" });

    // The review's run record is read-only to fix.
    const reviewMetadata = await readJson("run_metadata.json");
    expect(reviewMetadata).toMatchObject({ command: "review", marker: "written-by-review" });

    // The orchestrator got the selected findings and the changed files.
    expect(fixes.calls[0]?.findings).toHaveLength(1);
    expect(fixes.calls[0]?.changedFiles.files[0]?.filename).toBe("src/a.ts");
  });

  it("passes the reviewed head sha to the workspace guard", async () => {
    await seedReviewRun();
    const workspace = fakeEnsureWorkspace();
    await runFix(PR_URL, baseOptions({ ensureWorkspace: workspace.fn }));
    expect(workspace.calls[0]).toMatchObject({
      owner: "org",
      repo: "repo",
      number: 123,
      expectedHeadSha: "reviewedsha",
    });
  });

  it("restores the workspace by default (patch-only mode)", async () => {
    await seedReviewRun();
    const git = fakeGitRunner();
    await runFix(PR_URL, baseOptions({ gitRunner: git.runner }));
    const flat = git.calls.map((args) => args.join(" "));
    expect(flat.some((c) => c.includes("reset --hard HEAD"))).toBe(true);
    expect(flat.some((c) => c.includes("clean -fd"))).toBe(true);
  });

  it("keeps the workspace patched with --apply", async () => {
    await seedReviewRun();
    const git = fakeGitRunner();
    await runFix(PR_URL, baseOptions({ gitRunner: git.runner, apply: true }));
    const flat = git.calls.map((args) => args.join(" "));
    expect(flat.some((c) => c.includes("reset --hard HEAD"))).toBe(false);
    const results = await readJson("fix_results.json");
    expect(results).toMatchObject({ workspaceLeftPatched: true });
  });

  it("restores the workspace even when the diff stage throws", async () => {
    await seedReviewRun();
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push(args);
      if (args.includes("diff")) throw new Error("boom");
      return { stdout: "", stderr: "" };
    };
    await expect(runFix(PR_URL, baseOptions({ gitRunner: runner }))).rejects.toThrow();
    const flat = calls.map((args) => args.join(" "));
    expect(flat.some((c) => c.includes("reset --hard HEAD"))).toBe(true);
    // The collected outcomes are still persisted for the user.
    const results = await readJson("fix_results.json");
    expect(results).toMatchObject({ patchWritten: false });
    expect(results.outcomes).toHaveLength(1);
    expect(await exists("fix_report.md")).toBe(true);
  });

  it("restores the workspace and writes results when the fix stage itself throws", async () => {
    await seedReviewRun();
    const git = fakeGitRunner();
    const runFixesBoom: RunFixes = async () => {
      throw new Error("unexpected fix-stage crash");
    };
    await expect(
      runFix(PR_URL, baseOptions({ runFixes: runFixesBoom, gitRunner: git.runner })),
    ).rejects.toThrow("unexpected fix-stage crash");
    const flat = git.calls.map((args) => args.join(" "));
    expect(flat.some((c) => c.includes("reset --hard HEAD"))).toBe(true);
    const results = await readJson("fix_results.json");
    expect(results).toMatchObject({ patchWritten: false });
    expect(results.outcomes).toEqual([]);
  });

  it("does not let a restore failure mask the stage error", async () => {
    await seedReviewRun();
    const runner: GitRunner = async (args) => {
      if (args.includes("diff")) throw new Error("stage boom");
      if (args.includes("reset")) throw new Error("restore boom");
      return { stdout: "", stderr: "" };
    };
    const rejection = expect(runFix(PR_URL, baseOptions({ gitRunner: runner }))).rejects;
    await rejection.toThrow(/stage boom/);
  });

  it("accepts the same PR typed with different owner/repo casing", async () => {
    // GitHub owner/repo names are case-insensitive.
    await seedReviewRun({ pr: { owner: "OrG", repo: "RePo", number: 123 } });
    await runFix(PR_URL, baseOptions());
    expect(await exists("fix_report.md")).toBe(true);
  });

  it("removes a previous run's stale patch.diff so it can never be applied by mistake", async () => {
    await seedReviewRun();
    await seedFile(`${RUN_REL}/patch.diff`, "stale patch from an earlier run");
    const fixes = fakeRunFixes([
      fixedOutcome({ status: "failed", failure: { kind: "refusal", message: "r" }, edits_applied: 0 }),
    ]);
    // This run's tree is unchanged → empty diff → no new patch written.
    await runFix(PR_URL, baseOptions({ runFixes: fixes.fn, gitRunner: fakeGitRunner("").runner }));
    expect(await exists("patch.diff")).toBe(false);
    const results = await readJson("fix_results.json");
    expect(results).toMatchObject({ patchWritten: false });
  });

  it("skips verification by default with an actionable reason", async () => {
    await seedReviewRun();
    await runFix(PR_URL, baseOptions());
    const verification = await readJson("fix_verification.json");
    expect(verification).toMatchObject({
      ran: false,
      skipReason: "verification disabled (pass --verify or set verification.enabled=true)",
    });
  });

  it("skips verification when no fixes were applied, even with --verify", async () => {
    await seedReviewRun();
    const fixes = fakeRunFixes([
      fixedOutcome({ status: "failed", failure: { kind: "timeout", message: "t" } }),
    ]);
    const verify = { called: false };
    const executeVerification: ExecuteVerificationFn = async () => {
      verify.called = true;
      throw new Error("must not run");
    };
    await runFix(
      PR_URL,
      baseOptions({ runFixes: fixes.fn, verify: true, executeVerification }),
    );
    expect(verify.called).toBe(false);
    const verification = await readJson("fix_verification.json");
    expect(verification).toMatchObject({ ran: false, skipReason: "no fixes were applied" });
  });

  it("runs verification against the patched workspace with --verify", async () => {
    await seedReviewRun();
    const inputs: ExecuteVerificationInput[] = [];
    const executeVerification: ExecuteVerificationFn = async (input) => {
      inputs.push(input);
      return {
        install: null,
        results: [],
        executedCommands: [],
        skippedCommands: [],
        skipReason: null,
        allPassed: true,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      };
    };
    await runFix(PR_URL, baseOptions({ verify: true, executeVerification }));
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.repoDir).toBe(join(dir, ".ai-review", "workspace", "repo"));
    expect(inputs[0]?.logsDir).toBe(join(dir, RUN_REL, "verification", "fix-logs"));
    const verification = await readJson("fix_verification.json");
    expect(verification).toMatchObject({ ran: true, allPassed: true, enabledSource: "flag" });
  });

  it("still succeeds (exit 0 path) when every fix fails and no patch is produced", async () => {
    await seedReviewRun();
    const fixes = fakeRunFixes([
      fixedOutcome({ status: "failed", failure: { kind: "refusal", message: "r" }, edits_applied: 0 }),
    ]);
    // An unchanged tree produces an empty diff.
    await runFix(PR_URL, baseOptions({ runFixes: fixes.fn, gitRunner: fakeGitRunner("").runner }));
    expect(await exists("patch.diff")).toBe(false);
    const results = await readJson("fix_results.json");
    expect(results).toMatchObject({ patchWritten: false });
    const report = await readFile(join(dir, RUN_REL, "fix_report.md"), "utf8");
    expect(report).toContain("_No patch was produced, so there is nothing to apply._");
  });

  it("respects fix.maxFindings from config", async () => {
    await seedFile(CONFIG_FILENAME, { fix: { maxFindings: 1 } });
    await seedReviewRun({
      findings: [makeFinalFinding({ cluster_id: "c1" }), makeFinalFinding({ cluster_id: "c2" })],
    });
    const fixes = fakeRunFixes([fixedOutcome()]);
    await runFix(PR_URL, baseOptions({ runFixes: fixes.fn }));
    expect(fixes.calls[0]?.findings.map((f) => f.cluster_id)).toEqual(["c1"]);
    const results = await readJson("fix_results.json");
    expect(results).toMatchObject({ fixableCount: 2, selectedCount: 1 });
  });

  it("rejects a typo'd fix config key loudly (strict schema)", async () => {
    await seedFile(CONFIG_FILENAME, { fix: { maxFindngs: 3 } });
    await seedReviewRun();
    await expect(runFix(PR_URL, baseOptions())).rejects.toBeInstanceOf(ConfigError);
  });

  it("proceeds without the PR-match check when run_metadata.json is missing", async () => {
    await seedReviewRun();
    await rm(join(dir, RUN_REL, "run_metadata.json"));
    await runFix(PR_URL, baseOptions());
    expect(await exists("fix_report.md")).toBe(true);
  });
});
