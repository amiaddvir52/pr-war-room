import { z } from "zod";
import type { Config } from "../config/schema.js";
import type { Adjudicator } from "../findings/deduplicateFindings.js";
import { extractJsonObjects } from "../util/extractJsonObjects.js";
import { createModelClient } from "./modelClient.js";
import { buildDedupSystemPrompt, buildDedupUserPrompt } from "./prompts/dedupPrompt.js";
import type { ModelClient } from "./types.js";

/**
 * The optional LLM dedup adjudicator (PRD §10.6 step 4). It is scaffolded but
 * OFF by default (`config.dedup.llm.enabled === false`); the deterministic
 * heuristics run without it. When enabled, it is consulted only for gray-zone
 * pairs and reuses the same `ModelClient` seam as the reviewers.
 *
 * Any uncertainty — a soft failure (refusal / truncation / backend error) or
 * output that doesn't parse — resolves to `false` ("don't merge"), so an
 * unreliable model can only leave findings un-merged, never fabricate a merge.
 * The caller (`clusterFindings`) additionally treats a thrown error as
 * "don't merge", so this stays fail-open end to end.
 */

const DEDUP_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["same_issue"],
  properties: { same_issue: { type: "boolean" } },
};

const DedupResponseSchema = z.object({ same_issue: z.boolean() });

/**
 * Extract the model's `same_issue` verdict, defaulting to `false` (do NOT merge)
 * whenever the answer is missing, malformed, or ambiguous — so an unreliable
 * model can only leave a pair un-merged, never fabricate a merge.
 *
 * A reasoning model states its conclusion last (and the prompt asks for only the
 * object), so we keep the LAST schema-valid object and ignore earlier
 * illustrative/counterfactual ones. This both (a) never returns `true` when the
 * model's actual verdict is `false`, and (b) still recovers a genuine `true`
 * that follows some reasoning, rather than dropping it.
 */
export function parseSameIssue(text: string): boolean {
  let decided: boolean | undefined;
  for (const candidate of extractJsonObjects(text)) {
    try {
      const parsed = DedupResponseSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) decided = parsed.data.same_issue;
    } catch {
      // Not valid JSON (e.g. braces unbalanced by string contents) — skip it.
    }
  }
  return decided === true;
}

/**
 * Build a dedup adjudicator from config. The client is constructed eagerly so a
 * real misconfigured backend fails loudly here, not mid-clustering; the per-pair
 * call is fail-open.
 *
 * The `mock` backend has no model client (like the reviewer fan-out, which
 * builds a `MockReviewer` directly), so we return a no-op adjudicator that never
 * merges — a controlled, deterministic degradation that leaves the heuristic
 * clustering untouched. This keeps offline runs (`backend: "mock"`) from
 * crashing the whole review when LLM dedup is enabled.
 */
export function createDedupAdjudicator(config: Config): Adjudicator {
  if (config.dedup.llm.backend === "mock") {
    return async () => false;
  }
  const client: ModelClient = createModelClient(config.dedup.llm.backend, {
    timeoutMs: config.dedup.llm.timeoutMs,
  });
  const system = buildDedupSystemPrompt();

  return async (a, b) => {
    const result = await client.complete({
      system,
      user: buildDedupUserPrompt(a, b),
      jsonSchema: DEDUP_OUTPUT_JSON_SCHEMA,
    });
    // Soft failures ⇒ can't decide ⇒ don't merge.
    if (result.stopReason === "refusal" || result.stopReason === "max_tokens" || result.stopReason === "error") {
      return false;
    }
    return parseSameIssue(result.text);
  };
}
