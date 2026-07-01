import type { ParsedPr } from "./parsePrUrl.js";
import type { GitHubClient } from "./client.js";
import { GitHubError } from "../errors.js";
import {
  GitHubFilesResponseSchema,
  toChangedFile,
  type ChangedFile,
  type ChangedFilesArtifact,
} from "./schema.js";

const PER_PAGE = 100;
// GitHub caps the PR files endpoint at 3000 files (30 pages of 100).
const MAX_PAGES = 30;

/**
 * Fetch and normalize the PR's changed files, paginating until a short page.
 * Sets `truncated` if we hit GitHub's 3000-file cap. `patch` is omitted by
 * GitHub for binary/very-large files — `toChangedFile` records that as
 * `patchOmitted`.
 */
export async function fetchChangedFiles(
  client: GitHubClient,
  pr: ParsedPr,
): Promise<ChangedFilesArtifact> {
  const label = `${pr.owner}/${pr.repo}#${pr.number}`;
  const base = `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}/files`;

  const files: ChangedFile[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await client.getJson(`${base}?per_page=${PER_PAGE}&page=${page}`, label);
    const parsed = GitHubFilesResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new GitHubError(`GitHub returned an unexpected changed-files response for ${label}.`);
    }

    for (const raw of parsed.data) files.push(toChangedFile(raw));

    if (parsed.data.length < PER_PAGE) break; // last page
    if (page === MAX_PAGES) truncated = true; // full page at the cap → more may exist
  }

  return { schemaVersion: 1, totalCount: files.length, truncated, files };
}
