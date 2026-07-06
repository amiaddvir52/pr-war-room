import { createRequire } from "node:module";
import { Command } from "commander";
import { runReview } from "./commands/review.js";
import { runFix } from "./commands/fix.js";
import { runEval } from "./commands/eval.js";
import { Reporter, type ReporterOptions } from "../ui/reporter.js";
import { CliError } from "../errors.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

function reporterOptionsFrom(opts: { quiet?: boolean; color?: boolean }): ReporterOptions {
  const options: ReporterOptions = { quiet: opts.quiet === true };
  // commander sets `color` to false only when --no-color is passed; otherwise
  // leave it unset so the Reporter auto-detects (TTY + NO_COLOR).
  if (opts.color === false) options.color = false;
  return options;
}

export function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name("pr-war-room")
    .description("Multi-agent AI pre-review orchestrator for GitHub PRs")
    .version(version)
    .option("-q, --quiet", "suppress non-error output")
    .option("--no-color", "disable colored output");

  const reporterFor = (): Reporter => new Reporter(reporterOptionsFrom(program.opts()));

  program
    .command("review")
    .argument("<pr-url>", "GitHub pull request URL")
    .description("Run the AI pre-review flow on a pull request")
    .option(
      "--verify",
      "run verification commands (install deps, then test/lint/build) on the checked-out PR",
    )
    .action(async (prUrl: string, options: { verify?: boolean }) => {
      await runReview(prUrl, {
        version,
        reporter: reporterFor(),
        ...(options.verify ? { verify: true } : {}),
      });
    });

  program
    .command("fix")
    .argument("<pr-url>", "GitHub pull request URL")
    .description(
      "Generate a local fix patch (.ai-review/runs/<run_id>/patch.diff) for the latest review's findings",
    )
    .option(
      "--apply",
      "leave the fixes applied in the workspace checkout (.ai-review/workspace/repo); never touches your own tree",
    )
    .option(
      "--verify",
      "run verification commands (install deps, then test/lint/build) against the patched workspace",
    )
    .action(async (prUrl: string, options: { apply?: boolean; verify?: boolean }) => {
      await runFix(prUrl, {
        version,
        reporter: reporterFor(),
        ...(options.apply ? { apply: true } : {}),
        ...(options.verify ? { verify: true } : {}),
      });
    });

  program
    .command("eval")
    .description(
      "Evaluate AI findings against historical human review comments (not yet implemented)",
    )
    .requiredOption("--repo <path>", "Path to the repository")
    .requiredOption("--prs <number>", "Number of historical PRs to evaluate", (value) =>
      Number.parseInt(value, 10),
    )
    .action(async (options: { repo: string; prs: number }) => {
      await runEval({ repo: options.repo, prs: options.prs, reporter: reporterFor() });
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram(pkg.version);
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const reporter = new Reporter(reporterOptionsFrom(program.opts()));
    if (error instanceof CliError) {
      reporter.error(error.message);
      process.exit(error.exitCode);
    }
    reporter.error(`Unexpected error: ${(error as Error).message}`);
    process.exit(1);
  }
}

void main();
