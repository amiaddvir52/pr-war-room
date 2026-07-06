import { relative } from "node:path";
import type { ParsedPr } from "../github/parsePrUrl.js";
import type { Config } from "../config/types.js";
import type { ArtifactPaths } from "../storage/artifactPaths.js";
import { writeJsonArtifact } from "../storage/writeArtifact.js";
import { resolveGitHubToken } from "../github/auth.js";
import type { CommandRunner } from "./runCommand.js";
import { executeVerification } from "./executeVerification.js";
import { prepareRepo, type GitRunner } from "./git.js";
import {
  planVerification,
  skippedVerification,
  VERIFICATION_DISABLED_REASON,
} from "./verificationPlan.js";
import type { VerificationResults, WorkspaceMetadata } from "./schema.js";

/**
 * Phase 3 orchestrator: check out the PR locally, detect the project type /
 * package manager / verification commands, optionally run verification, and
 * write the two Phase-3 artifacts. The returned result is what the Phase-4
 * review-packet builder consumes.
 *
 * All external effects (git, subprocesses, token resolution) are injectable so
 * the whole flow is testable without a network or real processes.
 */

export interface PrepareWorkspaceInput {
  pr: ParsedPr;
  config: Config;
  paths: ArtifactPaths;
  /** Base dir the `.ai-review/` tree is rooted in (for relative paths in metadata). */
  cwd: string;
  /** `--verify` flag; when set it overrides `config.verification.enabled`. */
  verify?: boolean;
  /** Explicit token (mainly for tests); when omitted, resolved from env/gh (null on failure). */
  token?: string | null;
  gitRunner?: GitRunner;
  cmdRunner?: CommandRunner;
  resolveToken?: () => Promise<string | null>;
}

export interface WorkspaceResult {
  metadata: WorkspaceMetadata;
  verification: VerificationResults;
}

export async function prepareWorkspace(input: PrepareWorkspaceInput): Promise<WorkspaceResult> {
  const { pr, config, paths, cwd } = input;
  const timeoutMs = config.verification.timeoutMs;

  const resolveToken =
    input.resolveToken ??
    (async () => {
      try {
        return (await resolveGitHubToken()).token;
      } catch {
        // No token → clone/fetch unauthenticated (works for public repos).
        return null;
      }
    });
  const token = input.token !== undefined ? input.token : await resolveToken();

  const prepared = await prepareRepo({
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    repoDir: paths.workspace.repo,
    token,
    ...(input.gitRunner ? { runner: input.gitRunner } : {}),
  });

  const repoDir = prepared.repoDir;
  const plan = await planVerification({
    repoDir,
    config,
    ...(input.verify !== undefined ? { verify: input.verify } : {}),
  });

  const metadata: WorkspaceMetadata = {
    schemaVersion: 1,
    repoDir: relative(cwd, repoDir) || ".",
    remote: prepared.remote,
    ref: prepared.ref,
    headSha: prepared.headSha,
    reused: prepared.reused,
    projectTypes: plan.projectTypes,
    packageManager: plan.packageManager,
    detected: plan.detected,
    verification: {
      enabled: plan.shouldVerify,
      enabledSource: plan.enabledSource,
      installPlanned: plan.installCommand,
      commandsPlanned: plan.commandsToRun,
    },
    preparedAt: new Date().toISOString(),
  };

  let verification: VerificationResults;
  if (!plan.shouldVerify) {
    verification = skippedVerification(plan, VERIFICATION_DISABLED_REASON);
  } else {
    const executed = await executeVerification({
      repoDir,
      logsDir: paths.verification.logsDir,
      cwd,
      installCommand: plan.installCommand,
      commands: plan.commandsToRun,
      timeoutMs,
      secrets: [token],
      ...(input.cmdRunner ? { cmdRunner: input.cmdRunner } : {}),
    });
    verification = { ...plan.shared, ran: true, ...executed };
  }

  await writeJsonArtifact(paths.workspace.metadata, metadata);
  await writeJsonArtifact(paths.verification.initial, verification);

  return { metadata, verification };
}
