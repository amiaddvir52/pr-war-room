import type { ParsedPr } from "./parsePrUrl.js";
import type { GitHubClient } from "./client.js";
import { GITHUB_DIFF_MEDIA_TYPE, mapGitHubError } from "./client.js";

/**
 * Fetch the PR's unified diff. Returns the raw diff text, or `null` when the
 * diff is too large for GitHub to generate (406, or a transient 5xx after the
 * client's retry) — a soft failure, since `changed_files.json` still carries
 * per-file patches. Any other error status is surfaced.
 */
export async function fetchPrDiff(client: GitHubClient, pr: ParsedPr): Promise<string | null> {
  const label = `${pr.owner}/${pr.repo}#${pr.number}`;
  const path = `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;

  const result = await client.requestRaw(path, GITHUB_DIFF_MEDIA_TYPE);
  if (result.ok) return result.body;
  if (result.status === 406 || result.status >= 500) return null; // too large / transient
  throw mapGitHubError(result, label);
}
