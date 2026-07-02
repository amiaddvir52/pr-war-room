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
