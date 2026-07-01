import { createRequire } from "node:module";
import { Command } from "commander";
import { runReview } from "./commands/review.js";
import { runFix } from "./commands/fix.js";
import { runEval } from "./commands/eval.js";
import { CliError } from "../errors.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name("pr-war-room")
    .description("Multi-agent AI pre-review orchestrator for GitHub PRs")
    .version(version);

  program
    .command("review")
    .argument("<pr-url>", "GitHub pull request URL")
    .description("Run the AI pre-review flow on a pull request")
    .action(async (prUrl: string) => {
      await runReview(prUrl, { version });
    });

  program
    .command("fix")
    .argument("<pr-url>", "GitHub pull request URL")
    .description("Generate local fix patches for findings (not yet implemented)")
    .action(async (prUrl: string) => {
      await runFix(prUrl);
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
      await runEval({ repo: options.repo, prs: options.prs });
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram(pkg.version);
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`Error: ${error.message}`);
      process.exit(error.exitCode);
    }
    console.error(`Unexpected error: ${(error as Error).message}`);
    process.exit(1);
  }
}

void main();
