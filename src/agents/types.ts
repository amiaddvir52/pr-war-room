import type { ReviewPacket } from "../context/types.js";
import type { FindingCore } from "../findings/schema.js";

/**
 * Agent abstractions (PRD §10.4, Phase 5). A `ReviewerAgent` turns a review
 * packet into raw findings; the orchestrator (`runReviewer`) validates,
 * normalizes, and persists them. Phase 6 adds more concrete reviewers behind
 * this same interface and runs them in parallel.
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
   * Non-null when the model produced no usable findings for a benign reason
   * (refusal, truncation, or output that didn't match the schema). This is a
   * soft failure — the run continues with zero findings.
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
  /** The response `stop_reason` (e.g. `"end_turn"`, `"refusal"`, `"max_tokens"`). */
  stopReason: string | null;
}

export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelResult>;
}
