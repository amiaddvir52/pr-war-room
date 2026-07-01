import { spawn } from "node:child_process";

/**
 * The reusable command-execution primitive for Phase 3+ (verification, install,
 * and — later — fix-mode re-verification). Commands are run through the shell so
 * full config/detected strings work verbatim (`pnpm run lint`, `go test ./...`).
 *
 * It NEVER throws for a non-zero exit or a timeout: a failing verification
 * command is data, not an error (PRD §12 Phase 3: "does not crash. It records
 * the failure."). The only non-resolving path is a spawn failure, captured in
 * `spawnError`. Captured output is bounded in memory; callers get the total byte
 * count and a truncation flag so they can shape previews / log files.
 */

/** Max bytes retained per stream. Total byte counts are still reported in full. */
const CAPTURE_CAP_BYTES = 1_048_576; // 1 MiB
const DEFAULT_TIMEOUT_MS = 600_000;

export interface CommandResult {
  command: string;
  cwd: string;
  /** Process exit code, or null if killed by a signal (e.g. timeout) or never spawned. */
  exitCode: number | null;
  /** Captured stdout, up to the retention cap. */
  stdout: string;
  /** Captured stderr, up to the retention cap. */
  stderr: string;
  /** Total stdout bytes produced (may exceed the retained text). */
  stdoutBytes: number;
  /** Total stderr bytes produced. */
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
  /** Set when the process could not be spawned at all (e.g. cwd missing). */
  spawnError: string | null;
}

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  /** Extra env vars merged onto the current process env. */
  env?: NodeJS.ProcessEnv;
}

/** Injectable seam: tests pass a fake runner instead of spawning real processes. */
export type CommandRunner = (
  command: string,
  options: RunCommandOptions,
) => Promise<CommandResult>;

interface StreamCapture {
  chunks: Buffer[];
  retained: number;
  total: number;
}

function newCapture(): StreamCapture {
  return { chunks: [], retained: 0, total: 0 };
}

function capture(state: StreamCapture, chunk: Buffer): void {
  state.total += chunk.length;
  if (state.retained >= CAPTURE_CAP_BYTES) return;
  const room = CAPTURE_CAP_BYTES - state.retained;
  const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
  state.chunks.push(slice);
  state.retained += slice.length;
}

export const runCommand: CommandRunner = (command, options) => {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env } = options;
  const start = Date.now();

  return new Promise<CommandResult>((resolve) => {
    const out = newCapture();
    const err = newCapture();
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        command,
        cwd,
        exitCode,
        stdout: Buffer.concat(out.chunks).toString("utf8"),
        stderr: Buffer.concat(err.chunks).toString("utf8"),
        stdoutBytes: out.total,
        stderrBytes: err.total,
        stdoutTruncated: out.total > out.retained,
        stderrTruncated: err.total > err.retained,
        durationMs: Date.now() - start,
        timedOut,
        spawnError,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
    } catch (spawnErr) {
      // Synchronous spawn failure (e.g. invalid options) — still never throw.
      finish(null, (spawnErr as Error).message);
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // A pending command must not keep the process alive on its own.
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => capture(out, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(err, chunk));
    child.on("error", (e: Error) => finish(null, e.message));
    child.on("close", (code) => finish(code, null));
  });
};
