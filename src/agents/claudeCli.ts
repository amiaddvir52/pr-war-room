import { spawn } from "node:child_process";
import { ReviewerError } from "../errors.js";
import type { ModelClient, ModelRequest, ModelResult } from "./types.js";

/**
 * A `ModelClient` that drives the locally-installed Claude Code CLI (`claude`)
 * in non-interactive print mode, reusing the developer's existing `claude login`
 * — no `ANTHROPIC_API_KEY` and no separate API billing. This is the default
 * reviewer backend (PRD §10.4 "Claude Reviewer"; §Phase 5: the adapter "may call
 * a local command …").
 *
 * The CLI has no structured-output enforcement, so the prompt asks for a JSON
 * object and `ClaudeReviewer` validates it (with a parse-failure path). For the
 * schema-guaranteed API path instead, use `models.primaryReviewer: "claude-api"`.
 */

export interface CliExecResult {
  /** Process exit code, or null if killed (timeout/signal) or never spawned. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process couldn't be spawned (e.g. `claude` not on PATH). */
  spawnError: string | null;
  /** True when the process was killed because it exceeded the per-call timeout. */
  timedOut: boolean;
}

/** Injectable seam: tests pass a fake runner instead of spawning `claude`. */
export type CliRunner = (argv: string[], stdin: string) => Promise<CliExecResult>;

export interface ClaudeCliOptions {
  /** Binary to invoke. Default `"claude"`. */
  bin?: string;
  /** Optional `--model` override. Default: the CLI's own configured model. */
  model?: string;
  /** Per-call timeout in ms. Default 300000. */
  timeoutMs?: number;
  /** Injected in tests. Default spawns the real CLI. */
  run?: CliRunner;
}

const DEFAULT_TIMEOUT_MS = 300_000;

function setupHelp(detail: string): string {
  const suffix = detail ? ` (${detail})` : "";
  return (
    `The Claude CLI reviewer failed${suffix}. Make sure the \`claude\` CLI is installed ` +
    "and logged in (run `claude login`). Alternatively set models.primaryReviewer to " +
    '"claude-api" (uses the Anthropic API; needs ANTHROPIC_API_KEY) or "mock" (offline) ' +
    "in .pr-war-room.json."
  );
}

function timeoutHelp(timeoutMs: number): string {
  return (
    `The Claude CLI reviewer timed out after ${timeoutMs}ms without completing. The review ` +
    "packet may be large or the model slow. Raise the timeout, or set models.primaryReviewer " +
    'to "claude-api" (Anthropic API; needs ANTHROPIC_API_KEY) or "mock" (offline) in ' +
    ".pr-war-room.json."
  );
}

function firstLine(s: string): string {
  return s.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function spawnRunner(bin: string, timeoutMs: number): CliRunner {
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

      // Feed the prompt on stdin (the packet can be large — avoids arg limits).
      child.stdin?.on("error", () => {}); // ignore EPIPE if the CLI closes stdin early
      child.stdin?.end(stdin);
    });
}

/**
 * Pull the assistant text out of the `claude --output-format json` envelope.
 * Returns null when the parsed value carries no string `result`, so the caller
 * can fall back to the raw stdout.
 */
function resultText(envelope: unknown): string | null {
  if (envelope && typeof envelope === "object" && "result" in envelope) {
    const r = (envelope as { result: unknown }).result;
    if (typeof r === "string") return r;
  }
  return null;
}

function envelopeIsError(envelope: unknown): boolean {
  return (
    typeof envelope === "object" &&
    envelope !== null &&
    "is_error" in envelope &&
    (envelope as { is_error: unknown }).is_error === true
  );
}

/** Read a string-valued property from a parsed envelope, or null. */
function readString(envelope: unknown, key: string): string | null {
  if (envelope && typeof envelope === "object" && key in envelope) {
    const value = (envelope as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Map the `claude --output-format json` result envelope to a reviewer
 * `stopReason`, so `ClaudeReviewer`'s benign-outcome handling (truncation,
 * backend error) works on the default CLI backend and not just the API path.
 * Precedence:
 *   1. An explicit model `stop_reason` (`max_tokens` / `refusal` / `end_turn`),
 *      if a CLI version surfaces one — forward-compatible.
 *   2. The CLI's own `subtype`: `error_max_turns` is a truncated / limit-hit turn
 *      (→ `max_tokens`, so the reviewer reports a truncation, not "invalid JSON");
 *      `error_during_execution` is a backend error.
 *   3. `is_error: true` → a backend error.
 * Anything else is a normal `end_turn`.
 */
function cliStopReason(envelope: unknown): string {
  const explicit = readString(envelope, "stop_reason");
  if (explicit === "max_tokens" || explicit === "refusal" || explicit === "end_turn") {
    return explicit;
  }
  const subtype = readString(envelope, "subtype");
  if (subtype === "error_max_turns") return "max_tokens";
  if (envelopeIsError(envelope) || subtype === "error_during_execution") return "error";
  return "end_turn";
}

export function createClaudeCliModelClient(options: ClaudeCliOptions = {}): ModelClient {
  const bin = options.bin ?? "claude";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.run ?? spawnRunner(bin, timeoutMs);

  return {
    async complete(req: ModelRequest): Promise<ModelResult> {
      // `-p` prints and exits; `--system-prompt` replaces the default agent
      // persona with our reviewer prompt; the packet goes on stdin.
      const argv = ["-p", "--output-format", "json", "--system-prompt", req.system];
      if (options.model) argv.push("--model", options.model);

      const res = await run(argv, req.user);

      // A timeout kill lands here as a null exit code — surface it as a timeout,
      // not the install/login-oriented "exit code null" setup error.
      if (res.timedOut) {
        throw new ReviewerError(timeoutHelp(timeoutMs));
      }
      if (res.spawnError !== null) {
        const detail = /ENOENT/.test(res.spawnError)
          ? "`claude` was not found on PATH"
          : res.spawnError;
        throw new ReviewerError(setupHelp(detail));
      }
      if (res.code !== 0) {
        throw new ReviewerError(setupHelp(firstLine(res.stderr) || `exit code ${res.code}`));
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(res.stdout);
      } catch {
        // Not JSON at all — hand the raw stdout to the parser upstream.
        return { text: res.stdout, stopReason: "end_turn" };
      }
      // Prefer the envelope's `result`; if absent, fall back to the raw stdout
      // so the upstream parser (or the reviewer's error branch) can still use it.
      const extracted = resultText(envelope);
      return {
        text: extracted ?? res.stdout,
        stopReason: cliStopReason(envelope),
      };
    },
  };
}
