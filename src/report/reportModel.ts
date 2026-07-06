import type { PacketVerification, ReviewPacket } from "../context/types.js";
import type {
  FinalFinding,
  FindingCluster,
  JudgeClassification,
  JudgeResult,
  SkepticResult,
  SupportLevel,
} from "../findings/schema.js";
import {
  CLASSIFICATION_PRIORITY,
  computePriorityScore,
  deterministicClassification,
} from "../findings/scoreFindings.js";
import type { ArtifactPaths } from "../storage/artifactPaths.js";
import { plural } from "./markdownHelpers.js";

/**
 * The shared, renderer-agnostic model behind the Phase-10 reports. Both the
 * HTML report (primary) and the Markdown report (secondary/legacy) consume the
 * same `ReportInput` and the same derivations below, so the two renderings can
 * never disagree about the pool, the verdict, or what was dropped.
 */

export interface ReportInput {
  /** Phase-4 packet — PR header + condensed verification results. */
  packet: ReviewPacket;
  /** ALL clusters (Phase 7) — resolves dropped-finding titles; degraded-mode body. */
  clusters: FindingCluster[];
  /** Skeptic-supported subset that fed the judge; degraded-mode body input. */
  candidates: FindingCluster[];
  /** Skeptic results (Phase 8); `[]` when skeptic disabled. Includes drops. */
  skepticResults: SkepticResult[];
  /** Judge results (Phase 9); `null` when judge disabled. Includes drops. */
  ranked: JudgeResult[] | null;
  /** Report-ready findings (Phase 9), sorted, drops excluded; `null` when judge disabled. */
  final: FinalFinding[] | null;
  /** Raw normalized finding count (pre-dedup) — the funnel's origin. */
  rawFindingCount: number;
  /** Provenance for the footer/header. */
  meta: { toolVersion: string; generatedAt: string; runId: string };
  options: {
    maxFindings: number;
    includeNiceToHave: boolean;
    judgeEnabled: boolean;
    skepticEnabled: boolean;
  };
  /** Artifact layout — used to compute relative links from the report files. */
  paths: ArtifactPaths;
}

/**
 * The normalized unit the report bodies render, identical whether the judge ran
 * or not. When the judge is disabled we synthesize it from the deterministic
 * scoring rules so the report reads the same as a deterministic-judge run.
 */
export interface ReportFinding {
  cluster: FindingCluster;
  classification: Exclude<JudgeClassification, "drop">;
  score: number;
  support: SupportLevel | null;
  /** Full skeptic record (null when the skeptic is disabled or didn't cover it). */
  skeptic: SkepticResult | null;
  /** Full judge record (null when the judge is disabled). */
  judge: JudgeResult | null;
}

/** `deterministicClassification` never returns `drop`, and `final` excludes drops. */
export function narrowClassification(
  c: JudgeClassification,
): Exclude<JudgeClassification, "drop"> {
  return c === "drop" ? "nice_to_have" : c;
}

/** The included findings, sorted blocker-first / score-descending. */
export function buildPool(input: ReportInput): ReportFinding[] {
  const skepticById = new Map(input.skepticResults.map((r) => [r.cluster_id, r]));
  const judgeById = new Map((input.ranked ?? []).map((r) => [r.cluster_id, r]));

  // Judge ran: `final` is the report-ready, already-sorted (blocker → …, score
  // desc) join. A FinalFinding structurally IS a FindingCluster, so reuse it.
  if (input.final !== null) {
    return input.final.map((f) => ({
      cluster: f,
      classification: narrowClassification(f.final_classification),
      score: f.final_score,
      support: f.skeptic_support_level,
      skeptic: skepticById.get(f.cluster_id) ?? null,
      judge: judgeById.get(f.cluster_id) ?? null,
    }));
  }

  // Judge disabled: synthesize from the skeptic-supported candidates using the
  // same deterministic rules the offline judge path uses, then sort identically.
  const synthesized = input.candidates.map((cluster): ReportFinding => {
    const skeptic = skepticById.get(cluster.cluster_id) ?? null;
    return {
      cluster,
      classification: narrowClassification(deterministicClassification(cluster, skeptic)),
      score: computePriorityScore(cluster, skeptic),
      support: skeptic?.model_verdict?.support_level ?? null,
      skeptic,
      judge: null,
    };
  });

  synthesized.sort((a, b) => {
    const byClass =
      CLASSIFICATION_PRIORITY[b.classification] - CLASSIFICATION_PRIORITY[a.classification];
    if (byClass !== 0) return byClass;
    if (b.score !== a.score) return b.score - a.score;
    return a.cluster.cluster_id.localeCompare(b.cluster.cluster_id);
  });
  return synthesized;
}

export interface DroppedEntry {
  title: string;
  reason: string;
  stage: "skeptic" | "judge";
}

/** Findings dropped by the skeptic or the judge, with the reason and stage. */
export function collectDropped(input: ReportInput): DroppedEntry[] {
  const clusterById = new Map(input.clusters.map((c) => [c.cluster_id, c]));
  const titleOf = (id: string): string => clusterById.get(id)?.merged_title ?? id;

  const entries: DroppedEntry[] = [];
  for (const r of input.skepticResults) {
    if (r.decision.action === "drop") {
      entries.push({ title: titleOf(r.cluster_id), reason: r.decision.reason, stage: "skeptic" });
    }
  }
  if (input.ranked !== null) {
    for (const r of input.ranked) {
      if (r.decision.classification === "drop") {
        entries.push({ title: titleOf(r.cluster_id), reason: r.decision.reason, stage: "judge" });
      }
    }
  }
  return entries;
}

/** Qualitative readiness verdict derived from the true bucket totals + verification. */
export function readinessVerdict(
  blockers: number,
  shouldFix: number,
  verification: PacketVerification,
): string {
  if (blockers > 0) {
    return `Not ready — ${blockers} ${plural(blockers, "blocker")} must be fixed before human review.`;
  }
  if (shouldFix > 0) {
    return `Needs work — ${shouldFix} ${plural(shouldFix, "item")} to address before requesting review.`;
  }
  if (verification.ran && !verification.allPassed) {
    return "Caution — no blockers found, but verification failed.";
  }
  return verification.ran
    ? "Looks ready for human review."
    : "Looks ready for human review. Verification not run — pass `--verify` to confirm.";
}

export function verificationSummary(v: PacketVerification): string {
  if (!v.ran) return "not run";
  return v.allPassed ? "all commands passed ✓" : "failures present ✗";
}

/**
 * How the precision gates actually behaved — LLM verdicts vs deterministic
 * paths vs keep-on-failure fallbacks (timeouts etc.). Rendered in both report
 * summaries so a fallback is never silent.
 */
export interface GateSummary {
  llm: number;
  deterministic: number;
  fallback: number;
  /** The fallback subset that specifically timed out. */
  timeouts: number;
}

/**
 * One tally for both gates: skeptic and judge results share the exact
 * `source` vocabulary and failure shape, so a single summarizer keeps the two
 * gate notes counting by the same rules forever.
 */
export function summarizeGate(
  results: ReadonlyArray<Pick<SkepticResult | JudgeResult, "source" | "failure">>,
): GateSummary {
  const s: GateSummary = { llm: 0, deterministic: 0, fallback: 0, timeouts: 0 };
  for (const r of results) {
    s[r.source]++;
    if (r.failure?.kind === "timeout") s.timeouts++;
  }
  return s;
}

/** One funnel stage: how many findings survived to this point, and why. */
export interface FunnelStage {
  key: "raw" | "clusters" | "skeptic" | "judge";
  label: string;
  value: number;
  hint: string;
}

/**
 * The review funnel both renderers draw: raw findings → clusters, plus the
 * skeptic/judge stages when those gates are enabled. Owned here so the HTML
 * and Markdown funnels can never disagree about the stage set or its gating.
 */
export function buildFunnel(input: ReportInput): FunnelStage[] {
  const stages: FunnelStage[] = [
    { key: "raw", label: "Raw findings", value: input.rawFindingCount, hint: "from all reviewers" },
    { key: "clusters", label: "Clusters", value: input.clusters.length, hint: "after dedup" },
  ];
  if (input.options.skepticEnabled) {
    stages.push({ key: "skeptic", label: "Supported", value: input.candidates.length, hint: "after skeptic" });
  }
  if (input.options.judgeEnabled) {
    stages.push({ key: "judge", label: "In report", value: input.final?.length ?? 0, hint: "after judge" });
  }
  return stages;
}
