/**
 * Public type surface for Phase-3 workspace prep. Import from here so callers
 * don't reach into module internals.
 */
export type {
  WorkspaceMetadata,
  VerificationResults,
  CommandExecution,
  EnabledSource,
} from "./schema.js";
export type { CommandResult, RunCommandOptions, CommandRunner } from "./runCommand.js";
export type { GitRunner, GitRunResult, PrepareRepoInput, PreparedRepo } from "./git.js";
export type {
  PrepareWorkspaceInput,
  WorkspaceResult,
} from "./prepareWorkspace.js";
