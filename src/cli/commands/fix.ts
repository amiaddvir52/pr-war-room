import { rm } from "node:fs/promises";
import { relative } from "node:path";
import { parsePrUrl } from "../../github/parsePrUrl.js";
import { loadConfig } from "../../config/loadConfig.js";
import { getArtifactPaths, type ArtifactPaths } from "../../storage/artifactPaths.js";
import { readLatestRunPointer } from "../../storage/latestRun.js";
import { writeJsonArtifact, writeTextArtifact } from "../../storage/writeArtifact.js";
import { buildRunMetadata } from "../../runMetadata.js";
import { Reporter } from "../../ui/reporter.js";
import { selectBanner } from "../../ui/banner.js";
import { FixError } from "../../errors.js";
import { resolveGitHubToken } from "../../github/auth.js";
import {
  loadChangedFiles,
  loadFinalFindings,
  loadReviewedPr,
  loadWorkspaceHeadSha,
} from "../../fix/loadReviewArtifacts.js";
import { selectFixableFindings } from "../../fix/selectFixableFindings.js";
import { runFixes, type RunFixes } from "../../fix/runFixes.js";
import type { FixResults } from "../../fix/schema.js";
import {
  ensurePrHeadWorkspace,
  gitDiff,
  restoreWorkspace,
  type EnsuredWorkspace,
  type EnsureWorkspaceInput,
  type GitRunner,
} from "../../workspace/git.js";
import {
  executeVerification as executeVerificationReal,
  type ExecuteVerificationInput,
  type ExecutedVerification,
} from "../../workspace/executeVerification.js";
import {
  planVerification,
  skippedVerification,
  VERIFICATION_DISABLED_REASON,
} from "../../workspace/verificationPlan.js";
import type { Config } from "../../config/types.js";
import type { VerificationResults } from "../../workspace/schema.js";
import { renderFixReport } from "../../report/generateFixReport.js";

/** Phase-11 workspace guard. Injected so tests avoid git side effects. */
export type EnsureWorkspaceFn = (input: EnsureWorkspaceInput) => Promise<EnsuredWorkspace>;

/** Verification executor. Injected so tests avoid real subprocesses. */
export type ExecuteVerificationFn = (
  input: ExecuteVerificationInput,
) => Promise<ExecutedVerification>;

export interface FixOptions {
  version: string;
  /** Base directory the `.ai-review/` tree is rooted in. Defaults to cwd. */
  cwd?: string;
  /** Output reporter. Defaults to a console reporter; inject a silent one in tests. */
  reporter?: Reporter;
  /** `--apply`: leave the workspace checkout patched instead of reverting it. */
  apply?: boolean;
  /** `--verify` flag: run verification after patching. Overrides config.verification.enabled. */
  verify?: boolean;
  /** Workspace guard. Defaults to the real one; inject a fake in tests. */
  ensureWorkspace?: EnsureWorkspaceFn;
  /** Fix orchestrator. Defaults to the real one; inject a fake in tests. */
  runFixes?: RunFixes;
  /** Verification executor. Defaults to the real one; inject a fake in tests. */
  executeVerification?: ExecuteVerificationFn;
  /** Git seam for diff/restore (and the default workspace guard). */
  gitRunner?: GitRunner;
  /** Token resolution; injected in tests. Defaults to env/gh (null on failure). */
  resolveToken?: () => Promise<string | null>;
}

/**
 * The `fix` command (Phase 11, PRD §10.10). It loads the latest review run's
 * `final_findings.json`, selects the fixable findings (needs_code_change +
 * blocker/should-fix), asks the fix agent for search/replace edits per finding,
 * applies them to the workspace checkout, and lets `git diff` produce
 * `.ai-review/patch.diff` — a patch that is valid by construction. Verification
 * (opt-in, like `review`) then runs against the patched checkout, and the
 * workspace is reverted unless `--apply` was passed.
 *
 * It never touches the user's own working tree, never commits, never pushes,
 * and never publishes comments. The review's `run_metadata.json` is read-only
 * here; fix records its own run in `fix_metadata.json`.
 */
export async function runFix(prUrl: string, options: FixOptions): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const reporter = options.reporter ?? new Reporter();
  const ensureWorkspace = options.ensureWorkspace ?? ensurePrHeadWorkspace;
  const runFixesFn = options.runFixes ?? runFixes;
  const executeVerification = options.executeVerification ?? executeVerificationReal;
  const apply = options.apply === true;

  const pr = parsePrUrl(prUrl);
  const { config, source, path } = await loadConfig(cwd);

  // Fix operates on the LATEST review run, resolved through `latest.json` —
  // never by guessing at directories — and writes its own outputs into that
  // same run directory so a patch always sits next to the findings it came from.
  const latest = await readLatestRunPointer(cwd);
  if (latest === null) {
    throw new FixError(
      "No review run found (.ai-review/latest.json is missing or unreadable) — " +
        "run `pr-war-room review <pr-url>` first.",
    );
  }
  const paths = getArtifactPaths(cwd, latest.runId);

  const artifactLink = (absolutePath: string): string =>
    reporter.fileLink(relative(cwd, absolutePath), absolutePath);

  const art = selectBanner();
  if (art) {
    reporter.logo(art, `v${options.version} · fix mode`);
  } else {
    reporter.banner("PR War Room — fix", `v${options.version}`);
  }
  reporter.keyValues([
    ["PR", `${pr.owner}/${pr.repo}#${pr.number}`],
    ["Config", source === "file" && path ? relative(cwd, path) : "defaults"],
    ["Mode", apply ? "apply (workspace checkout kept patched)" : "patch only"],
    ["Run", latest.runId],
    ["Artifacts", relative(cwd, paths.runDir)],
  ]);
  reporter.blank();
  reporter.step("parsed PR URL");
  reporter.step("loaded config");

  // The review run's outputs are the input here — fail with guidance, not a stack.
  const final = await loadFinalFindings(paths.finalFindings, cwd);
  const reviewedPr = await loadReviewedPr(paths.runMetadata);
  // GitHub owner/repo names are case-insensitive — the same PR typed with
  // different casing must not be rejected as a different one.
  if (
    reviewedPr !== null &&
    (reviewedPr.owner.toLowerCase() !== pr.owner.toLowerCase() ||
      reviewedPr.repo.toLowerCase() !== pr.repo.toLowerCase() ||
      reviewedPr.number !== pr.number)
  ) {
    throw new FixError(
      `The findings in ${relative(cwd, paths.finalFindings)} belong to ` +
        `${reviewedPr.owner}/${reviewedPr.repo}#${reviewedPr.number}, not this PR — ` +
        "run `pr-war-room review` for this PR first.",
    );
  }

  // Recorded first (like review's run_metadata.json) so the fix run exists on
  // disk even if a later stage fails. Deliberately a SEPARATE file: overwriting
  // run_metadata.json would destroy the review run's provenance.
  const metadata = buildRunMetadata({
    command: "fix",
    version: options.version,
    pr,
    prUrl,
    config,
    configSource: source,
    configPath: path,
    cwd,
  });
  await writeJsonArtifact(paths.fix.metadata, metadata);
  reporter.step(`wrote ${relative(paths.root, paths.fix.metadata)}`);

  // patch.diff and fix_verification.json are only written conditionally below,
  // so a previous run's copies must not survive a run that produces neither —
  // a stale patch is exactly what `git apply .ai-review/patch.diff` must never
  // pick up.
  await rm(paths.fix.patch, { force: true });
  await rm(paths.fix.verification, { force: true });

  const { fixable, selected } = selectFixableFindings(final, config.fix.maxFindings);
  reporter.step(
    `selected ${selected.length}/${fixable.length} fixable finding${fixable.length === 1 ? "" : "s"} ` +
      `(${final.length} total, cap ${config.fix.maxFindings})`,
  );

  const writeResults = async (
    outcomes: FixResults["outcomes"],
    patchWritten: boolean,
    workspaceLeftPatched: boolean,
    verification: VerificationResults | null,
    headMoved: boolean,
  ): Promise<void> => {
    const results: FixResults = {
      schemaVersion: 1,
      totalFinalFindings: final.length,
      fixableCount: fixable.length,
      selectedCount: selected.length,
      outcomes,
      patchWritten,
      workspaceLeftPatched,
      generatedAt: new Date().toISOString(),
    };
    await writeJsonArtifact(paths.fix.results, results);
    const report = renderFixReport({
      pr,
      totalFinalFindings: final.length,
      fixableCount: fixable.length,
      maxFindings: config.fix.maxFindings,
      selected,
      outcomes,
      patchWritten,
      workspaceLeftPatched,
      verification,
      headMoved,
      meta: { toolVersion: options.version, generatedAt: metadata.timestamp },
      paths,
    });
    await writeTextArtifact(paths.fix.report, report);
  };

  // Nothing to fix is a SUCCESS, not an error: the report says why and the
  // workspace is never touched.
  if (selected.length === 0) {
    await writeResults([], false, false, null, false);
    reporter.blank();
    reporter.success(
      `No fixable findings (needs_code_change + blocker/should-fix) — see ${artifactLink(paths.fix.report)}`,
    );
    return;
  }

  const changedFiles = await loadChangedFiles(paths.github.changedFiles, cwd);

  const resolveToken =
    options.resolveToken ??
    (async () => {
      try {
        return (await resolveGitHubToken()).token;
      } catch {
        return null;
      }
    });
  const token = await resolveToken();

  // Prefer the exact commit the findings were produced against (offline when
  // the review's checkout is intact); fall back to fetching the PR head.
  const expectedHeadSha = await loadWorkspaceHeadSha(paths.workspace.metadata);
  const workspace = await ensureWorkspace({
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    repoDir: paths.workspace.repo,
    token,
    expectedHeadSha,
    ...(options.gitRunner ? { runner: options.gitRunner } : {}),
  });
  reporter.step(
    workspace.reused ? "reusing the reviewed checkout" : "checked out PR head",
  );
  if (workspace.headMoved) {
    reporter.warn(
      "The PR head moved since the review — findings (and fixes) may be stale. Consider re-running `pr-war-room review`.",
    );
  }
  const repoDir = workspace.repoDir;

  reporter.blank();

  // The whole fix → diff → verify pipeline runs under ONE error boundary so
  // that even an unexpected throw (a) never leaves the workspace dirty in
  // patch-only mode and (b) never exits without fix_results.json /
  // fix_report.md recording the outcomes collected so far.
  let outcomes: FixResults["outcomes"] = [];
  let anyApplied = false;
  let patchWritten = false;
  let verification: VerificationResults | null = null;
  let stageError: unknown = null;
  try {
    ({ outcomes, anyApplied } = await runFixesFn({
      findings: selected,
      repoDir,
      changedFiles,
      config,
      reporter,
    }));

    const patch = await gitDiff(repoDir, options.gitRunner);
    if (patch.trim() !== "") {
      await writeTextArtifact(paths.fix.patch, patch);
      patchWritten = true;
    }

    // `verification` is only set once the artifact is on disk, so the report
    // never links a fix_verification.json that was not written.
    const verified = await runFixVerification({
      config,
      paths,
      cwd,
      repoDir,
      token,
      anyApplied,
      executeVerification,
      ...(options.verify !== undefined ? { verify: options.verify } : {}),
    });
    await writeJsonArtifact(paths.fix.verification, verified);
    verification = verified;
  } catch (err) {
    stageError = err;
  }

  // Patch-only mode must never leave the workspace dirty — even when a stage
  // above threw — or the next review/fix run would see (and silently reset)
  // leftover edits. A restore failure must not MASK the stage error: the root
  // cause is what the user needs.
  if (!apply) {
    try {
      await restoreWorkspace(repoDir, options.gitRunner);
    } catch (err) {
      if (stageError === null) throw err;
      reporter.warn(
        `Failed to restore the workspace checkout: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const workspaceLeftPatched = apply && patchWritten;
  try {
    await writeResults(outcomes, patchWritten, workspaceLeftPatched, verification, workspace.headMoved);
  } catch (err) {
    if (stageError === null) throw err;
    reporter.warn(
      `Failed to write fix results: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (stageError !== null) throw stageError;

  const fixed = outcomes.filter((o) => o.status === "fixed").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;

  reporter.blank();
  reporter.success(
    `${fixed}/${outcomes.length} finding${outcomes.length === 1 ? "" : "s"} fixed` +
      (failed > 0 ? `, ${failed} failed` : "") +
      (skipped > 0 ? `, ${skipped} skipped` : ""),
  );
  if (patchWritten) {
    reporter.success(`patch written — see ${artifactLink(paths.fix.patch)}`);
    reporter.note(
      apply
        ? "Workspace checkout left patched (--apply). Your own working tree was not touched."
        : `Apply to your tree with: git apply ${relative(cwd, paths.fix.patch)}`,
    );
  } else {
    reporter.warn(`no patch produced — see ${artifactLink(paths.fix.report)}`);
  }
  if (verification?.ran) {
    reporter.step("ran verification on the patched workspace", verification.allPassed);
    if (!verification.allPassed) {
      reporter.warn(
        `Some verification commands failed — see ${artifactLink(paths.fix.verification)}`,
      );
    }
  } else {
    reporter.note(`Verification skipped — ${verification?.skipReason ?? "not run"}.`);
  }
  reporter.success(`fix report written — see ${artifactLink(paths.fix.report)}`);
}

interface RunFixVerificationInput {
  config: Config;
  paths: ArtifactPaths;
  cwd: string;
  repoDir: string;
  token: string | null;
  /** Whether any fix was actually applied — verifying an unchanged tree is noise. */
  anyApplied: boolean;
  verify?: boolean;
  executeVerification: ExecuteVerificationFn;
}

/**
 * Post-fix verification sharing `review`'s planning half (`planVerification` —
 * same opt-in gating, same command source) and execution half
 * (`executeVerification`). Returns a full `VerificationResults` record so
 * `fix_verification.json` exists on every run that reaches this stage.
 */
async function runFixVerification(input: RunFixVerificationInput): Promise<VerificationResults> {
  const { config, paths, cwd, repoDir, anyApplied } = input;

  const plan = await planVerification({
    repoDir,
    config,
    ...(input.verify !== undefined ? { verify: input.verify } : {}),
  });

  if (!plan.shouldVerify) {
    return skippedVerification(plan, VERIFICATION_DISABLED_REASON);
  }
  if (!anyApplied) {
    return skippedVerification(plan, "no fixes were applied");
  }

  const executed = await input.executeVerification({
    repoDir,
    logsDir: paths.fix.logsDir,
    cwd,
    installCommand: plan.installCommand,
    commands: plan.commandsToRun,
    timeoutMs: config.verification.timeoutMs,
    secrets: [input.token],
  });
  return { ...plan.shared, ran: true, ...executed };
}
