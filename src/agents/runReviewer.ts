import { relative } from "node:path";
import type { Config } from "../config/types.js";
import type { ReviewPacket } from "../context/types.js";
import { ReviewerError } from "../errors.js";
import type { Finding } from "../findings/schema.js";
import { normalizeFindings } from "../findings/normalizeFindings.js";
import { partitionFindings } from "../findings/validateFinding.js";
import type { ArtifactPaths } from "../storage/artifactPaths.js";
import { writeJsonArtifact, writeTextArtifact } from "../storage/writeArtifact.js";
import type { Reporter } from "../ui/reporter.js";
import { ClaudeReviewer } from "./ClaudeReviewer.js";
import { MockReviewer } from "./MockReviewer.js";
import { createAnthropicModelClient } from "./anthropicClient.js";
import { createClaudeCliModelClient } from "./claudeCli.js";
import type { ModelClient, RawAgentResult, ReviewerAgent } from "./types.js";

export interface RunReviewerInput {
  packet: ReviewPacket;
  packetMarkdown: string;
  config: Config;
  paths: ArtifactPaths;
  reporter: Reporter;
  /** Injected in tests to avoid the network when the Claude reviewer is selected. */
  makeClient?: () => ModelClient;
}

export interface RunReviewerResult {
  agent: string;
  findings: Finding[];
  droppedCount: number;
  /** Non-null when the reviewer produced no usable findings (soft failure). */
  parseError: string | null;
}

export type RunReviewer = (input: RunReviewerInput) => Promise<RunReviewerResult>;

/**
 * Map `models.primaryReviewer` to a concrete reviewer:
 *   - `"claude"`     → the local `claude` CLI (default; uses `claude login`, no key)
 *   - `"claude-api"` → the Anthropic API/SDK (needs ANTHROPIC_API_KEY; structured outputs)
 *   - `"mock"`       → offline deterministic reviewer
 */
function selectReviewer(input: RunReviewerInput): ReviewerAgent {
  const which = input.config.models.primaryReviewer;
  if (which === "mock") return new MockReviewer();
  if (which === "claude" || which === "claude-api") {
    const makeDefault = which === "claude-api" ? createAnthropicModelClient : createClaudeCliModelClient;
    const client = (input.makeClient ?? makeDefault)();
    return new ClaudeReviewer(client, input.config.review);
  }
  throw new ReviewerError(
    `Reviewer "${which}" is not implemented yet. Set models.primaryReviewer to ` +
      '"claude" (CLI), "claude-api" (Anthropic API), or "mock" in .pr-war-room.json. ' +
      "Codex arrives in Phase 6 (multi-agent fan-out).",
  );
}

/**
 * Phase 5 orchestration seam: run one reviewer against the packet, capture its
 * raw output, validate + normalize the findings, and write the three artifacts
 * (`raw/<agent>_review.md`, `raw/<agent>_findings.json`,
 * `normalized/all_findings.json`). A hard failure (e.g. missing credentials)
 * throws `ReviewerError` and aborts the run; a parse failure is reported but
 * leaves an empty findings set. Phase 6 replaces this with a multi-reviewer
 * fan-out that merges into the same `normalized/all_findings.json`.
 */
export const runReviewer: RunReviewer = async (input) => {
  const { paths, reporter } = input;
  const reviewer = selectReviewer(input);

  // The reviewer call is the long, opaque part (a full model turn), so show a
  // live spinner while it runs instead of a line that only appears when done.
  const spin = reporter.spinner(`reviewing with ${reviewer.name}…`);
  let result: RawAgentResult;
  try {
    result = await reviewer.review({
      packet: input.packet,
      packetMarkdown: input.packetMarkdown,
    });
  } catch (err) {
    spin.fail(`${reviewer.name} reviewer failed`);
    throw err;
  }

  // Capture the raw output first, so it's on disk even if nothing parses.
  await writeTextArtifact(paths.raw.reviewMd(reviewer.name), result.rawText);
  const rawRef = relative(paths.root, paths.raw.reviewMd(reviewer.name));

  const { valid, dropped } = partitionFindings(result.findings, input.config.review);
  await writeJsonArtifact(paths.raw.findingsJson(reviewer.name), valid);

  const findings = normalizeFindings(valid, { agent: reviewer.name, rawRef });
  await writeJsonArtifact(paths.normalized.allFindings, findings);

  const suffix = dropped.length > 0 ? ` (${dropped.length} dropped)` : "";
  if (result.parseError !== null) {
    spin.fail(`${reviewer.name} reviewer — no usable findings`);
    reporter.warn(`${result.parseError}. Raw output saved to ${rawRef}.`);
  } else {
    spin.succeed(
      `reviewed code — ${findings.length} finding${findings.length === 1 ? "" : "s"}${suffix}`,
    );
  }

  return {
    agent: reviewer.name,
    findings,
    droppedCount: dropped.length,
    parseError: result.parseError,
  };
};
