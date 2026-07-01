import type { Config } from "./config/types.js";
import type { ParsedPr } from "./github/parsePrUrl.js";

export type CommandName = "review" | "fix" | "eval";

/**
 * Snapshot written to `.ai-review/run_metadata.json` on every run. `phase` is a
 * schema-version marker so later phases (e.g. the report reader) can assert the
 * shape they expect; bump it whenever this structure changes.
 */
export interface RunMetadata {
  tool: { name: "pr-war-room"; version: string };
  command: CommandName;
  timestamp: string;
  pr: ParsedPr | null;
  prUrl: string | null;
  config: Config;
  configSource: "default" | "file";
  configPath: string | null;
  cwd: string;
  phase: 1;
}

export interface BuildRunMetadataInput {
  command: CommandName;
  version: string;
  pr: ParsedPr | null;
  prUrl: string | null;
  config: Config;
  configSource: "default" | "file";
  configPath: string | null;
  cwd: string;
}

export function buildRunMetadata(input: BuildRunMetadataInput): RunMetadata {
  return {
    tool: { name: "pr-war-room", version: input.version },
    command: input.command,
    timestamp: new Date().toISOString(),
    pr: input.pr,
    prUrl: input.prUrl,
    config: input.config,
    configSource: input.configSource,
    configPath: input.configPath,
    cwd: input.cwd,
    phase: 1,
  };
}
