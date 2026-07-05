import type {
  FalsePositiveRisk,
  FinalFinding,
  FindingCluster,
  JudgeClassification,
  JudgeResult,
  SkepticResult,
  SupportLevel,
} from "./schema.js";
import { SEVERITY_RANK } from "./validateFinding.js";

/**
 * Deterministic scoring & selection for the judge (Phase 9, PRD §10.8). Pure,
 * dependency-free functions over a cluster and its skeptic result, so the
 * ranking's numeric ordering is reproducible and explainable — the model owns
 * the *classification*, but the *score* that orders findings is computed here
 * (see `JudgeDecision` in `schema.ts` for the rationale).
 */

/**
 * Weights for the composite priority score. Documented and tunable; they sum to
 * 1 so the blend stays in `[0, 1]` before the false-positive-risk multiplier.
 * Severity and human-review-likelihood dominate because §9.3 makes "would a
 * human reviewer care?" the product's north star.
 */
export const SCORE_WEIGHTS = {
  severity: 0.3,
  humanReviewLikelihood: 0.25,
  skepticSupport: 0.15,
  agreement: 0.1,
  confidence: 0.2,
} as const;

/** Map a skeptic support level to a `[0, 1]` signal. */
const SUPPORT_SCORE: Record<SupportLevel, number> = {
  strong: 1,
  medium: 0.66,
  weak: 0.33,
  unsupported: 0,
};

/**
 * Multiplier applied after the weighted blend when the skeptic flagged a
 * false-positive risk — a high risk shaves the score without changing the
 * classification (that stays the model's / the deterministic rules' call).
 */
const FP_RISK_MULTIPLIER: Record<FalsePositiveRisk, number> = {
  low: 1,
  medium: 0.9,
  high: 0.75,
};

/** Agreement past three independent reviewers adds no further signal. */
const AGREEMENT_CAP = 3;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * A `[0, 1]` support signal for a cluster. Prefer the skeptic model's graded
 * `support_level`; when no model ran (mock / deterministic / fallback) fall back
 * to whether the cluster was kept (0.6) vs. downgraded (0.4); with no skeptic
 * result at all (skeptic disabled) use a neutral 0.5.
 */
function supportSignal(skeptic: SkepticResult | null): number {
  const level = skeptic?.model_verdict?.support_level;
  if (level !== undefined) return SUPPORT_SCORE[level];
  if (skeptic !== null) return skeptic.decision.action === "downgrade" ? 0.4 : 0.6;
  return 0.5;
}

/**
 * Whether a cluster is "well supported" — used both by the deterministic
 * classification and the recall-first drop guard. A graded model support of
 * strong/medium counts; absent a model verdict, a skeptic `keep` counts.
 */
export function isWellSupported(skeptic: SkepticResult | null): boolean {
  const level = skeptic?.model_verdict?.support_level;
  if (level !== undefined) return level === "strong" || level === "medium";
  return skeptic !== null && skeptic.decision.action === "keep";
}

/**
 * The authoritative, reproducible priority score in `[0, 1]` for a cluster.
 * A weighted blend of normalized severity, human-review likelihood, skeptic
 * support, independent-reviewer agreement, and confidence, scaled down by any
 * false-positive risk the skeptic flagged. Higher = more worth a human's time.
 */
export function computePriorityScore(
  cluster: FindingCluster,
  skeptic: SkepticResult | null,
): number {
  const severity = SEVERITY_RANK[cluster.severity] / SEVERITY_RANK.blocker; // blocker → 1
  const agreement = Math.min(cluster.agreement, AGREEMENT_CAP) / AGREEMENT_CAP;

  const blend =
    SCORE_WEIGHTS.severity * severity +
    SCORE_WEIGHTS.humanReviewLikelihood * cluster.human_review_likelihood +
    SCORE_WEIGHTS.skepticSupport * supportSignal(skeptic) +
    SCORE_WEIGHTS.agreement * agreement +
    SCORE_WEIGHTS.confidence * cluster.confidence;

  const risk = skeptic?.model_verdict?.false_positive_risk;
  const multiplier = risk !== undefined ? FP_RISK_MULTIPLIER[risk] : 1;

  return clamp01(blend * multiplier);
}

/**
 * The deterministic classification for a cluster — used by the mock/offline
 * path and as the keep-on-failure fallback. Recall-first: it NEVER returns
 * `drop` (only the model may drop a finding). Severity drives the bucket;
 * a medium-severity finding is promoted to should-fix only when it is
 * well-supported, otherwise it lands in nice-to-have.
 */
export function deterministicClassification(
  cluster: FindingCluster,
  skeptic: SkepticResult | null,
): JudgeClassification {
  const rank = SEVERITY_RANK[cluster.severity];
  if (rank >= SEVERITY_RANK.blocker) return "blocker";
  if (rank >= SEVERITY_RANK.high) return "should_fix_before_review";
  if (rank >= SEVERITY_RANK.medium) {
    return isWellSupported(skeptic) ? "should_fix_before_review" : "nice_to_have";
  }
  return "nice_to_have"; // low / info — kept, deprioritized, never dropped here
}

/**
 * Whether the judge model's `drop` should be softened to `nice_to_have` rather
 * than honoured. Protects recall: a high-severity finding that is well-supported
 * OR independently reported by ≥2 reviewers is too important to disappear from
 * the report entirely on a single model's say-so, so it is kept (deprioritized)
 * and annotated instead. Mirrors the skeptic's drop→downgrade softening.
 */
export function shouldProtectFromDrop(
  cluster: FindingCluster,
  skeptic: SkepticResult | null,
): boolean {
  const highSeverity = SEVERITY_RANK[cluster.severity] >= SEVERITY_RANK.high;
  return highSeverity && (isWellSupported(skeptic) || cluster.agreement >= 2);
}

/** Report priority: higher sorts first. Mirrors §10.8's blocker → … order. */
export const CLASSIFICATION_PRIORITY: Record<JudgeClassification, number> = {
  blocker: 3,
  should_fix_before_review: 2,
  nice_to_have: 1,
  drop: 0,
};

/**
 * Build the ordered, report-ready `final_findings.json` from the judge results:
 * keep every cluster the judge marked `include_in_main_report`, join it with its
 * classification/score/reasoning and the skeptic's support level, then sort by
 * classification (blocker first), score (desc), and cluster id (stable tiebreak).
 * Dropped clusters are excluded here but remain in `ranked_findings.json`.
 */
export function selectFinalFindings(
  clusters: FindingCluster[],
  ranked: JudgeResult[],
  skepticResults: SkepticResult[],
): FinalFinding[] {
  const clusterById = new Map(clusters.map((c) => [c.cluster_id, c]));
  const skepticById = new Map(skepticResults.map((r) => [r.cluster_id, r]));

  const final: FinalFinding[] = [];
  for (const result of ranked) {
    if (!result.decision.include_in_main_report) continue;
    const cluster = clusterById.get(result.cluster_id);
    if (cluster === undefined) continue; // defensive: ranked id with no cluster
    const skeptic = skepticById.get(result.cluster_id) ?? null;
    final.push({
      ...cluster,
      final_classification: result.decision.classification,
      final_score: result.decision.score,
      judge_reasoning: result.decision.reason,
      skeptic_support_level: skeptic?.model_verdict?.support_level ?? null,
    });
  }

  final.sort((a, b) => {
    const byClass =
      CLASSIFICATION_PRIORITY[b.final_classification] -
      CLASSIFICATION_PRIORITY[a.final_classification];
    if (byClass !== 0) return byClass;
    if (b.final_score !== a.final_score) return b.final_score - a.final_score;
    return a.cluster_id.localeCompare(b.cluster_id);
  });

  return final;
}
