/**
 * Extract every brace-balanced `{…}` substring from `text`, in source order.
 *
 * Shared by the model-output parsers (reviewer, dedup adjudicator, skeptic):
 * the API path returns pure JSON, but the CLI paths are only prompt-guided, so
 * the model may wrap the object in prose or ```json fences that themselves
 * contain braces.
 *
 * Each candidate is scanned with its OWN fresh string state starting at its
 * opening brace, so a stray/unbalanced double-quote in the surrounding prose
 * cannot flip the scanner into "inside a string" and swallow a well-formed
 * object that follows it. (A single global string-state machine has exactly
 * that bug: one lone `"` before the JSON eats the rest of the text.)
 *
 * Callers `JSON.parse` + schema-validate each candidate and typically keep the
 * last valid one, so non-JSON candidates like `{x}` are simply skipped.
 */
export function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = scanBalancedObject(text, i);
    if (end === -1) continue; // unbalanced from here; try the next '{'
    objects.push(text.slice(i, end + 1));
    i = end; // skip the captured object's interior
  }
  return objects;
}

/**
 * Return the index of the `}` that closes the object opening at `start`, or -1
 * if it never balances. String-aware: braces and quotes inside JSON strings
 * (honouring `\` escapes) do not affect the depth count.
 */
function scanBalancedObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}
