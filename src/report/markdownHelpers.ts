import { dirname, relative } from "node:path";

/**
 * Shared markdown-rendering helpers for the report renderers (Phase 10 review
 * report, Phase 11 fix report) and the prompts that embed untrusted content.
 * Extracted from `generateMarkdownReport.ts` verbatim so the two reports (and
 * the fix prompt's fenced file content) cannot drift in how they escape
 * untrusted text.
 */

/** A markdown link from `from` to a sibling artifact, path relative to `from`'s dir. */
export function link(from: string, target: string): string {
  const rel = relative(dirname(from), target);
  return `[${rel}](${rel})`;
}

export function fence(body: string, lang = ""): string {
  // The delimiter must be longer than any backtick run inside `body`, or
  // untrusted content (LLM suggestions, subprocess output) that contains its
  // own ``` fence would close this one early and corrupt the rest of the
  // report. Grow it to one more than the longest internal run (min 3) instead
  // of mutating the content, so what we render matches the model verbatim.
  const longestRun = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

/**
 * Prepare untrusted text for an INLINE markdown context (a `###` heading, a
 * list item, a link label): collapse every kind of line break — including a
 * standalone `\r` — to a space, then backslash-escape the metacharacters that
 * would otherwise inject structure (code spans, links/images, emphasis, raw
 * HTML, table cells). NEVER use this on fenced code/output blocks — escaping
 * would corrupt the very content those blocks exist to show verbatim.
 */
export function sanitizeInline(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>~|]/g, "\\$&")
    .trim();
}

export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
