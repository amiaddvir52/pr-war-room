import type { Config } from "../config/types.js";
import { detectPackageManager, detectProjectTypes } from "../context/detectProjectType.js";
import { detectVerificationCommands } from "../context/detectVerificationCommands.js";
import type { EnabledSource, VerificationResults, WorkspaceMetadata } from "./schema.js";

/**
 * The verification PLANNING half shared by `review` (via `prepareWorkspace`)
 * and `fix` (post-fix re-verification): detect the project, derive whether
 * verification should run and why, and pick the commands. Extracted so the
 * gating rules, the configured-vs-detected precedence, and the skip wording
 * cannot drift between the two commands — `executeVerification.ts` is the
 * matching shared EXECUTION half.
 */

export const VERIFICATION_DISABLED_REASON =
  "verification disabled (pass --verify or set verification.enabled=true)";

export interface VerificationPlanInput {
  /** The checkout to detect against (and that the commands would run in). */
  repoDir: string;
  config: Config;
  /** `--verify` flag; when set it overrides `config.verification.enabled`. */
  verify?: boolean;
}

export interface VerificationPlan {
  projectTypes: WorkspaceMetadata["projectTypes"];
  packageManager: WorkspaceMetadata["packageManager"];
  detected: { install: string | null; commands: string[] };
  shouldVerify: boolean;
  enabledSource: EnabledSource;
  /** Configured commands when present, else the detected ones. */
  commandsToRun: string[];
  installCommand: string | null;
  /** The planning fields every `VerificationResults` record starts from. */
  shared: {
    schemaVersion: 1;
    enabled: boolean;
    enabledSource: EnabledSource;
    detectedCommands: string[];
    configuredCommands: string[];
    installCommand: string | null;
  };
}

export async function planVerification(input: VerificationPlanInput): Promise<VerificationPlan> {
  const { repoDir, config } = input;

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

  return {
    projectTypes,
    packageManager,
    detected: { install: detected.install, commands: detected.commands },
    shouldVerify,
    enabledSource,
    commandsToRun,
    installCommand,
    shared: {
      schemaVersion: 1,
      enabled: shouldVerify,
      enabledSource,
      detectedCommands,
      configuredCommands,
      installCommand,
    },
  };
}

/** A full not-run `VerificationResults` record for `plan`, with the given reason. */
export function skippedVerification(
  plan: VerificationPlan,
  skipReason: string,
): VerificationResults {
  return {
    ...plan.shared,
    ran: false,
    skipReason,
    executedCommands: [],
    skippedCommands: plan.commandsToRun,
    install: null,
    results: [],
    allPassed: true,
    startedAt: null,
    finishedAt: null,
  };
}
