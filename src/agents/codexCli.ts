import { ReviewerError, ReviewerTimeoutError } from "../errors.js";
import { spawnCliRunner } from "./cliRunner.js";
import type { CliRunner } from "./cliRunner.js";
import type { ModelClient, ModelRequest, ModelResult } from "./types.js";

/**
 * A `ModelClient` that drives the OpenAI Codex CLI (`codex`) in non-interactive
 * mode (`codex exec`), reusing the developer's existing `codex login`. This is
 * the second, cross-vendor reviewer backend (PRD §10.4 "Codex Reviewer").
 *
 * Codex is in the default roster but **detection-gated**: the orchestrator
 * probes for the `codex` CLI first and records the agent as `skipped` (never run)
 * when it isn't installed, so a missing Codex is a visible skip rather than a
 * hard failure. If the CLI *is* present but auth/exec fails at run time, the
 * diagnostics below classify it as failed and the run continues — a single
 * `codex` agent never fails the whole review.
 *
 * Unlike `claude -p`, `codex exec` has no `--system-prompt` flag and no
 * structured-output envelope, so we (1) concatenate the system + user prompt and
 * feed it on stdin, and (2) return the raw stdout as the model text. The
 * `Reviewer`'s tolerant JSON extraction pulls the findings object out of Codex's
 * plain-text output, so we don't depend on a machine-readable envelope that
 * could drift between CLI versions.
 */

// Re-exported so a Codex-specific runner can be typed/faked in tests.
export type { CliExecResult, CliRunner } from "./cliRunner.js";

export interface CodexCliOptions {
  /** Binary to invoke. Default `"codex"`. */
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
    `The Codex CLI reviewer failed${suffix}. Codex is optional — make sure the \`codex\` CLI ` +
    "is installed and logged in (`codex login`), or remove/disable the codex-backed agent in " +
    "`agents.reviewers` (.pr-war-room.json). The Claude-backed reviewers run independently."
  );
}

function timeoutHelp(timeoutMs: number): string {
  return (
    `The Codex CLI reviewer timed out after ${timeoutMs}ms without completing. Raise the ` +
    "agent's `timeoutMs`, or disable the codex-backed agent in `agents.reviewers` " +
    "(.pr-war-room.json). The Claude-backed reviewers run independently."
  );
}

function firstLine(s: string): string {
  return s.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

export function createCodexCliModelClient(options: CodexCliOptions = {}): ModelClient {
  const bin = options.bin ?? "codex";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.run ?? spawnCliRunner(bin, timeoutMs);

  return {
    async complete(req: ModelRequest): Promise<ModelResult> {
      // `exec` runs a single non-interactive turn. `--skip-git-repo-check` lets
      // it run outside a trusted git dir; the trailing `-` reads the prompt from
      // stdin (the packet can be large). Codex has no system-prompt flag, so the
      // system + user prompt are concatenated.
      const argv = ["exec", "--skip-git-repo-check"];
      if (options.model) argv.push("--model", options.model);
      argv.push("-");
      const prompt = `${req.system}\n\n${req.user}`;

      const res = await run(argv, prompt);

      if (res.timedOut) {
        throw new ReviewerTimeoutError(timeoutHelp(timeoutMs));
      }
      if (res.spawnError !== null) {
        const detail = /ENOENT/.test(res.spawnError)
          ? "`codex` was not found on PATH"
          : res.spawnError;
        throw new ReviewerError(setupHelp(detail));
      }
      if (res.code !== 0) {
        throw new ReviewerError(setupHelp(firstLine(res.stderr) || `exit code ${res.code}`));
      }

      // Codex prints the assistant's final message (possibly with surrounding
      // log lines) to stdout; the reviewer's tolerant parser extracts the JSON.
      return { text: res.stdout, stopReason: "end_turn" };
    },
  };
}
