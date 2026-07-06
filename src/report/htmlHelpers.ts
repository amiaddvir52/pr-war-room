/**
 * HTML-rendering helpers for the Phase-10 HTML report. Everything that reaches
 * the report — finding titles, claims, evidence, file names, PR titles, branch
 * names, model/subprocess output — is UNTRUSTED (it flows in from LLMs, the
 * GitHub API, and arbitrary repo content), so the renderer builds the document
 * exclusively out of `esc()`-escaped strings. There is no path that
 * interpolates untrusted text into markup, attributes, or script unescaped.
 */

/**
 * Escape a string for safe interpolation into HTML text content AND
 * double-quoted attribute values. Escapes the full metacharacter set
 * (& < > " ') so it is safe in both positions; escaping `&` first keeps the
 * result idempotent-looking rather than double-escaping entities.
 */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * An href value that is safe to link: only plain http(s) URLs qualify —
 * anything else (javascript:, data:, vbscript:, protocol-relative tricks)
 * returns null and the caller renders text instead of a link. The value is
 * still `esc()`d for the attribute position.
 */
export function safeHttpHref(url: string): string | null {
  return /^https?:\/\//i.test(url.trim()) ? esc(url.trim()) : null;
}

/**
 * A filesystem-relative href (for artifact links next to the report). Escaped
 * for the attribute position; callers pass paths they computed themselves via
 * `node:path` (never raw model output).
 */
export function fileHref(relativePath: string): string {
  return esc(relativePath.split("\\").join("/"));
}
