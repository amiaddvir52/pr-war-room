import type { Config } from "../config/schema.js";
import type { ReviewPacket } from "../context/types.js";
import { JudgeError } from "../errors.js";
import type { FindingCluster, JudgeVerdict, SkepticResult } from "../findings/schema.js";
import { JudgeVerdictSchema, JUDGE_OUTPUT_JSON_SCHEMA } from "../findings/schema.js";
import { parseLastValidObject } from "../util/parseLastValidObject.js";
import { createModelClient } from "./modelClient.js";
import { buildJudgeSystemPrompt, buildJudgeUserPrompt } from "./prompts/judgePrompt.js";
import type { ModelClient } from "./types.js";

/**
 * The judge agent (Phase 9, PRD §10.8). It reuses the same `ModelClient` seam as
 * the reviewers and the skeptic: one narrow question per call ("how much would a
 * human reviewer care about this supported finding?"), structured output,
 * tolerant parse.
 *
 * Like the skeptic, the judge THROWS a typed `JudgeError` on any soft failure or
 * unparseable output. The orchestrator (`runJudge`) catches that, records the
 * failure `kind`, and falls back to a deterministic classification (recall-first)
 * so an infra hiccup never drops a finding — it only leaves it un-ranked-by-model
 * (kept, classified from its severity/skeptic signals instead).
 */

/** A judge asks the model for one verdict on one supported cluster. */
export type Judge = (
  cluster: FindingCluster,
  skeptic: SkepticResult | null,
  packet: ReviewPacket,
) => Promise<JudgeVerdict>;

/**
 * Return the LAST brace-balanced object in `text` that parses as a valid
 * verdict (see `parseLastValidObject` for why last-wins), or `null`.
 */
export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  return parseLastValidObject(text, JudgeVerdictSchema);
}

/**
 * Build a judge over a given `ModelClient` — the testable seam (tests inject a
 * fake client, exactly as `SkepticAgent` is tested). One narrow question per call.
 */
export function judgeFromClient(client: ModelClient): Judge {
  const system = buildJudgeSystemPrompt();

  return async (cluster, skeptic, packet) => {
    const result = await client.complete({
      system,
      user: buildJudgeUserPrompt(cluster, skeptic, packet),
      jsonSchema: JUDGE_OUTPUT_JSON_SCHEMA,
    });
    // Soft failures ⇒ can't rank ⇒ throw a typed error so the orchestrator falls
    // back to a deterministic classification (recall-first) and records the kind.
    if (
      result.stopReason === "refusal" ||
      result.stopReason === "max_tokens" ||
      result.stopReason === "error"
    ) {
      const kind =
        result.stopReason === "refusal"
          ? "refusal"
          : result.stopReason === "max_tokens"
            ? "max_tokens"
            : "backend_error";
      throw new JudgeError(`judge could not complete (stop reason: ${result.stopReason})`, kind);
    }
    const verdict = parseJudgeVerdict(result.text);
    if (verdict === null) {
      throw new JudgeError("judge output did not contain a valid verdict", "parse_error");
    }
    return verdict;
  };
}

/**
 * Build a judge from config. The client is constructed eagerly so a misconfigured
 * backend fails loudly here, not mid-ranking. Callers only reach this for a
 * non-`mock` backend — `runJudge` handles `mock` with a deterministic
 * classification instead of a model call.
 *
 * `timeoutMs` overrides the config's per-cluster timeout: `runJudge` builds one
 * judge per cluster with an adaptive, size-scaled budget (see clusterTimeout.ts).
 */
export function createJudge(config: Config, timeoutMs?: number): Judge {
  const client: ModelClient = createModelClient(config.judge.backend, {
    timeoutMs: timeoutMs ?? config.judge.timeoutMs,
  });
  return judgeFromClient(client);
}
