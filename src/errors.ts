import type { SkepticFailureKind } from "./findings/schema.js";

/**
 * Typed CLI errors. Each carries an `exitCode` so the top-level error boundary
 * in `cli/index.ts` can exit with a meaningful process code.
 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** Invalid PR URL / usage error. Exit code 2. */
export class PrUrlError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "PrUrlError";
  }
}

/** Configuration load/validation error. Exit code 3. */
export class ConfigError extends CliError {
  constructor(message: string) {
    super(message, 3);
    this.name = "ConfigError";
  }
}

/** GitHub ingestion failure (auth, API, or network). Exit code 4. */
export class GitHubError extends CliError {
  constructor(message: string) {
    super(message, 4);
    this.name = "GitHubError";
  }
}

/** Local workspace preparation failure (git clone/fetch/checkout). Exit code 5. */
export class WorkspaceError extends CliError {
  constructor(message: string) {
    super(message, 5);
    this.name = "WorkspaceError";
  }
}

/** Reviewer failure (missing model credentials, unknown reviewer). Exit code 6. */
export class ReviewerError extends CliError {
  constructor(message: string) {
    super(message, 6);
    this.name = "ReviewerError";
  }
}

/**
 * A reviewer that exceeded its time budget. A subclass of `ReviewerError`, so it
 * keeps exit code 6 and any existing `instanceof ReviewerError` handling, while
 * letting the orchestrator classify timeouts structurally (via `instanceof`)
 * instead of matching on the message text.
 */
export class ReviewerTimeoutError extends ReviewerError {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerTimeoutError";
  }
}

/**
 * A soft skeptic failure (refusal / truncation / backend error / unparseable
 * verdict). A subclass of `ReviewerError` so existing `instanceof ReviewerError`
 * handling still applies, but it carries a structured `kind` so `runSkeptic` can
 * annotate the kept finding (recall-first) without matching on message text.
 * `timeout` failures keep flowing through `ReviewerTimeoutError`.
 */
export class SkepticError extends ReviewerError {
  readonly kind: SkepticFailureKind;

  constructor(message: string, kind: SkepticFailureKind) {
    super(message);
    this.name = "SkepticError";
    this.kind = kind;
  }
}
