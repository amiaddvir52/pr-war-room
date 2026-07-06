import { join, relative } from "node:path";
import { writeTextArtifact } from "../storage/writeArtifact.js";
import { runCommand, type CommandResult, type CommandRunner } from "./runCommand.js";
import { redactSecrets } from "./redact.js";
import type { CommandExecution } from "./schema.js";

/**
 * The verification-execution core, extracted from `prepareWorkspace` so fix
 * mode (Phase 11) can re-verify the patched workspace with identical semantics:
 * install first, then every command sequentially (all of them, even after a
 * failure, so every issue is reported), each shaped into a redacted
 * `CommandExecution` with its full log on disk.
 */

const PREVIEW_LIMIT = 2000;

export interface ExecuteVerificationInput {
  /** The checkout the commands run in. */
  repoDir: string;
  /** Where the full per-command logs are written. */
  logsDir: string;
  /** Base dir log paths are made relative to (the `.ai-review/` root's parent). */
  cwd: string;
  /** Dependency-install command, or null to skip the install step. */
  installCommand: string | null;
  /** Verification commands, run in order. */
  commands: string[];
  /** Per-command timeout (applies to install and each command). */
  timeoutMs: number;
  /** Values to redact from every captured output (e.g. the GitHub token). */
  secrets: ReadonlyArray<string | null | undefined>;
  cmdRunner?: CommandRunner;
}

/** Everything `VerificationResults` needs beyond the planning fields. */
export interface ExecutedVerification {
  install: CommandExecution | null;
  results: CommandExecution[];
  executedCommands: string[];
  skippedCommands: string[];
  skipReason: string | null;
  allPassed: boolean;
  startedAt: string;
  finishedAt: string;
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

export async function executeVerification(
  input: ExecuteVerificationInput,
): Promise<ExecutedVerification> {
  const { repoDir, logsDir, cwd, installCommand, commands, timeoutMs, secrets } = input;
  const cmdRunner = input.cmdRunner ?? runCommand;

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
    skippedCommands = commands;
    skipReason = "dependency install failed";
  } else {
    for (const command of commands) {
      // Sequential: clearer logs and avoids resource contention. All commands
      // run even if an earlier one fails, so every issue is reported.
      const raw = await cmdRunner(command, { cwd: repoDir, timeoutMs });
      results.push(await toExecution(raw, index++, logsDir, cwd, secrets));
    }
    executedCommands = commands;
  }

  return {
    install,
    results,
    executedCommands,
    skippedCommands,
    skipReason,
    allPassed: !installFailed && results.every((r) => r.passed),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
