import { describe, it, expect } from "vitest";
import { ingestPullRequest } from "../../src/github/ingestPullRequest.js";
import { parsePrUrl } from "../../src/github/parsePrUrl.js";
import { silentReporter } from "../../src/ui/reporter.js";

/**
 * Gated live smoke test — a pre-flight that auth + endpoints work against real
 * GitHub. Skipped unless PRWR_E2E is set (keeps CI and the no-network guarantee
 * intact). Uses the runner's GITHUB_TOKEN / GH_TOKEN / gh auth; commits no
 * token. Override the target with PRWR_E2E_PR=<pr-url>.
 */
const RUN = Boolean(process.env["PRWR_E2E"]);
const TARGET = process.env["PRWR_E2E_PR"] ?? "https://github.com/octocat/Hello-World/pull/1";

describe.skipIf(!RUN)("ingestPullRequest (live)", () => {
  it(
    "fetches a real public PR and produces the three artifacts",
    async () => {
      const pr = parsePrUrl(TARGET);
      const result = await ingestPullRequest(pr, {
        version: "0.0.0-e2e",
        reporter: silentReporter(),
      });
      expect(result.metadata.owner).toBe(pr.owner);
      expect(result.metadata.number).toBe(pr.number);
      expect(result.changedFiles.totalCount).toBeGreaterThanOrEqual(0);
      // diff may be null for very large PRs; for a small public PR it should exist.
      expect(result.diff === null || typeof result.diff === "string").toBe(true);
    },
    30_000,
  );
});
