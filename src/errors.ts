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
