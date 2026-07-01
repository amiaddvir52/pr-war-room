import { join, relative } from "node:path";
import type { ParsedPr } from "../github/parsePrUrl.js";
import type { Config } from "../config/types.js";
import type { ArtifactPaths } from "../storage/artifactPaths.js";
import { writeJsonArtifact, writeTextArtifact } from "../storage/writeArtifact.js";
import { resolveGitHubToken } from "../github/auth.js";
import { detectPackageManager, detectProjectTypes } from "../context/detectProjectType.js";
import { detectVerificationCommands } from "../context/detectVerificationCommands.js";
import { runCommand, type CommandResult, type CommandRunner } from "./runCommand.js";
import { prepareRepo, type GitRunner } from "./git.js";
import { redactSecrets } from "./redact.js";
import type {
  CommandExecution,
  EnabledSource,
  VerificationResults,
  WorkspaceMetadata,
} from "./schema.js";

/**
 * Phase 3 orchestrator: check out the PR locally, detect the project type /
 * package manager / verification commands, optionally run verification, and
 * write the two Phase-3 artifacts. The returned result is what the Phase-4
 * review-packet builder consumes.
 *
 * All external effects (git, subprocesses, token resolution) are injectable so
 * the whole flow is testable without a network or real processes.
 */

const PREVIEW_LIMIT = 2000;

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

/** Head+tail preview so both what ran and how it ended survive truncation. */
function preview(text: string): string {
  if (text.length <= PREVIEW_LIMIT) return text;
  const half = Math.floor(PREVIEW_LIMIT / 2);
  return `${text.slice(0, half)}\n…[${text.length - PREVIEW_LIMIT} chars omitted]…\n${text.slice(-half)}`;
}

function slug(command: string): string {
  return (
    command
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "cmd"
  );
}

/** Shape a raw command result for the artifact: redact, preview, and store the full log. */
async function toExecution(
  raw: CommandResult,
  index: number,
  logsDir: string,
  cwd: string,
  secrets: ReadonlyArray<string | null | undefined>,
): Promise<CommandExecution> {
  const stdout = redactSecrets(raw.stdout, secrets);
  const stderr = redactSecrets(raw.stderr, secrets);
  const spawnError = raw.spawnError ? redactSecrets(raw.spawnError, secrets) : null;

  let logFile: string | null = null;
  if (stdout.length > 0 || stderr.length > 0 || spawnError !== null) {
    const file = join(logsDir, `${String(index).padStart(2, "0")}-${slug(raw.command)}.log`);
    const truncated = raw.stdoutTruncated || raw.stderrTruncated;
    const body = [
      `$ ${raw.command}`,
      `exit: ${raw.exitCode}${raw.timedOut ? " (timed out)" : ""}${spawnError ? ` (spawn error: ${spawnError})` : ""}`,
      `duration: ${raw.durationMs}ms`,
      "",
      "----- stdout -----",
      stdout,
      "----- stderr -----",
      stderr,
      truncated ? "\n[output truncated to 1 MiB per stream]" : "",
    ].join("\n");
    await writeTextArtifact(file, body);
    logFile = relative(cwd, file);
  }

  return {
    command: raw.command,
    exitCode: raw.exitCode,
    passed: raw.exitCode === 0 && !raw.timedOut && raw.spawnError === null,
    durationMs: raw.durationMs,
    timedOut: raw.timedOut,
    spawnError,
    stdoutPreview: preview(stdout),
    stderrPreview: preview(stderr),
    stdoutBytes: raw.stdoutBytes,
    stderrBytes: raw.stderrBytes,
    logFile,
  };
}

export async function prepareWorkspace(input: PrepareWorkspaceInput): Promise<WorkspaceResult> {
  const { pr, config, paths, cwd } = input;
  const cmdRunner = input.cmdRunner ?? runCommand;
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
  const projectTypes = await detectProjectTypes(repoDir);
  const packageManager = await detectPackageManager(repoDir);
  const detected = await detectVerificationCommands({ repoDir, projectTypes, packageManager });

  const shouldVerify = input.verify ?? config.verification.enabled;
  const enabledSource: EnabledSource =
    input.verify !== undefined ? "flag" : config.verification.enabled ? "config" : "default";

  const detectedCommands = detected.commands;
  const configuredCommands = config.verification.commands;
  const commandsToRun = configuredCommands.length > 0 ? configuredCommands : detectedCommands;
  const installCommand = config.verification.installDeps ? detected.install : null;

  const metadata: WorkspaceMetadata = {
    schemaVersion: 1,
    repoDir: relative(cwd, repoDir) || ".",
    remote: prepared.remote,
    ref: prepared.ref,
    headSha: prepared.headSha,
    reused: prepared.reused,
    projectTypes,
    packageManager,
    detected: { install: detected.install, commands: detected.commands },
    verification: {
      enabled: shouldVerify,
      enabledSource,
      installPlanned: installCommand,
      commandsPlanned: commandsToRun,
    },
    preparedAt: new Date().toISOString(),
  };

  const shared = {
    schemaVersion: 1 as const,
    enabled: shouldVerify,
    enabledSource,
    detectedCommands,
    configuredCommands,
    installCommand,
  };

  let verification: VerificationResults;
  if (!shouldVerify) {
    verification = {
      ...shared,
      ran: false,
      skipReason: "verification disabled (pass --verify or set verification.enabled=true)",
      executedCommands: [],
      skippedCommands: commandsToRun,
      install: null,
      results: [],
      allPassed: true,
      startedAt: null,
      finishedAt: null,
    };
  } else {
    const secrets: ReadonlyArray<string | null | undefined> = [token];
    const logsDir = paths.verification.logsDir;
    const startedAt = new Date().toISOString();
    let index = 0;

    let install: CommandExecution | null = null;
    if (installCommand) {
      const raw = await cmdRunner(installCommand, { cwd: repoDir, timeoutMs });
      install = await toExecution(raw, index++, logsDir, cwd, secrets);
    }
    const installFailed = install !== null && !install.passed;

    const results: CommandExecution[] = [];
    let executedCommands: string[] = [];
    let skippedCommands: string[] = [];
    let skipReason: string | null = null;

    if (installFailed) {
      // Running tests/lint without dependencies is noise — skip and say why.
      skippedCommands = commandsToRun;
      skipReason = "dependency install failed";
    } else {
      for (const command of commandsToRun) {
        // Sequential: clearer logs and avoids resource contention. All commands
        // run even if an earlier one fails, so every issue is reported.
        const raw = await cmdRunner(command, { cwd: repoDir, timeoutMs });
        results.push(await toExecution(raw, index++, logsDir, cwd, secrets));
      }
      executedCommands = commandsToRun;
    }

    verification = {
      ...shared,
      ran: true,
      skipReason,
      executedCommands,
      skippedCommands,
      install,
      results,
      allPassed: !installFailed && results.every((r) => r.passed),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  await writeJsonArtifact(paths.workspace.metadata, metadata);
  await writeJsonArtifact(paths.verification.initial, verification);

  return { metadata, verification };
}
