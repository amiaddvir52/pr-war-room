import type { ReviewerBackend } from "../config/schema.js";
import { ReviewerError } from "../errors.js";
import { createAnthropicModelClient } from "./anthropicClient.js";
import { createClaudeCliModelClient } from "./claudeCli.js";
import { createCodexCliModelClient } from "./codexCli.js";
import type { ModelClient } from "./types.js";

export interface ModelClientOptions {
  /** Per-call timeout (ms) for the CLI backends. The API backend has no internal
   * timeout — the orchestrator enforces one around it. */
  timeoutMs?: number;
}

/**
 * Map a reviewer `backend` to its `ModelClient` (Phase 6). The `mock` backend
 * has no client — the orchestrator builds a `MockReviewer` directly — so asking
 * for one is a programming error.
 */
export function createModelClient(
  backend: ReviewerBackend,
  options: ModelClientOptions = {},
): ModelClient {
  const withTimeout = options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {};
  switch (backend) {
    case "claude":
      return createClaudeCliModelClient(withTimeout);
    case "claude-api":
      return createAnthropicModelClient();
    case "codex":
      return createCodexCliModelClient(withTimeout);
    case "mock":
      throw new ReviewerError(
        'internal error: the "mock" backend has no model client (build a MockReviewer instead)',
      );
  }
}
