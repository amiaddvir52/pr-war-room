import type { PackageManager, ProjectType } from "../context/types.js";

/**
 * Persisted Phase-3 artifact contracts. Unlike the GitHub schemas (which parse
 * untrusted API payloads with zod), these describe data WE produce, so they are
 * plain typed interfaces. `schemaVersion` is a stable version marker every later
 * phase can assert on; bump it if a shape changes incompatibly. These are the
 * stable shapes the Phase-4 review packet reads.
 */

/** `.ai-review/runs/<run_id>/workspace_metadata.json` (run-scoped; the checkout itself is shared) */
export interface WorkspaceMetadata {
  schemaVersion: 1;
  /** Repo checkout location, relative to the run's base dir. */
  repoDir: string;
  /** Sanitized remote URL — never contains the auth token. */
  remote: string;
  /** The ref that was fetched, e.g. `pull/123/head`. */
  ref: string;
  headSha: string;
  /** True when an existing checkout was reused (fetched + reset) rather than freshly cloned. */
  reused: boolean;
  projectTypes: ProjectType[];
  packageManager: PackageManager | null;
  /** What detection suggested (independent of whether it ran). */
  detected: { install: string | null; commands: string[] };
  /** What verification is configured to do this run. */
  verification: {
    enabled: boolean;
    enabledSource: EnabledSource;
    installPlanned: string | null;
    commandsPlanned: string[];
  };
  preparedAt: string;
}

/** How the enabled/disabled decision for verification was reached. */
export type EnabledSource = "flag" | "config" | "default";

/** A single command that was run, shaped for the artifact (previews + log pointer). */
export interface CommandExecution {
  command: string;
  exitCode: number | null;
  /** exitCode === 0 and neither timed out nor failed to spawn. */
  passed: boolean;
  durationMs: number;
  timedOut: boolean;
  spawnError: string | null;
  /** Short, redacted inline preview (head+tail) of stdout. */
  stdoutPreview: string;
  /** Short, redacted inline preview of stderr. */
  stderrPreview: string;
  /** Total bytes produced (the full, redacted, capped output lives in `logFile`). */
  stdoutBytes: number;
  stderrBytes: number;
  /** Relative path to the full redacted log, or null when there was no output. */
  logFile: string | null;
}

/** `.ai-review/verification/initial_verification.json` */
export interface VerificationResults {
  schemaVersion: 1;
  /** Whether verification was enabled this run. */
  enabled: boolean;
  /** Whether enablement came from the `--verify` flag, config, or the default. */
  enabledSource: EnabledSource;
  /** Whether verification commands actually executed. */
  ran: boolean;
  /** Why verification did not run, or why commands were skipped (null when everything ran). */
  skipReason: string | null;
  /** Commands detection suggested for this repo. */
  detectedCommands: string[];
  /** Commands supplied via config (override detection when non-empty). */
  configuredCommands: string[];
  /** The dependency-install command, if any was planned. */
  installCommand: string | null;
  /** Commands that actually ran, in order. */
  executedCommands: string[];
  /** Commands that were planned but not run (verification disabled, or install failed). */
  skippedCommands: string[];
  /** The dependency-install result, if an install step ran. */
  install: CommandExecution | null;
  /** One result per executed verification command, in run order. */
  results: CommandExecution[];
  /** True when the install (if any) and every executed command passed, and nothing was skipped. */
  allPassed: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}
