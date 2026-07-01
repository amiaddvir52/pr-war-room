import type { ReviewConfig } from "../config/schema.js";
import { ReviewerResponseSchema, REVIEWER_OUTPUT_JSON_SCHEMA } from "../findings/schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts/reviewerPrompt.js";
import type { ModelClient, RawAgentResult, ReviewerAgent, ReviewerInput } from "./types.js";

/** Sentinel distinct from any `JSON.parse` result (which is never `undefined`). */
const PARSE_FAILED = Symbol("parse-failed");

/**
 * Tolerant JSON extraction. The API (structured outputs) returns pure JSON, but
 * the CLI path is only prompt-guided, so the model may wrap the object in prose
 * or ```json fences. Try the whole string, then a fenced block, then the
 * outermost `{…}` span. Returns `PARSE_FAILED` when nothing parses.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const attempts: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) attempts.push(fence[1].trim());

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) attempts.push(trimmed.slice(start, end + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return PARSE_FAILED;
}

/**
 * The Claude reviewer (PRD §10.4). Renders the packet into a prompt, asks the
 * model for structured findings, and validates them against the Finding schema.
 * Because it talks through the `ModelClient` seam, it is fully unit-testable
 * with a fake client — no network.
 */
export class ClaudeReviewer implements ReviewerAgent {
  readonly name = "claude";

  constructor(
    private readonly client: ModelClient,
    private readonly reviewConfig: ReviewConfig,
  ) {}

  async review(input: ReviewerInput): Promise<RawAgentResult> {
    const result = await this.client.complete({
      system: buildSystemPrompt(this.reviewConfig),
      user: buildUserPrompt(input.packetMarkdown),
      jsonSchema: REVIEWER_OUTPUT_JSON_SCHEMA,
    });
    const rawText = result.text;

    // Benign, non-fatal outcomes: report clearly, continue with zero findings.
    if (result.stopReason === "refusal") {
      return { rawText, findings: [], parseError: "model refused to review (stop_reason: refusal)" };
    }
    if (result.stopReason === "max_tokens") {
      return {
        rawText,
        findings: [],
        parseError: "model output was truncated (stop_reason: max_tokens)",
      };
    }

    const parsed = extractJson(rawText);
    if (parsed === PARSE_FAILED) {
      return { rawText, findings: [], parseError: "output did not contain valid JSON" };
    }

    const validated = ReviewerResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        rawText,
        findings: [],
        parseError: `output did not match the finding schema: ${validated.error.message}`,
      };
    }

    return { rawText, findings: validated.data.findings, parseError: null };
  }
}
