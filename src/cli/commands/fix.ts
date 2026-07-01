import { Reporter } from "../../ui/reporter.js";

export interface FixOptions {
  reporter?: Reporter;
}

/** Stub — implemented in Phase 11. */
export async function runFix(prUrl: string, options: FixOptions = {}): Promise<void> {
  const reporter = options.reporter ?? new Reporter();
  reporter.warn(`fix: not yet implemented (Phase 11). Received: ${prUrl}`);
}
