import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubError } from "../errors.js";

/**
 * Resolve a GitHub token, in order: `GITHUB_TOKEN`, then `GH_TOKEN` (honored by
 * the gh CLI itself), then `GITHUB_PERSONAL_ACCESS_TOKEN` (the variable the
 * GitHub MCP server — `@modelcontextprotocol/server-github` — reads, so users
 * who set up GitHub MCP get deterministic REST ingestion with no extra setup),
 * then `gh auth token`. `env` and the gh runner are injected so tests never
 * touch the real environment or spawn a subprocess. The token value is never
 * logged or persisted.
 */

const execFileAsync = promisify(execFile);

export type ExecFileRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type TokenSource =
  | "env:GITHUB_TOKEN"
  | "env:GH_TOKEN"
  | "env:GITHUB_PERSONAL_ACCESS_TOKEN"
  | "gh";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

const defaultRunGh: ExecFileRunner = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: 5000,
    windowsHide: true,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
};

function pickEnvToken(env: NodeJS.ProcessEnv): ResolvedToken | null {
  const githubToken = env["GITHUB_TOKEN"]?.trim();
  if (githubToken) return { token: githubToken, source: "env:GITHUB_TOKEN" };
  const ghToken = env["GH_TOKEN"]?.trim();
  if (ghToken) return { token: ghToken, source: "env:GH_TOKEN" };
  // The var the GitHub MCP server uses — reuse it so MCP users need no extra setup.
  const patToken = env["GITHUB_PERSONAL_ACCESS_TOKEN"]?.trim();
  if (patToken) return { token: patToken, source: "env:GITHUB_PERSONAL_ACCESS_TOKEN" };
  return null;
}

function ghHint(err: unknown): string {
  const e = err as { code?: string; stderr?: unknown };
  if (e?.code === "ENOENT") {
    return "The GitHub CLI (gh) is not installed — install it, or set GITHUB_TOKEN.";
  }
  const stderr = String(e?.stderr ?? "").toLowerCase();
  if (
    stderr.includes("not logged") ||
    stderr.includes("gh auth login") ||
    stderr.includes("authentication")
  ) {
    return "Run: gh auth login";
  }
  return "Run: gh auth login  (or set GITHUB_TOKEN)";
}

function noAuthError(hint: string): GitHubError {
  return new GitHubError(
    "GitHub authentication required. Set GITHUB_TOKEN (or GITHUB_PERSONAL_ACCESS_TOKEN, " +
      "the same token your GitHub MCP server uses), or authenticate the GitHub CLI.\n" +
      `  ${hint}\n` +
      "  Then re-run: pr-war-room review <pr-url>",
  );
}

export async function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  runGh: ExecFileRunner = defaultRunGh,
): Promise<ResolvedToken> {
  const fromEnv = pickEnvToken(env);
  if (fromEnv) return fromEnv;

  let stdout: string;
  try {
    ({ stdout } = await runGh("gh", ["auth", "token"]));
  } catch (err) {
    throw noAuthError(ghHint(err));
  }

  const token = stdout.trim();
  if (!token) throw noAuthError("Run: gh auth login");
  return { token, source: "gh" };
}
