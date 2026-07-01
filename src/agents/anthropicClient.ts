import Anthropic, { AuthenticationError } from "@anthropic-ai/sdk";
import { ReviewerError } from "../errors.js";
import type { ModelClient, ModelRequest, ModelResult } from "./types.js";

/** Default reviewer model. Opus 4.8 supports adaptive thinking + structured outputs. */
export const REVIEWER_MODEL = "claude-opus-4-8";
/** Generous output budget; we stream so this doesn't risk an HTTP timeout. */
export const REVIEWER_MAX_TOKENS = 32_000;

export interface AnthropicModelClientOptions {
  /** Override the model id. Defaults to `REVIEWER_MODEL`. */
  model?: string;
  /** Override the output token budget. Defaults to `REVIEWER_MAX_TOKENS`. */
  maxTokens?: number;
  /** Provide a pre-constructed client (tests). Defaults to lazy `new Anthropic()`. */
  client?: Anthropic;
}

function authHelp(error: unknown): string {
  const detail = error instanceof Error ? ` (${error.message})` : "";
  return (
    `The "claude-api" reviewer needs Anthropic API credentials${detail}. ` +
    "Set ANTHROPIC_API_KEY (https://console.anthropic.com/), or set models.primaryReviewer " +
    'to "claude" to use the local Claude CLI login instead (no key), or "mock" to run offline.'
  );
}

/**
 * The real model client, wrapping `@anthropic-ai/sdk`. All SDK-specific code
 * lives here behind the `ModelClient` seam so reviewers stay provider-agnostic
 * and unit-testable. Uses structured outputs (`output_config.format`) so the
 * response is guaranteed to be schema-shaped JSON, adaptive thinking, and
 * streaming (`finalMessage`) to avoid HTTP timeouts on large outputs.
 */
export function createAnthropicModelClient(
  options: AnthropicModelClientOptions = {},
): ModelClient {
  const model = options.model ?? REVIEWER_MODEL;
  const maxTokens = options.maxTokens ?? REVIEWER_MAX_TOKENS;
  let client: Anthropic | null = options.client ?? null;

  return {
    async complete(req: ModelRequest): Promise<ModelResult> {
      if (client === null) {
        try {
          // Resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the env.
          client = new Anthropic();
        } catch (error) {
          throw new ReviewerError(authHelp(error));
        }
      }

      let message: Anthropic.Message;
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: maxTokens,
          thinking: { type: "adaptive" },
          system: req.system,
          output_config: { format: { type: "json_schema", schema: req.jsonSchema } },
          messages: [{ role: "user", content: req.user }],
        });
        message = await stream.finalMessage();
      } catch (error) {
        if (error instanceof AuthenticationError) throw new ReviewerError(authHelp(error));
        throw error;
      }

      let text = "";
      for (const block of message.content) {
        if (block.type === "text") text += block.text;
      }
      return { text, stopReason: message.stop_reason };
    },
  };
}
