import type { FindingCluster } from "../findings/schema.js";

/**
 * Adaptive per-cluster timeout for the skeptic and judge (Phase 8/9).
 *
 * The first TaskFlow demo run showed the flat 60s per-cluster timeout was too
 * tight: two clusters hit it and were kept only by the recall-first fallback,
 * meaning the precision gate silently sat out. A big merged cluster also
 * carries a proportionally bigger prompt (more members → more evidence → more
 * for the model to weigh), so the budget scales with cluster size: the base
 * timeout, plus `TIMEOUT_SCALE_PER_MEMBER` of it per additional source
 * finding, capped at `MAX_TIMEOUT_SCALE`×.
 */
export const TIMEOUT_SCALE_PER_MEMBER = 0.2;
export const MAX_TIMEOUT_SCALE = 3;

/** The effective timeout for validating/ranking `cluster`, in ms. */
export function adaptiveClusterTimeoutMs(baseMs: number, cluster: FindingCluster): number {
  const extraMembers = Math.max(0, cluster.source_finding_ids.length - 1);
  const scale = Math.min(MAX_TIMEOUT_SCALE, 1 + TIMEOUT_SCALE_PER_MEMBER * extraMembers);
  return Math.round(baseMs * scale);
}
