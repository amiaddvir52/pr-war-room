import { GitHubError } from "../errors.js";

/**
 * A thin GitHub REST client over the global `fetch`. Deliberately not octokit —
 * we hit three endpoints, need a custom error taxonomy, and want an injectable
 * `fetch` seam for tests. It owns headers, the error mapping, and a single
 * retry on transient failures; the `fetch*` functions layer schema validation
 * on top.
 */

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_JSON_MEDIA_TYPE = "application/vnd.github+json";
export const GITHUB_DIFF_MEDIA_TYPE = "application/vnd.github.diff";
const GITHUB_API_VERSION = "2022-11-28";

export interface GitHubClientOptions {
  token: string;
  version: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Per-request timeout (ms). Default 30s. */
  timeoutMs?: number;
  /** Backoff before the single retry (ms). Default 300ms; set 0 in tests. */
  retryDelayMs?: number;
}

/** A response after the body has been read once, regardless of status. */
export interface GitHubRawResult {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
}

export interface GitHubClient {
  /** GET returning parsed JSON (`unknown` — validate with zod). Throws on !ok. */
  getJson(path: string, resourceLabel: string): Promise<unknown>;
  /** GET returning the raw result without throwing on HTTP error status. */
  requestRaw(path: string, accept: string): Promise<GitHubRawResult>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function networkError(err: unknown, host: string): GitHubError {
  const e = err as { name?: string; code?: string; cause?: { code?: string } };
  if (e?.name === "AbortError" || e?.name === "TimeoutError") {
    return new GitHubError(`Timed out reaching ${host}. Check your network/proxy and retry.`);
  }
  const code = e?.cause?.code ?? e?.code;
  return new GitHubError(
    `Could not reach ${host}${code ? ` (${code})` : ""}. Check your network/proxy and retry.`,
  );
}

function rateLimitMessage(headers: Headers): string {
  const resetRaw = headers.get("x-ratelimit-reset");
  const resetSec = resetRaw ? Number(resetRaw) : Number.NaN;
  if (Number.isFinite(resetSec)) {
    const resetAt = new Date(resetSec * 1000);
    const mins = Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / 60_000));
    return (
      `GitHub API rate limit exceeded. Resets around ${resetAt.toLocaleTimeString()} (~${mins} min). ` +
      "Set GITHUB_TOKEN for a higher limit, or wait."
    );
  }
  return "GitHub API rate limit exceeded. Set GITHUB_TOKEN for a higher limit, or wait.";
}

function bodyMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : null;
  } catch {
    return null;
  }
}

/** Turn a non-ok HTTP result into an actionable `GitHubError`. */
export function mapGitHubError(result: GitHubRawResult, resourceLabel: string): GitHubError {
  const { status, headers } = result;
  const remaining = headers.get("x-ratelimit-remaining");

  if (status === 401) {
    return new GitHubError(
      'GitHub rejected the token (401). It may be expired or lack the "repo" scope. ' +
        "Regenerate GITHUB_TOKEN, or re-run: gh auth login",
    );
  }
  if (status === 403 || status === 429) {
    if (remaining === "0") return new GitHubError(rateLimitMessage(headers));
    return new GitHubError(
      `GitHub returned 403 (forbidden) for ${resourceLabel}. ` +
        "The token likely lacks permission or scope for this repository.",
    );
  }
  if (status === 404) {
    return new GitHubError(
      `PR not found: ${resourceLabel}. Check the URL — or the repository is private ` +
        "and the token lacks access.",
    );
  }
  if (status >= 500) {
    return new GitHubError(
      `GitHub server error (${status}) for ${resourceLabel}. This is usually transient — retry shortly.`,
    );
  }
  const detail = bodyMessage(result.body);
  return new GitHubError(
    `GitHub request for ${resourceLabel} failed (${status})${detail ? `: ${detail}` : ""}.`,
  );
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? GITHUB_API_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 300;
  const host = hostOf(baseUrl);

  const baseHeaders: Record<string, string> = {
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    Authorization: `Bearer ${options.token}`,
    "User-Agent": `pr-war-room/${options.version}`,
  };

  // GET with a single retry on network failure and 5xx (idempotent). Never
  // retries 4xx. Returns the raw result on any HTTP status; throws only when
  // the request cannot complete after the retry.
  async function request(path: string, accept: string): Promise<GitHubRawResult> {
    const url = `${baseUrl}${path}`;
    const headers = { ...baseHeaders, Accept: accept };
    let lastError: unknown;

    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status >= 500 && attempt < 1) {
          await res.text().catch(() => ""); // drain the socket before retrying
          await sleep(retryDelayMs);
          continue;
        }
        const body = await res.text();
        return { status: res.status, ok: res.ok, headers: res.headers, body };
      } catch (err) {
        lastError = err;
        if (attempt < 1) {
          await sleep(retryDelayMs);
          continue;
        }
      }
    }
    throw networkError(lastError, host);
  }

  return {
    async requestRaw(path, accept) {
      return request(path, accept);
    },
    async getJson(path, resourceLabel) {
      const result = await request(path, GITHUB_JSON_MEDIA_TYPE);
      if (!result.ok) throw mapGitHubError(result, resourceLabel);
      try {
        return JSON.parse(result.body) as unknown;
      } catch {
        throw new GitHubError(
          `GitHub returned an unexpected (non-JSON) response for ${resourceLabel}.`,
        );
      }
    },
  };
}
