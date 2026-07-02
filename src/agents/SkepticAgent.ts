import type { Config } from "../config/schema.js";
import type { ReviewPacket } from "../context/types.js";
import { SkepticError } from "../errors.js";
import type { EvidenceChecks, FindingCluster, SkepticVerdict } from "../findings/schema.js";
import { SkepticVerdictSchema, SKEPTIC_OUTPUT_JSON_SCHEMA } from "../findings/schema.js";
import { extractJsonObjects } from "../util/extractJsonObjects.js";
import { createModelClient } from "./modelClient.js";
import { buildSkepticSystemPrompt, buildSkepticUserPrompt } from "./prompts/skepticPrompt.js";
import type { ModelClient } from "./types.js";

/**
 * The skeptic agent (Phase 8, PRD §10.7). It reuses the same `ModelClient` seam
 * as the reviewers and the dedup adjudicator: one narrow question per call ("is
 * this finding actually supported?"), structured output, tolerant parse.
 *
 * Unlike the dedup adjudicator (which fails *open* to "don't merge"), the
 * skeptic THROWS a typed `SkepticError` on any soft failure or unparseable
 * output. The orchestrator (`runSkeptic`) catches that, records the failure
 * `kind`, and applies the recall-first fallback: keep the finding rather than
 * let an infra hiccup silently drop a real issue. So the only thing an
 * unreliable model can do here is leave a finding un-validated (kept, annotated).
 */

/** A skeptic asks the model for one verdict on one cluster. */
export type Skeptic = (
  cluster: FindingCluster,
  packet: ReviewPacket,
  checks: EvidenceChecks,
) => Promise<SkepticVerdict>;

/**
 * Extract every brace-balanced `{…}` object from `text` and return the LAST one
 * that parses as a valid verdict. A reasoning model states its conclusion last,
 * so keeping the last valid object ignores earlier illustrative/example objects.
 * Uses the shared string-aware extractor, so a lone unbalanced quote in the
 * model's prose can't swallow the real verdict. Returns `null` when none parse.
 */
export function parseSkepticVerdict(text: string): SkepticVerdict | null {
  let decided: SkepticVerdict | null = null;
  for (const candidate of extractJsonObjects(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // Balanced braces but not valid JSON (e.g. `{x}`) — skip it.
      continue;
    }
    const result = SkepticVerdictSchema.safeParse(parsed);
    if (result.success) decided = result.data;
  }
  return decided;
}

/**
 * Build a skeptic over a given `ModelClient` — the testable seam (tests inject a
 * fake client, exactly as `Reviewer` is tested). One narrow question per call.
 */
export function skepticFromClient(client: ModelClient): Skeptic {
  const system = buildSkepticSystemPrompt();

  return async (cluster, packet, checks) => {
    const result = await client.complete({
      system,
      user: buildSkepticUserPrompt(cluster, packet, checks),
      jsonSchema: SKEPTIC_OUTPUT_JSON_SCHEMA,
    });
    // Soft failures ⇒ can't validate ⇒ throw a typed error so the orchestrator
    // keeps the finding (recall-first) and records the failure kind, rather than
    // treating a hiccup as "unsupported".
    if (
      result.stopReason === "refusal" ||
      result.stopReason === "max_tokens" ||
      result.stopReason === "error"
    ) {
      const kind = result.stopReason === "refusal" ? "refusal" : result.stopReason === "max_tokens" ? "max_tokens" : "backend_error";
      throw new SkepticError(`skeptic could not complete (stop reason: ${result.stopReason})`, kind);
    }
    const verdict = parseSkepticVerdict(result.text);
    if (verdict === null) {
      throw new SkepticError("skeptic output did not contain a valid verdict", "parse_error");
    }
    return verdict;
  };
}

/**
 * Build a skeptic from config. The client is constructed eagerly so a
 * misconfigured backend fails loudly here, not mid-validation. Callers only
 * reach this for a non-`mock` backend — `runSkeptic` handles `mock` with a
 * deterministic, checks-only verdict instead of a model call.
 */
export function createSkeptic(config: Config): Skeptic {
  const client: ModelClient = createModelClient(config.skeptic.backend, {
    timeoutMs: config.skeptic.timeoutMs,
  });
  return skepticFromClient(client);
}
