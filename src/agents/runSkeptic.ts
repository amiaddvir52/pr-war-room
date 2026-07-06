import type { Config } from "../config/types.js";
import type { ReviewPacket } from "../context/types.js";
import { ReviewerTimeoutError, SkepticError } from "../errors.js";
import { hasHardFailure, runEvidenceChecks } from "../findings/evidenceChecks.js";
import type {
  EvidenceChecks,
  FindingCluster,
  SkepticFailure,
  SkepticResult,
  SkepticVerdict,
} from "../findings/schema.js";
import type { Reporter } from "../ui/reporter.js";
import { mapWithConcurrency } from "../util/mapWithConcurrency.js";
import { TIMEOUT_GRACE_MS, withTimeout } from "../util/withTimeout.js";
import { adaptiveClusterTimeoutMs } from "./clusterTimeout.js";
import { createSkeptic, type Skeptic } from "./SkepticAgent.js";

/**
 * Phase 8 orchestration (PRD §10.7). For every deduplicated cluster the skeptic
 * runs deterministic evidence checks and (unless the backend is `mock`) an LLM
 * skeptic, then reconciles the two into one decision. Clusters the skeptic drops
 * are excluded from the candidate list that feeds the Phase-9 judge.
 *
 * The design is conservative / recall-first (confirmed product decisions):
 *  - Only an OBJECTIVE deterministic hard failure (the file is not in the
 *    changeset at all) may drop a finding without model support. Weak anchoring
 *    (off-window / partial line refs) is a soft warning that downgrades, never
 *    drops — the model already sees it and can weigh it.
 *  - The model's `drop` is only honoured when it rules the finding `unsupported`
 *    with `high` false-positive risk; any other `drop` is softened to
 *    `downgrade` (kept, annotated). The raw model verdict is preserved separately
 *    from the final decision so the record never contradicts itself.
 *  - Keep-on-failure is real: if the skeptic times out, refuses, emits
 *    unparseable output, or cannot even be constructed, every affected finding is
 *    KEPT with the failure recorded — never dropped, and the review never aborts.
 */

export interface RunSkepticInput {
  clusters: FindingCluster[];
  packet: ReviewPacket;
  config: Config;
  reporter: Reporter;
  /**
   * Injected in tests to avoid the network; only called for non-`mock`
   * backends. `timeoutMs` is the adaptive per-cluster budget (see
   * clusterTimeout.ts) the returned skeptic's own model call should honour.
   */
  makeSkeptic?: (config: Config, timeoutMs?: number) => Skeptic;
}

export interface RunSkepticResult {
  results: SkepticResult[];
}

export type RunSkeptic = (input: RunSkepticInput) => Promise<RunSkepticResult>;

/** Classify a thrown skeptic error into a recorded failure (no message matching). */
function classifyFailure(err: unknown): SkepticFailure {
  if (err instanceof ReviewerTimeoutError) return { kind: "timeout", message: err.message };
  if (err instanceof SkepticError) return { kind: err.kind, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  // A non-skeptic Error is an unexpected (likely programming) failure: keep the
  // finding, but surface it rather than disguising it as a benign infra hiccup.
  return { kind: "unexpected", message };
}

/**
 * Combine the deterministic checks with the (optional) model verdict and any
 * failure into the persisted result. The order encodes the policy:
 *   1. objective hard failure  → drop (deterministic)
 *   2. skeptic could not run    → keep (fallback), failure recorded
 *   3. no model verdict (mock)  → keep, or downgrade if soft warnings
 *   4. model verdict            → its (recall-softened) recommendation
 */
export function reconcileResult(
  clusterId: string,
  checks: EvidenceChecks,
  modelVerdict: SkepticVerdict | null,
  failure: SkepticFailure | null,
): SkepticResult {
  // 1. Objective hard failure drops regardless of the model — but only this.
  if (hasHardFailure(checks)) {
    const reason = checks.hard_failures.map((f) => f.message).join(" ");
    return {
      cluster_id: clusterId,
      source: "deterministic",
      checks,
      model_verdict: modelVerdict,
      decision: { action: "drop", reason: `Deterministic hard failure — ${reason}`, softened_from_model_action: null },
      failure,
    };
  }

  // 2. Keep-on-failure: the skeptic could not produce a verdict. Keep, annotate.
  if (failure !== null) {
    return {
      cluster_id: clusterId,
      source: "fallback",
      checks,
      model_verdict: modelVerdict,
      decision: {
        action: "keep",
        reason: `Skeptic could not complete (${failure.kind}: ${failure.message}); kept pending human review.`,
        softened_from_model_action: null,
      },
      failure,
    };
  }

  // 3. Deterministic-only path (mock backend): keep, downgrade on soft warnings.
  if (modelVerdict === null) {
    const warned = checks.soft_warnings.length > 0;
    return {
      cluster_id: clusterId,
      source: "deterministic",
      checks,
      model_verdict: null,
      decision: {
        action: warned ? "downgrade" : "keep",
        reason: warned
          ? `Deterministic checks passed with warnings (${checks.soft_warnings.map((w) => w.code).join(", ")}); no LLM skeptic ran (mock backend).`
          : "Deterministic evidence checks passed; no LLM skeptic ran (mock backend).",
        softened_from_model_action: null,
      },
      failure: null,
    };
  }

  // 4. Model verdict stands, with recall-first softening of an over-eager drop.
  const dropAllowed =
    modelVerdict.support_level === "unsupported" && modelVerdict.false_positive_risk === "high";
  const softened = modelVerdict.recommended_action === "drop" && !dropAllowed;
  return {
    cluster_id: clusterId,
    source: "llm",
    checks,
    model_verdict: modelVerdict,
    decision: {
      action: softened ? "downgrade" : modelVerdict.recommended_action,
      reason: softened
        ? `Model recommended drop, but support was not "unsupported" + high risk; softened to downgrade (recall-first). ${modelVerdict.reasoning_summary}`
        : modelVerdict.reasoning_summary,
      softened_from_model_action: softened ? "drop" : null,
    },
    failure: null,
  };
}

/**
 * Filter clusters to those the skeptic did not drop — the candidate list that
 * feeds the Phase-9 judge. A cluster with no matching result is kept
 * (recall-first). The single source of truth for "supported", shared by the
 * review command now and the judge later.
 */
export function selectSupportedClusters(
  clusters: FindingCluster[],
  results: SkepticResult[],
): FindingCluster[] {
  const byId = new Map(results.map((r) => [r.cluster_id, r]));
  return clusters.filter((c) => byId.get(c.cluster_id)?.decision.action !== "drop");
}

export const runSkeptic: RunSkeptic = async (input) => {
  const { clusters, packet, config, reporter } = input;
  if (clusters.length === 0) return { results: [] };

  // Tie the skeptic's "near the diff" window to the context the reviewer was
  // actually shown, so raising nearbyContextLines can't make the gate reject
  // lines the reviewer could legitimately anchor.
  const nearbyWindow = config.context.nearbyContextLines;

  // `mock` has no model client (like the reviewer fan-out): validate purely from
  // the deterministic checks instead of asking createModelClient for a mock.
  const useLlm = config.skeptic.backend !== "mock";
  const makeSkeptic = input.makeSkeptic ?? createSkeptic;

  // Probe skeptic construction once, up front, so a misconfigured backend warns
  // a single time. A construction failure must NOT abort the review
  // (recall-first): record it and let every finding fall through to a
  // keep-on-failure fallback below. Per-cluster construction below is cheap
  // (closures over config — no subprocess, no network) and deterministic, so if
  // the probe succeeds the per-cluster constructions succeed too.
  let constructionFailure: SkepticFailure | null = null;
  if (useLlm) {
    try {
      makeSkeptic(config, config.skeptic.timeoutMs);
    } catch (err) {
      constructionFailure = { kind: "construction_error", message: err instanceof Error ? err.message : String(err) };
      reporter.warn(
        `Skeptic could not be constructed (${constructionFailure.message}); keeping all findings for human review.`,
      );
    }
  }
  const canRunLlm = useLlm && constructionFailure === null;

  const spinner = reporter.spinner(
    `validating ${clusters.length} cluster${clusters.length === 1 ? "" : "s"} with the skeptic`,
  );
  let results: SkepticResult[];
  try {
    results = await mapWithConcurrency(clusters, config.skeptic.concurrency, async (cluster) => {
      const checks = runEvidenceChecks(cluster, packet, nearbyWindow);
      // No LLM (mock backend), or the skeptic failed to construct: reconcile from
      // the checks and any construction failure — never a network call.
      if (!canRunLlm) return reconcileResult(cluster.cluster_id, checks, null, constructionFailure);
      // Adaptive budget: a big merged cluster carries a proportionally bigger
      // prompt, so it gets a bigger slice than a singleton (clusterTimeout.ts).
      const timeoutMs = adaptiveClusterTimeoutMs(config.skeptic.timeoutMs, cluster);
      try {
        const skeptic = makeSkeptic(config, timeoutMs);
        const verdict = await withTimeout(
          skeptic(cluster, packet, checks),
          timeoutMs + TIMEOUT_GRACE_MS,
        );
        return reconcileResult(cluster.cluster_id, checks, verdict, null);
      } catch (err) {
        // Any error (timeout / refusal / parse failure / unexpected) → keep, annotate.
        const failure = classifyFailure(err);
        if (failure.kind === "unexpected") {
          reporter.warn(`Unexpected skeptic error on "${cluster.merged_title}": ${failure.message}`);
        }
        return reconcileResult(cluster.cluster_id, checks, null, failure);
      }
    });
  } finally {
    spinner.stop();
  }

  // Surface every keep-on-failure fallback loudly — the whole point of the
  // fallback is that the precision gate sat out, and that must never be silent
  // (demo follow-up: "the report/artifacts must clearly say so").
  const titleById = new Map(clusters.map((c) => [c.cluster_id, c.merged_title]));
  for (const r of results) {
    if (r.failure !== null && r.decision.action !== "drop") {
      reporter.warn(
        `skeptic ${r.failure.kind === "timeout" ? "timed out" : `failed (${r.failure.kind})`} on ` +
          `"${titleById.get(r.cluster_id) ?? r.cluster_id}" — finding kept by recall-first fallback, unvalidated`,
      );
    }
  }
  return { results };
};
