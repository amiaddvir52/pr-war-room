import type { ParsedPr } from "./parsePrUrl.js";
import type { GitHubClient } from "./client.js";
import { GitHubError } from "../errors.js";
import { GitHubPullResponseSchema, toPrMetadata, type PrMetadata } from "./schema.js";

/** Fetch and normalize the PR metadata for `pr`. */
export async function fetchPrMetadata(client: GitHubClient, pr: ParsedPr): Promise<PrMetadata> {
  const label = `${pr.owner}/${pr.repo}#${pr.number}`;
  const path = `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;

  const json = await client.getJson(path, label);
  const parsed = GitHubPullResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new GitHubError(`GitHub returned an unexpected PR-metadata response for ${label}.`);
  }
  return toPrMetadata(parsed.data, pr);
}
