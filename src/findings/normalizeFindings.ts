import type { Finding, FindingCore } from "./schema.js";

/**
 * Turn a reviewer's validated core findings into normalized `Finding`s by
 * assigning the provenance fields (PRD §10.5). We assign `id`, `source_agent`,
 * and `raw_agent_output_ref` ourselves rather than trusting the model, which
 * guarantees stable, unique ids (`<agent>-001`, `<agent>-002`, …).
 *
 * Pure — the orchestrator (`runReviewers`) is responsible for merging every
 * reviewer's findings and writing the `normalized/all_findings.json` artifact.
 */

export interface NormalizeOptions {
  /** The producing agent's name, e.g. `"claude"`. Used for ids and provenance. */
  agent: string;
  /** Reference back to the raw output artifact, e.g. `"raw/claude_review.md"`. */
  rawRef: string;
}

export function normalizeFindings(cores: FindingCore[], opts: NormalizeOptions): Finding[] {
  return cores.map((core, i) => ({
    id: `${opts.agent}-${String(i + 1).padStart(3, "0")}`,
    source_agent: opts.agent,
    ...core,
    raw_agent_output_ref: opts.rawRef,
  }));
}
