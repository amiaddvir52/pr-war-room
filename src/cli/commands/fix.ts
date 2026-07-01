export interface FixOptions {
  log?: (message: string) => void;
}

/** Stub — implemented in Phase 11. */
export async function runFix(prUrl: string, options: FixOptions = {}): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(message));
  log(`pr-war-room fix: not yet implemented (Phase 11). Received: ${prUrl}`);
}
