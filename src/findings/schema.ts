import { z } from "zod";

/**
 * Finding schema (PRD §10.5) — the single source of truth for both runtime
 * validation and the inferred `Finding` TypeScript type, following the same
 * Zod-first pattern as `config/schema.ts`. Later phases (dedupe, skeptic,
 * judge) build on these shapes.
 *
 * There are two levels:
 *   - `FindingCore`     — the fields a reviewer model produces.
 *   - `Finding`         — a normalized finding = core + provenance (`id`,
 *                         `source_agent`, `raw_agent_output_ref`) that we assign
 *                         ourselves so ids are unique and the model has less to
 *                         get wrong.
 */

export const FINDING_CATEGORIES = [
  "correctness",
  "tests",
  "security",
  "performance",
  "maintainability",
  "product",
  "style",
  "other",
] as const;

export const FINDING_SEVERITIES = ["blocker", "high", "medium", "low", "info"] as const;

export const FindingCategorySchema = z.enum(FINDING_CATEGORIES);
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);

export type FindingCategory = z.infer<typeof FindingCategorySchema>;
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** The finding fields a reviewer model returns (no provenance). */
export const FindingCoreSchema = z.object({
  title: z.string().min(1),
  category: FindingCategorySchema,
  severity: FindingSeveritySchema,
  // Structured outputs can't enforce numeric ranges, so Zod is the guard here.
  confidence: z.number().min(0).max(1),
  file: z.string().nullable(),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  claim: z.string(),
  // At least one concrete piece of evidence — the product's core principle
  // (§9.1 "evidence over opinion"). Empty-string entries are pruned later.
  evidence: z.array(z.string()).min(1),
  suggested_fix: z.string().nullable(),
  suggested_test: z.string().nullable(),
  human_review_likelihood: z.number().min(0).max(1),
  needs_code_change: z.boolean(),
});

export type FindingCore = z.infer<typeof FindingCoreSchema>;

/** A normalized finding: core fields plus the provenance we assign. */
export const FindingSchema = FindingCoreSchema.extend({
  id: z.string(),
  source_agent: z.string(),
  raw_agent_output_ref: z.string(),
});

export type Finding = z.infer<typeof FindingSchema>;

/**
 * A cluster of one or more findings that describe the same underlying issue
 * (PRD §10.6 / Phase 7). Deduplication merges overlapping findings from the
 * independent reviewers into clusters; every finding ends up in exactly one
 * cluster, singletons included, so the skeptic (Phase 8) and judge (Phase 9)
 * operate on a single uniform unit.
 *
 * `source_agents` and `agreement` go beyond the literal PRD schema: the Phase 9
 * judge wants a "source agent agreement count", and it is free to compute here.
 */
export const FindingClusterSchema = z.object({
  // Assigned after a deterministic sort: "cluster-001", "cluster-002", …
  cluster_id: z.string(),
  // The representative finding's title (deterministic — no LLM synthesis).
  merged_title: z.string(),
  // Ids of every source finding in the cluster (stable references back to
  // `normalized/all_findings.json`).
  source_finding_ids: z.array(z.string()).min(1),
  // Distinct agents that contributed a finding to this cluster.
  source_agents: z.array(z.string()).min(1),
  // Number of distinct contributing agents (= source_agents.length). A strong
  // signal for the judge: independent agreement raises human-review likelihood.
  agreement: z.number().int().positive(),
  category: FindingCategorySchema,
  // Max severity across members (§10.6: at least as high as the highest source).
  severity: FindingSeveritySchema,
  confidence: z.number().min(0).max(1),
  human_review_likelihood: z.number().min(0).max(1),
  file: z.string().nullable(),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  claim: z.string(),
  // Union of member evidence (§10.6: keeps useful evidence from all sources).
  evidence: z.array(z.string()).min(1),
  suggested_fix: z.string().nullable(),
  suggested_test: z.string().nullable(),
  needs_code_change: z.boolean(),
});

export type FindingCluster = z.infer<typeof FindingClusterSchema>;

/**
 * Structured-output root handed to the model. The Messages API requires an
 * object root with `additionalProperties: false`, so findings are wrapped in a
 * single `findings` property.
 */
export const ReviewerResponseSchema = z.object({
  findings: z.array(FindingCoreSchema),
});

export type ReviewerResponse = z.infer<typeof ReviewerResponseSchema>;

/**
 * Hand-written JSON Schema for `output_config.format` (structured outputs).
 * Kept beside the Zod schema so the two stay in lockstep. Numeric ranges and
 * array-length constraints are intentionally omitted — structured outputs do
 * not support them; `FindingCoreSchema` enforces those client-side on parse.
 * Every object is closed (`additionalProperties: false`) and lists all its
 * properties as required, as structured outputs demand.
 */
export const REVIEWER_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "category",
          "severity",
          "confidence",
          "file",
          "line_start",
          "line_end",
          "claim",
          "evidence",
          "suggested_fix",
          "suggested_test",
          "human_review_likelihood",
          "needs_code_change",
        ],
        properties: {
          title: { type: "string" },
          category: { type: "string", enum: [...FINDING_CATEGORIES] },
          severity: { type: "string", enum: [...FINDING_SEVERITIES] },
          confidence: { type: "number" },
          file: { type: ["string", "null"] },
          line_start: { type: "integer" },
          line_end: { type: "integer" },
          claim: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          suggested_fix: { type: ["string", "null"] },
          suggested_test: { type: ["string", "null"] },
          human_review_likelihood: { type: "number" },
          needs_code_change: { type: "boolean" },
        },
      },
    },
  },
};

/**
 * Skeptic / evidence-validation schema (PRD §10.7 / Phase 8). For every cluster
 * the skeptic tries to *disprove* the finding and reports whether it survives.
 *
 * The persisted record deliberately keeps three things separate so no field
 * ever contradicts another:
 *   - `SkepticVerdict`  — the RAW fields the skeptic model returns (its opinion).
 *   - `EvidenceChecks`  — the deterministic checks (hard failures / soft
 *                         warnings / boolean signals).
 *   - `SkepticDecision` — the FINAL decision (keep/downgrade/drop) the phase
 *                         actually acts on, plus why. The model verdict is
 *                         advisory; the decision is authoritative.
 */
export const SUPPORT_LEVELS = ["strong", "medium", "weak", "unsupported"] as const;
export const FALSE_POSITIVE_RISKS = ["low", "medium", "high"] as const;
export const RECOMMENDED_ACTIONS = ["keep", "downgrade", "drop"] as const;

export const SupportLevelSchema = z.enum(SUPPORT_LEVELS);
export const FalsePositiveRiskSchema = z.enum(FALSE_POSITIVE_RISKS);
export const RecommendedActionSchema = z.enum(RECOMMENDED_ACTIONS);

export type SupportLevel = z.infer<typeof SupportLevelSchema>;
export type FalsePositiveRisk = z.infer<typeof FalsePositiveRiskSchema>;
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/**
 * Deterministic evidence-issue kinds.
 *   - `file_not_in_changeset` is a HARD failure: the finding references a file
 *     that is not part of the PR at all, so it is objectively out of scope and
 *     may be dropped without model support.
 *   - the rest are SOFT warnings: they downgrade/annotate a finding (weak
 *     anchoring) but never drop it on their own — recall-first.
 */
export const EVIDENCE_ISSUE_CODES = [
  "file_not_in_changeset", // hard
  "partial_anchor", // soft: only one of line_start/line_end was set
  "inverted_anchor", // soft: line_end < line_start
  "line_outside_diff", // soft: lines neither in a hunk nor within the nearby window
] as const;
export const EvidenceIssueCodeSchema = z.enum(EVIDENCE_ISSUE_CODES);
export type EvidenceIssueCode = z.infer<typeof EvidenceIssueCodeSchema>;

export const EvidenceIssueSchema = z.object({
  code: EvidenceIssueCodeSchema,
  message: z.string(),
});
export type EvidenceIssue = z.infer<typeof EvidenceIssueSchema>;

/**
 * Boolean signals derived from the deterministic checks. `line_in_diff` /
 * `line_near_diff` are `null` when they cannot be evaluated (no line anchor, no
 * patch, or no parseable hunks) — a null is "unknown", never a failure.
 */
export const EvidenceSignalsSchema = z.object({
  file_in_changeset: z.boolean(),
  has_line_anchor: z.boolean(),
  line_in_diff: z.boolean().nullable(),
  line_near_diff: z.boolean().nullable(),
});
export type EvidenceSignals = z.infer<typeof EvidenceSignalsSchema>;

/**
 * Deterministic (no-LLM) evidence checks run against the review packet. Hard
 * failures are objective, out-of-scope problems that may drop a finding without
 * the model; soft warnings only downgrade/annotate. `notes` is the
 * human-readable evidence trail (shown to the model and in the report).
 */
export const EvidenceChecksSchema = z.object({
  hard_failures: z.array(EvidenceIssueSchema),
  soft_warnings: z.array(EvidenceIssueSchema),
  signals: EvidenceSignalsSchema,
  notes: z.array(z.string()),
});

export type EvidenceChecks = z.infer<typeof EvidenceChecksSchema>;

/** The skeptic model's raw verdict for one cluster (advisory input, not the decision). */
export const SkepticVerdictSchema = z.object({
  is_supported: z.boolean(),
  support_level: SupportLevelSchema,
  false_positive_risk: FalsePositiveRiskSchema,
  reasoning_summary: z.string(),
  recommended_action: RecommendedActionSchema,
});

export type SkepticVerdict = z.infer<typeof SkepticVerdictSchema>;

/**
 * The final, authoritative decision for a cluster. `action` is what feeds the
 * Phase-9 judge (`drop` = excluded from candidates). `softened_from_model_action`
 * records when the model's recommendation was softened for recall (e.g. a `drop`
 * kept as `downgrade`), so the audit trail is explicit rather than contradictory.
 */
export const SkepticDecisionSchema = z.object({
  action: RecommendedActionSchema,
  reason: z.string(),
  softened_from_model_action: RecommendedActionSchema.nullable(),
});

export type SkepticDecision = z.infer<typeof SkepticDecisionSchema>;

/**
 * Why the skeptic could not produce a model verdict for a cluster. Recorded (not
 * swallowed) so a fallback-keep is auditable; `unexpected` marks a programming
 * error that is surfaced, not silently treated as an infra hiccup.
 */
export const SKEPTIC_FAILURE_KINDS = [
  "timeout",
  "refusal",
  "max_tokens",
  "parse_error",
  "backend_error",
  "construction_error",
  "unexpected",
] as const;
export const SkepticFailureKindSchema = z.enum(SKEPTIC_FAILURE_KINDS);
export type SkepticFailureKind = z.infer<typeof SkepticFailureKindSchema>;

export const SkepticFailureSchema = z.object({
  kind: SkepticFailureKindSchema,
  message: z.string(),
});
export type SkepticFailure = z.infer<typeof SkepticFailureSchema>;

/**
 * How the final decision was reached:
 *   - `llm`           — the skeptic model answered; the decision reflects its
 *                       (recall-softened) verdict.
 *   - `deterministic` — decided by the evidence checks alone (a hard-failure
 *                       drop, or the mock backend's checks-only path).
 *   - `fallback`      — the skeptic could not run (see `failure`); the finding is
 *                       kept pending review.
 */
export const SKEPTIC_SOURCES = ["llm", "deterministic", "fallback"] as const;
export const SkepticSourceSchema = z.enum(SKEPTIC_SOURCES);
export type SkepticSource = z.infer<typeof SkepticSourceSchema>;

/** The per-cluster record written to `skeptic/skeptic_results.json`. */
export const SkepticResultSchema = z.object({
  cluster_id: z.string(),
  source: SkepticSourceSchema,
  checks: EvidenceChecksSchema,
  // The raw model verdict, or null when no model ran (mock / construction /
  // infra failure). Kept separate from `decision` so the two never contradict.
  model_verdict: SkepticVerdictSchema.nullable(),
  decision: SkepticDecisionSchema,
  // Non-null only when the skeptic could not complete for this cluster.
  failure: SkepticFailureSchema.nullable(),
});

export type SkepticResult = z.infer<typeof SkepticResultSchema>;

/**
 * Structured-output JSON Schema for the skeptic verdict. Same convention as
 * `REVIEWER_OUTPUT_JSON_SCHEMA`: closed object, every property required, enums
 * inlined; the value semantics are re-checked by `SkepticVerdictSchema` on parse.
 */
export const SKEPTIC_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "is_supported",
    "support_level",
    "false_positive_risk",
    "reasoning_summary",
    "recommended_action",
  ],
  properties: {
    is_supported: { type: "boolean" },
    support_level: { type: "string", enum: [...SUPPORT_LEVELS] },
    false_positive_risk: { type: "string", enum: [...FALSE_POSITIVE_RISKS] },
    reasoning_summary: { type: "string" },
    recommended_action: { type: "string", enum: [...RECOMMENDED_ACTIONS] },
  },
};
