import { Reporter } from "../../ui/reporter.js";

export interface EvalCommandOptions {
  repo: string;
  prs: number;
  reporter?: Reporter;
}

/** Stub — implemented in Phase 12. */
export async function runEval(options: EvalCommandOptions): Promise<void> {
  const reporter = options.reporter ?? new Reporter();
  reporter.warn(
    `eval: not yet implemented (Phase 12). repo=${options.repo} prs=${options.prs}`,
  );
}
