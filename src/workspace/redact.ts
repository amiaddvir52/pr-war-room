/**
 * Redact secrets from command output before it is written to artifacts. We
 * redact (a) any known secret we hold (e.g. the resolved GitHub token) and
 * (b) a focused set of obvious credential shapes. This is best-effort defense
 * in depth — not a guarantee — so verification logs are safer to share.
 */

const PLACEHOLDER = "***REDACTED***";

interface SecretPattern {
  re: RegExp;
  replace: (match: string) => string;
}

// Ordered, focused patterns for "obvious" secrets. Global flags so every match
// on a line is replaced.
const PATTERNS: SecretPattern[] = [
  // GitHub tokens: PAT (ghp_), OAuth (gho_), user (ghu_), server (ghs_), refresh (ghr_).
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: () => PLACEHOLDER },
  // GitHub fine-grained PAT.
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: () => PLACEHOLDER },
  // Token embedded in a clone/fetch URL (x-access-token:<token>@ or user:pass@).
  { re: /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, replace: (m) => `${m.slice(0, m.indexOf("//") + 2)}${PLACEHOLDER}@` },
  // AWS access key id.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => PLACEHOLDER },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => PLACEHOLDER },
  // PEM private key blocks.
  {
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    replace: () => PLACEHOLDER,
  },
];

/**
 * Redact `extraSecrets` (literal strings we know, e.g. a token) and known
 * secret patterns from `text`. Empty/short extras are ignored to avoid redacting
 * incidental substrings.
 */
export function redactSecrets(
  text: string,
  extraSecrets: ReadonlyArray<string | null | undefined> = [],
): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(PLACEHOLDER);
  }
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}
