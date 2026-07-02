import type { ReviewPacket } from "../context/types.js";
import type { FindingCore } from "../findings/schema.js";

/**
 * Agent abstractions (PRD §10.4). A `ReviewerAgent` turns a review packet into
 * raw findings; the orchestrator (`runReviewers`) validates, normalizes, and
 * persists them. Phase 6 runs several reviewers behind this same interface in
 * parallel.
 */

export interface ReviewerInput {
  packet: ReviewPacket;
  /** LLM-readable rendering of the packet (`review_packet.md`). */
  packetMarkdown: string;
}

export interface RawAgentResult {
  /** The reviewer's raw output, stored verbatim as `raw/<agent>_review.md`. */
  rawText: string;
  /** Parsed, schema-valid core findings (empty when parsing failed). */
  findings: FindingCore[];
  /**
   * Non-null when the model produced no usable output (refusal, truncation, or
   * output that didn't match the schema). The reviewer does not throw for this;
   * the orchestrator records it as `unusable_output` (distinct from a valid
   * empty `no_findings`) and it counts against the usable-reviewer threshold.
   */
  parseError: string | null;
}

export interface ReviewerAgent {
  readonly name: string;
  review(input: ReviewerInput): Promise<RawAgentResult>;
}

/**
 * A thin seam over the model provider so reviewers can be unit-tested without
 * the network — tests inject a fake `ModelClient`. `complete` asks the model
 * to return JSON matching `jsonSchema` (via structured outputs).
 */
export interface ModelRequest {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
}

export interface ModelResult {
  /** The concatenated text content of the model's response. */
  text: string;
  /**
   * The response `stop_reason`. The API path passes the SDK value through
   * (`"end_turn"`, `"refusal"`, `"max_tokens"`, …); the CLI path normalizes its
   * result envelope to the same vocabulary, adding `"error"` for a backend
   * error (`is_error: true`). `Reviewer` special-cases `"refusal"`,
   * `"max_tokens"`, and `"error"` as benign soft failures.
   */
  stopReason: string | null;
}

export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelResult>;
}
