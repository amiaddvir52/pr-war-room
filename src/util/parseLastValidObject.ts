import type { z } from "zod";
import { extractJsonObjects } from "./extractJsonObjects.js";

/**
 * Extract every brace-balanced `{…}` object from `text` and return the LAST
 * one that validates against `schema`. A reasoning model states its conclusion
 * last, so keeping the last valid object ignores earlier illustrative/example
 * objects in the prose. Uses the shared string-aware extractor, so a lone
 * unbalanced quote in the model's text cannot swallow the real object.
 * Returns `null` when none validate.
 *
 * Shared by the model-output parsers (judge, fix agent — FOLLOWUPS #1 tracks
 * migrating the reviewer/skeptic/dedup copies of this loop here too).
 */
export function parseLastValidObject<T>(text: string, schema: z.ZodType<T>): T | null {
  let decided: T | null = null;
  for (const candidate of extractJsonObjects(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // Balanced braces but not valid JSON (e.g. `{x}`) — skip it.
      continue;
    }
    const result = schema.safeParse(parsed);
    if (result.success) decided = result.data;
  }
  return decided;
}
