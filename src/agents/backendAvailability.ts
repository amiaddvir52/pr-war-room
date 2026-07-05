import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ReviewerBackend } from "../config/schema.js";

/**
 * Reviewer-backend availability detection (Phase 6). A backend is "available"
 * when the tool can actually attempt it — the CLI binary is on PATH, or the API
 * credentials are present. When it isn't, the orchestrator records that agent as
 * `skipped` (with the `reason` below) and continues — a visible, benign skip,
 * distinct from a `failed` run that tried and errored.
 *
 * This is what makes the optional, cross-vendor `codex` reviewer safe to ship in
 * the default roster (PRD §10.4, §Phase 6): it is enabled by default but only
 * *runs* when a usable Codex CLI is detected; otherwise it is skipped, not
 * invisible and not a hard failure.
 */
export interface Availability {
  available: boolean;
  /** Why the backend is unavailable (surfaced as the skip reason). */
  reason?: string;
}

/**
 * Probe whether `backend` can be attempted. Injected into `runReviewers` (like
 * `makeClient`) so tests can simulate an available / unavailable backend without
 * touching the real PATH or environment.
 */
export type DetectBackend = (backend: ReviewerBackend) => Promise<Availability>;

/**
 * True when an executable named `bin` is resolvable on PATH (how `which`/`where`
 * work: scan each PATH entry, honoring PATHEXT on Windows). Pure lookup — never
 * spawns the binary, so it can't hang.
 */
export async function commandExists(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const dirs = (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        await access(join(dir, bin + ext), constants.X_OK);
        return true;
      } catch {
        // not here / not executable — keep scanning
      }
    }
  }
  return false;
}

/**
 * The production detector. Only the optional cross-vendor `codex` backend is
 * gated on detection (a PATH probe for the `codex` binary), so its default-roster
 * entry degrades to a clear `skipped` when Codex isn't installed. `claude` and
 * `claude-api` are always reported available so they keep their own, more
 * specific setup-failure paths (the Claude CLI's `codex login`-style help and the
 * Anthropic SDK's `ANTHROPIC_API_KEY` auth help), and `mock` is always available.
 * The seam is backend-general, so gating another backend later is a one-line add.
 */
export const defaultDetectBackend: DetectBackend = async (backend) => {
  if (backend === "codex") {
    return (await commandExists("codex"))
      ? { available: true }
      : { available: false, reason: "codex CLI not found on PATH" };
  }
  return { available: true };
};
