import { spawn } from "node:child_process";

/**
 * Shared subprocess plumbing for CLI-backed model clients (`claudeCli`,
 * `codexCli`). Spawns a binary with an argv array, feeds the prompt on stdin
 * (the packet can be large — avoids arg-length limits), captures stdout/stderr,
 * and enforces a hard timeout by SIGKILL. The result is a plain data record so
 * each adapter can map exit codes / envelopes to a `ModelResult` its own way.
 */

export interface CliExecResult {
  /** Process exit code, or null if killed (timeout/signal) or never spawned. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process couldn't be spawned (e.g. the binary is not on PATH). */
  spawnError: string | null;
  /** True when the process was killed because it exceeded the per-call timeout. */
  timedOut: boolean;
}

/** Injectable seam: tests pass a fake runner instead of spawning a real CLI. */
export type CliRunner = (argv: string[], stdin: string) => Promise<CliExecResult>;

/** A runner that spawns `bin` and kills it after `timeoutMs`. */
export function spawnCliRunner(bin: string, timeoutMs: number): CliRunner {
  return (argv, stdin) =>
    new Promise<CliExecResult>((resolve) => {
      let out = "";
      let err = "";
      let settled = false;
      let timedOut = false;
      const finish = (r: CliExecResult): void => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(bin, argv, { windowsHide: true });
      } catch (e) {
        finish({ code: null, stdout: "", stderr: "", spawnError: (e as Error).message, timedOut });
        return;
      }

      // Flag the timeout before killing so `close` (which fires with a null code
      // on SIGKILL, indistinguishable from a genuine crash) can be reported as a
      // timeout rather than a misleading "exit code null".
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      child.stderr?.on("data", (c: Buffer) => {
        err += c.toString("utf8");
      });
      child.on("error", (e: Error) => {
        clearTimeout(timer);
        finish({ code: null, stdout: out, stderr: err, spawnError: e.message, timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish({ code, stdout: out, stderr: err, spawnError: null, timedOut });
      });

      // Feed the prompt on stdin.
      child.stdin?.on("error", () => {}); // ignore EPIPE if the CLI closes stdin early
      child.stdin?.end(stdin);
    });
}
