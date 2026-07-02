import type { ReviewConfig, ReviewerAngle } from "../config/schema.js";
import { ReviewerResponseSchema, REVIEWER_OUTPUT_JSON_SCHEMA } from "../findings/schema.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts/reviewerPrompt.js";
import type { ModelClient, RawAgentResult, ReviewerAgent, ReviewerInput } from "./types.js";

/** Sentinel distinct from any `JSON.parse` result (which is never `undefined`). */
const PARSE_FAILED = Symbol("parse-failed");

/**
 * Collect every top-level, balanced `{…}` object in `text`, in source order.
 * The scan is string-aware: braces inside JSON strings (and escaped quotes) do
 * not affect the depth count, so a `"{"` in a value can't unbalance it. This is
 * the tolerant fallback for the CLI paths, where the model may wrap the JSON in
 * prose that itself contains braces — the previous first-`{`-to-last-`}` span
 * failed exactly that case.
 */
function balancedObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Tolerant JSON extraction. The API (structured outputs) returns pure JSON, but
 * the CLI paths are only prompt-guided, so the model may wrap the object in
 * prose or ```json fences. Try the whole string, then a fenced block, then each
 * balanced top-level `{…}` object. Returns `PARSE_FAILED` when nothing parses.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const attempts: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) attempts.push(fence[1].trim());

  attempts.push(...balancedObjects(trimmed));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return PARSE_FAILED;
}

/** First non-empty line of the backend's raw output, truncated for a one-line error. */
function briefDetail(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return `: ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`;
}

/**
 * A reviewer agent (PRD §10.4). Renders the packet into a prompt for its
 * `angle`, asks the model (through the `ModelClient` seam) for structured
 * findings, and validates them against the Finding schema. Because it talks
 * through the seam it is fully unit-testable with a fake client — no network.
 *
 * One class serves every model-backed agent: the `backend` chooses the injected
 * `ModelClient` (Claude CLI / Anthropic API / Codex CLI) and the `angle` chooses
 * the prompt persona. `name` is the agent's identity in artifacts and finding
 * ids. (The offline `MockReviewer` is separate — it fabricates findings.)
 */
export class Reviewer implements ReviewerAgent {
  readonly name: string;

  constructor(
    name: string,
    private readonly client: ModelClient,
    private readonly angle: ReviewerAngle,
    private readonly reviewConfig: ReviewConfig,
  ) {
    this.name = name;
  }

  async review(input: ReviewerInput): Promise<RawAgentResult> {
    const result = await this.client.complete({
      system: buildSystemPrompt(this.reviewConfig, this.angle),
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
    // A backend error (e.g. the CLI reported `is_error: true`). Surface it as a
    // real error rather than letting the error text fall through to the JSON
    // parser and be reported as the misleading "did not contain valid JSON".
    if (result.stopReason === "error") {
      return {
        rawText,
        findings: [],
        parseError: `model backend reported an error (stop_reason: error)${briefDetail(rawText)}`,
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
