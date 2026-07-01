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
