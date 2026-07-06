import type { JudgeFailureKind, SkepticFailureKind } from "./findings/schema.js";
import type { FixFailureKind } from "./fix/schema.js";

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

/**
 * A soft judge failure (refusal / truncation / backend error / unparseable
 * verdict), mirroring `SkepticError`. A subclass of `ReviewerError` so existing
 * `instanceof ReviewerError` handling still applies, with a structured `kind` so
 * `runJudge` can classify the finding deterministically (recall-first) without
 * matching on message text. `timeout` failures flow through `ReviewerTimeoutError`.
 */
export class JudgeError extends ReviewerError {
  readonly kind: JudgeFailureKind;

  constructor(message: string, kind: JudgeFailureKind) {
    super(message);
    this.name = "JudgeError";
    this.kind = kind;
  }
}

/**
 * Fix-mode structural failure (Phase 11): missing/invalid review artifacts, or
 * the findings on disk belong to a different PR. Per-finding fix problems are
 * NOT this — they flow through `FixAgentError` and are recorded in the report.
 * Exit code 7.
 */
export class FixError extends CliError {
  constructor(message: string) {
    super(message, 7);
    this.name = "FixError";
  }
}

/**
 * A soft per-finding fix-agent failure (refusal / truncation / backend error /
 * unparseable proposal), mirroring `SkepticError`/`JudgeError`. A subclass of
 * `ReviewerError` so existing `instanceof ReviewerError` handling applies, with
 * a structured `kind` so `runFixes` can record the outcome without matching on
 * message text. `timeout` failures keep flowing through `ReviewerTimeoutError`.
 */
export class FixAgentError extends ReviewerError {
  readonly kind: FixFailureKind;

  constructor(message: string, kind: FixFailureKind) {
    super(message);
    this.name = "FixAgentError";
    this.kind = kind;
  }
}
