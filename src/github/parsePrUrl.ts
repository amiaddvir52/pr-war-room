import { PrUrlError } from "../errors.js";

export interface ParsedPr {
  owner: string;
  repo: string;
  number: number;
}

// Matches https://github.com/<owner>/<repo>/pull/<number> and tolerates a
// trailing path segment (/files, /commits, ...), query string, and fragment.
const HTTP_PR_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/;

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

/**
 * Parse a GitHub PR URL into `{ owner, repo, number }`.
 *
 * Handles:
 *   https://github.com/org/repo/pull/123
 *   https://github.com/org/repo/pull/123/files      (trailing segment tolerated)
 *   github.com/org/repo/pull/123                     (scheme optional)
 *
 * SSH remotes (git@github.com:org/repo.git) are intentionally not supported yet;
 * the normalize step below is the seam where that support will slot in.
 *
 * Throws `PrUrlError` with a helpful message on anything else.
 */
export function parsePrUrl(input: string): ParsedPr {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new PrUrlError("No PR URL provided.");
  }

  // TODO(later phase): detect and parse SSH remotes before HTTP normalization.
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  const match = HTTP_PR_RE.exec(normalized);
  if (!match) {
    throw new PrUrlError(
      `Invalid GitHub PR URL: "${input}". ` +
        `Expected something like https://github.com/org/repo/pull/123`,
    );
  }

  const [, owner, repo, num] = match;
  return {
    owner: owner!,
    repo: stripGitSuffix(repo!),
    number: Number(num),
  };
}
