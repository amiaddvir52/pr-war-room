export interface EvalCommandOptions {
  repo: string;
  prs: number;
  log?: (message: string) => void;
}

/** Stub — implemented in Phase 12. */
export async function runEval(options: EvalCommandOptions): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(message));
  log(
    `pr-war-room eval: not yet implemented (Phase 12). ` +
      `repo=${options.repo} prs=${options.prs}`,
  );
}
