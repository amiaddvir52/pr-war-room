import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceError } from "../errors.js";
import { exists } from "../context/fsProbe.js";

/**
 * Git operations for Phase-3 workspace prep. We fetch the PR merge head via
 * `pull/<n>/head` (fork-safe — no head-branch name or fork remote needed) into a
 * shallow checkout under `.ai-review/workspace/repo`.
 *
 * Auth: the token is used transiently as an explicit fetch URL argument and is
 * NEVER persisted to `.git/config` (origin is set to the sanitized URL) and
 * NEVER surfaced in error messages (see `redactToken`).
 */

const execFileAsync = promisify(execFile);

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

/** Injectable seam: tests pass a fake runner instead of invoking real git. */
export type GitRunner = (args: string[]) => Promise<GitRunResult>;

const defaultGitRunner: GitRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync("git", args, {
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

export interface PrepareRepoInput {
  owner: string;
  repo: string;
  number: number;
  /** Absolute path to the checkout directory (`paths.workspace.repo`). */
  repoDir: string;
  /** GitHub token for private repos; null clones/fetches unauthenticated. */
  token: string | null;
  runner?: GitRunner;
}

export interface PreparedRepo {
  repoDir: string;
  /** Sanitized (token-free) remote URL. */
  remote: string;
  /** The fetched ref, e.g. `pull/123/head`. */
  ref: string;
  headSha: string;
  reused: boolean;
}

function redactToken(text: string, token: string | null): string {
  return token ? text.split(token).join("***") : text;
}

/** Turn a raw git failure into an actionable, token-free WorkspaceError. */
function toWorkspaceError(err: unknown, token: string | null): WorkspaceError {
  const e = err as { code?: string; stderr?: unknown; message?: string };
  if (e?.code === "ENOENT") {
    return new WorkspaceError("git is not installed or not on PATH. Install git and re-run.");
  }
  const stderr = redactToken(String(e?.stderr ?? e?.message ?? ""), token);
  const lower = stderr.toLowerCase();
  let hint = "";
  if (lower.includes("authentication") || lower.includes("could not read username") || lower.includes("403")) {
    hint = " Check GITHUB_TOKEN / gh auth for access to this repository.";
  } else if (lower.includes("not found") || lower.includes("404") || lower.includes("couldn't find remote ref")) {
    hint = " Verify the repository and PR number exist and are accessible.";
  }
  return new WorkspaceError(`git operation failed.${hint}\n${stderr}`.trimEnd());
}

async function ensureRepoInit(
  runner: GitRunner,
  repoDir: string,
  sanitizedRemote: string,
): Promise<boolean> {
  if (await exists(join(repoDir, ".git"))) {
    // Idempotently point origin at the sanitized URL (add it if absent).
    try {
      await runner(["-C", repoDir, "remote", "set-url", "origin", sanitizedRemote]);
    } catch {
      await runner(["-C", repoDir, "remote", "add", "origin", sanitizedRemote]);
    }
    return true;
  }
  await mkdir(repoDir, { recursive: true });
  await runner(["init", "-q", repoDir]);
  await runner(["-C", repoDir, "remote", "add", "origin", sanitizedRemote]);
  return false;
}

/**
 * Clone (or reuse) the repo and check out the PR head. Shallow — only the PR
 * ref is fetched. Throws `WorkspaceError` (exit 5) on any git failure.
 */
export async function prepareRepo(input: PrepareRepoInput): Promise<PreparedRepo> {
  const { owner, repo, number, repoDir } = input;
  const token = input.token;
  const runner = input.runner ?? defaultGitRunner;

  const ref = `pull/${number}/head`;
  const sanitizedRemote = `https://github.com/${owner}/${repo}.git`;
  const authRemote = token
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : sanitizedRemote;
  const localBranch = `pr-${number}`;

  try {
    const reused = await ensureRepoInit(runner, repoDir, sanitizedRemote);
    // Fetch from the explicit (possibly tokenized) URL so the token is not
    // persisted in origin. `--force` lets a reused checkout re-point the ref.
    await runner(["-C", repoDir, "fetch", "--depth", "1", "--force", authRemote, ref]);
    // Always land on a clean checkout of the PR head — critical when reusing an
    // existing workspace that a prior run (or verification) left dirty:
    //   • checkout -f    — force onto the branch, discarding tracked-file edits
    //   • reset --hard   — index + tracked files exactly match the PR head
    //   • clean -fd      — drop untracked files, but NOT ignored ones (-x): we
    //                      keep node_modules/venv so install-skip reuse works
    // We never commit and never push — this is a read-only checkout of the PR.
    await runner(["-C", repoDir, "checkout", "-f", "-B", localBranch, "FETCH_HEAD"]);
    await runner(["-C", repoDir, "reset", "--hard", "FETCH_HEAD"]);
    await runner(["-C", repoDir, "clean", "-fd"]);
    const { stdout } = await runner(["-C", repoDir, "rev-parse", "HEAD"]);
    return { repoDir, remote: sanitizedRemote, ref, headSha: stdout.trim(), reused };
  } catch (err) {
    throw toWorkspaceError(err, token);
  }
}

/**
 * The working tree's unstaged diff against HEAD — how fix mode turns applied
 * edits into `patch.diff`. Because we run the edits and git produces the diff,
 * the patch is valid by construction (vs. asking a model to emit one). The
 * output format is pinned against the user's global git config: a
 * `diff.noprefix=true`, `diff.external`, `color.diff=always`, or textconv
 * driver in ~/.gitconfig would otherwise make the emitted patch unusable by
 * the documented `git apply .ai-review/patch.diff`.
 */
export async function gitDiff(repoDir: string, runner?: GitRunner): Promise<string> {
  const run = runner ?? defaultGitRunner;
  try {
    const { stdout } = await run([
      "-C",
      repoDir,
      "-c",
      "diff.noprefix=false",
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ]);
    return stdout;
  } catch (err) {
    throw toWorkspaceError(err, null);
  }
}

/**
 * Discard all working-tree changes, restoring the checkout to HEAD. Same
 * semantics as the prepare-time cleanup: `clean -fd` without `-x` keeps ignored
 * files (node_modules/venv) so a later install-skip reuse still works.
 */
export async function restoreWorkspace(repoDir: string, runner?: GitRunner): Promise<void> {
  const run = runner ?? defaultGitRunner;
  try {
    await run(["-C", repoDir, "reset", "--hard", "HEAD"]);
    await run(["-C", repoDir, "clean", "-fd"]);
  } catch (err) {
    throw toWorkspaceError(err, null);
  }
}

export interface EnsureWorkspaceInput extends PrepareRepoInput {
  /**
   * The head sha the review run checked out (from `workspace_metadata.json`),
   * or null when unknown — unknown always re-fetches.
   */
  expectedHeadSha: string | null;
}

export interface EnsuredWorkspace extends PreparedRepo {
  /** True when the PR head moved since the review — findings may be stale. */
  headMoved: boolean;
}

/**
 * Make sure `repoDir` is a clean checkout of the PR head for fix mode.
 *
 * When the review's checkout is still present at the sha the findings were
 * produced against, it is cleaned in place — no fetch, which both works offline
 * and deliberately pins the fixes to the *reviewed* commit. Otherwise it falls
 * back to a full `prepareRepo` (fetch + checkout) and reports `headMoved` so
 * the caller can warn that the findings may no longer match the code.
 */
export async function ensurePrHeadWorkspace(
  input: EnsureWorkspaceInput,
): Promise<EnsuredWorkspace> {
  const runner = input.runner ?? defaultGitRunner;
  const { repoDir, expectedHeadSha } = input;

  if (expectedHeadSha !== null && (await exists(join(repoDir, ".git")))) {
    try {
      const { stdout } = await runner(["-C", repoDir, "rev-parse", "HEAD"]);
      if (stdout.trim() === expectedHeadSha) {
        await restoreWorkspace(repoDir, runner);
        return {
          repoDir,
          remote: `https://github.com/${input.owner}/${input.repo}.git`,
          ref: `pull/${input.number}/head`,
          headSha: expectedHeadSha,
          reused: true,
          headMoved: false,
        };
      }
    } catch {
      // Unreadable checkout (corrupt .git, etc.) — fall through to a fresh prepare.
    }
  }

  const prepared = await prepareRepo(input);
  return {
    ...prepared,
    headMoved: expectedHeadSha !== null && prepared.headSha !== expectedHeadSha,
  };
}
