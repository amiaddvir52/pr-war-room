import type { Config } from "../config/types.js";
import type { ReviewPacket } from "../context/types.js";
import { JudgeError, ReviewerTimeoutError } from "../errors.js";
import {
  computePriorityScore,
  deterministicClassification,
  shouldProtectFromDrop,
} from "../findings/scoreFindings.js";
import type {
  FindingCluster,
  JudgeFailure,
  JudgeResult,
  JudgeVerdict,
  SkepticResult,
} from "../findings/schema.js";
import type { Reporter } from "../ui/reporter.js";
import { mapWithConcurrency } from "../util/mapWithConcurrency.js";
import { retryOnTimeout } from "../util/retryOnTimeout.js";
import { adaptiveClusterTimeoutMs } from "./clusterTimeout.js";
import { createJudge, type Judge } from "./JudgeAgent.js";

/**
 * Phase 9 orchestration (PRD §10.8). For every skeptic-supported cluster the
 * judge assigns a classification (blocker / should_fix_before_review /
 * nice_to_have / drop) and the tool computes a deterministic priority score. The
 * ranked results feed `judge/ranked_findings.json`; the non-dropped subset feeds
 * `final_findings.json`.
 *
 * The design mirrors the skeptic's recall-first stance (confirmed decisions):
 *  - The judge may drop LOW-VALUE / stylistic findings — a different axis from
 *    the skeptic's "unsupported". But a model `drop` on a well-supported,
 *    high-severity (or multiply-reported) cluster is softened to `nice_to_have`
 *    (kept, deprioritized, annotated) rather than removed from the report.
 *  - The ordering `score` is ALWAYS the deterministic composite, never the
 *    model's self-score, so the ranking is reproducible; the model's advisory
 *    `model_score` is preserved in `model_verdict` for the audit trail.
 *  - Keep-on-failure is real: if the judge times out, refuses, emits unparseable
 *    output, or cannot be constructed, the finding is classified deterministically
 *    from its severity/skeptic signals and KEPT — never dropped, never aborts.
 */

export interface RunJudgeInput {
  /** The candidate clusters to rank (skeptic-supported, or all when skeptic off). */
  clusters: FindingCluster[];
  /** Skeptic results, keyed by cluster id internally. Empty when the skeptic is off. */
  skepticResults: SkepticResult[];
  packet: ReviewPacket;
  config: Config;
  reporter: Reporter;
  /**
   * Injected in tests to avoid the network; only called for non-`mock`
   * backends. `timeoutMs` is the adaptive per-cluster budget (see
   * clusterTimeout.ts) the returned judge's own model call should honour.
   */
  makeJudge?: (config: Config, timeoutMs?: number) => Judge;
}

export interface RunJudgeResult {
  ranked: JudgeResult[];
}

export type RunJudge = (input: RunJudgeInput) => Promise<RunJudgeResult>;

/** Classify a thrown judge error into a recorded failure (no message matching). */
function classifyFailure(err: unknown): JudgeFailure {
  if (err instanceof ReviewerTimeoutError) return { kind: "timeout", message: err.message };
  if (err instanceof JudgeError) return { kind: err.kind, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  // A non-judge Error is an unexpected (likely programming) failure: keep the
  // finding, but surface it rather than disguising it as a benign infra hiccup.
  return { kind: "unexpected", message };
}

/**
 * Combine the (optional) model verdict and any failure into the persisted result.
 * The order encodes the policy:
 *   1. judge could not run     → fallback: deterministic classification, kept
 *   2. no model verdict (mock) → deterministic classification
 *   3. model verdict           → its classification, with recall-first softening
 *                                of an over-eager `drop`
 * The ordering `score` is the deterministic composite in every branch.
 */
export function reconcileJudge(
  cluster: FindingCluster,
  skeptic: SkepticResult | null,
  modelVerdict: JudgeVerdict | null,
  failure: JudgeFailure | null,
  attempts = 1,
): JudgeResult {
  const score = computePriorityScore(cluster, skeptic);

  // 1. Keep-on-failure: the judge could not produce a verdict. Classify from the
  //    deterministic rules (which never drop) and keep, annotated.
  if (failure !== null) {
    const classification = deterministicClassification(cluster, skeptic);
    const retried = attempts > 1 ? ` after ${attempts} attempts` : "";
    return {
      cluster_id: cluster.cluster_id,
      source: "fallback",
      model_verdict: modelVerdict,
      decision: {
        classification,
        score,
        include_in_main_report: classification !== "drop",
        reason: `Judge could not complete (${failure.kind}: ${failure.message})${retried}; classified deterministically and kept for human review.`,
        softened_from_model_classification: null,
      },
      failure,
      attempts,
    };
  }

  // 2. Deterministic-only path (mock backend / disabled model): classify by rules.
  if (modelVerdict === null) {
    const classification = deterministicClassification(cluster, skeptic);
    return {
      cluster_id: cluster.cluster_id,
      source: "deterministic",
      model_verdict: null,
      decision: {
        classification,
        score,
        include_in_main_report: classification !== "drop",
        reason: "Ranked deterministically from severity, support, and agreement (no judge model ran).",
        softened_from_model_classification: null,
      },
      failure: null,
      attempts,
    };
  }

  // 3. Model verdict stands, with recall-first softening of an over-eager drop.
  const softened =
    modelVerdict.final_classification === "drop" && shouldProtectFromDrop(cluster, skeptic);
  const classification = softened ? "nice_to_have" : modelVerdict.final_classification;
  return {
    cluster_id: cluster.cluster_id,
    source: "llm",
    model_verdict: modelVerdict,
    decision: {
      classification,
      score,
      include_in_main_report: classification !== "drop",
      reason: softened
        ? `Judge recommended drop, but this is a well-supported, high-severity finding; kept as nice_to_have (recall-first). ${modelVerdict.reasoning_summary}`
        : modelVerdict.reasoning_summary,
      softened_from_model_classification: softened ? "drop" : null,
    },
    failure: null,
    attempts,
  };
}

export const runJudge: RunJudge = async (input) => {
  const { clusters, skepticResults, packet, config, reporter } = input;
  if (clusters.length === 0) return { ranked: [] };

  const skepticById = new Map(skepticResults.map((r) => [r.cluster_id, r]));

  // `mock` has no model client (like the reviewer fan-out and skeptic): classify
  // purely from the deterministic rules instead of asking for a mock client.
  const useLlm = config.judge.backend !== "mock";

  // Probe judge construction once, up front, so a misconfigured backend warns a
  // single time. A construction failure must NOT abort the review
  // (recall-first): record it and let every finding fall through to a
  // keep-on-failure fallback below. Per-cluster construction below is cheap
  // (closures over config — no subprocess, no network) and deterministic, so if
  // the probe succeeds the per-cluster constructions succeed too.
  const makeJudge = input.makeJudge ?? createJudge;
  let constructionFailure: JudgeFailure | null = null;
  if (useLlm) {
    try {
      makeJudge(config, config.judge.timeoutMs);
    } catch (err) {
      constructionFailure = {
        kind: "construction_error",
        message: err instanceof Error ? err.message : String(err),
      };
      reporter.warn(
        `Judge could not be constructed (${constructionFailure.message}); ranking all findings deterministically.`,
      );
    }
  }
  const canRunLlm = useLlm && constructionFailure === null;

  const spinner = reporter.spinner(
    `ranking ${clusters.length} finding${clusters.length === 1 ? "" : "s"} with the judge`,
  );
  // Retry notes collected during the concurrent run, flushed after the spinner
  // stops so a "retrying" line never interleaves with the animation.
  const retryNotes: string[] = [];
  let ranked: JudgeResult[];
  try {
    ranked = await mapWithConcurrency(clusters, config.judge.concurrency, async (cluster) => {
      const skeptic = skepticById.get(cluster.cluster_id) ?? null;
      // No LLM (mock backend), or the judge failed to construct: reconcile from
      // the deterministic rules and any construction failure — never a network call.
      if (!canRunLlm) return reconcileJudge(cluster, skeptic, null, constructionFailure);
      // Adaptive budget: a big merged cluster carries a proportionally bigger
      // prompt, so it gets a bigger slice than a singleton (clusterTimeout.ts).
      const timeoutMs = adaptiveClusterTimeoutMs(config.judge.timeoutMs, cluster);
      // Build the judge once; retryOnTimeout re-invokes the same closure (fresh
      // subprocess per call), so retries don't re-probe the backend.
      const judge = makeJudge(config, timeoutMs);
      let attempts = 0;
      try {
        const verdict = await retryOnTimeout(
          () => {
            attempts++;
            return judge(cluster, skeptic, packet);
          },
          {
            timeoutMs,
            retries: config.judge.retries,
            onTimeout: (attempt) =>
              retryNotes.push(
                `judge timed out on "${cluster.merged_title}" (attempt ${attempt}/${config.judge.retries + 1}) — retrying`,
              ),
          },
        );
        return reconcileJudge(cluster, skeptic, verdict, null, attempts);
      } catch (err) {
        // Any error (timeout / refusal / parse failure / unexpected) → keep, annotate.
        const failure = classifyFailure(err);
        if (failure.kind === "unexpected") {
          reporter.warn(`Unexpected judge error on "${cluster.merged_title}": ${failure.message}`);
        }
        return reconcileJudge(cluster, skeptic, null, failure, attempts);
      }
    });
  } finally {
    spinner.stop();
  }
  for (const note of retryNotes) reporter.note(note);

  // Surface every keep-on-failure fallback loudly (mirrors runSkeptic): a
  // finding ranked by fallback was never actually judged, and the user should
  // know that without reading ranked_findings.json.
  const titleById = new Map(clusters.map((c) => [c.cluster_id, c.merged_title]));
  for (const r of ranked) {
    if (r.failure !== null) {
      const retried = r.attempts > 1 ? ` after ${r.attempts} attempts` : "";
      reporter.warn(
        `judge ${r.failure.kind === "timeout" ? "timed out" : `failed (${r.failure.kind})`}${retried} on ` +
          `"${titleById.get(r.cluster_id) ?? r.cluster_id}" — classified deterministically (recall-first fallback)`,
      );
    }
  }
  return { ranked };
};
