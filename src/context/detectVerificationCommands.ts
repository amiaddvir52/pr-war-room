import { join } from "node:path";
import { anyExists, exists, readTextIfExists } from "./fsProbe.js";
import type { PackageManager, ProjectType } from "./detectProjectType.js";

/**
 * Suggest a dependency-install step and the verification commands (typecheck /
 * lint / test / build) for a checked-out repo, based on its detected project
 * types and package manager (Phase 3). Heuristic and best-effort — the caller
 * decides whether to actually run them, and config commands take precedence.
 */

export interface DetectedCommands {
  /** Dependency-install command to run before verification, or null if none applies. */
  install: string | null;
  /** Verification commands, in the order they should run. */
  commands: string[];
}

export interface DetectVerificationInput {
  repoDir: string;
  projectTypes: ProjectType[];
  packageManager: PackageManager | null;
}

// Priority order for the single `install` slot when a repo has several stacks.
const INSTALL_PRIORITY: ProjectType[] = ["node", "python", "go"];

export async function detectVerificationCommands(
  input: DetectVerificationInput,
): Promise<DetectedCommands> {
  const perType = new Map<ProjectType, DetectedCommands>();

  if (input.projectTypes.includes("node")) {
    perType.set("node", await detectNode(input.repoDir, input.packageManager ?? "npm"));
  }
  if (input.projectTypes.includes("python")) {
    perType.set("python", await detectPython(input.repoDir));
  }
  if (input.projectTypes.includes("go")) {
    perType.set("go", {
      install: "go mod download",
      commands: ["go build ./...", "go vet ./...", "go test ./..."],
    });
  }

  const commands = INSTALL_PRIORITY.flatMap((t) => perType.get(t)?.commands ?? []);
  const install =
    INSTALL_PRIORITY.map((t) => perType.get(t)?.install).find((cmd) => cmd != null) ?? null;

  return { install, commands };
}

/* -------------------------------- Node --------------------------------- */

async function detectNode(repoDir: string, pm: PackageManager): Promise<DetectedCommands> {
  const scripts = await readScripts(repoDir);
  const commands: string[] = [];
  // Ordered so the cheapest, most deterministic checks come first.
  for (const name of ["typecheck", "lint", "test"]) {
    if (scripts[name]) commands.push(`${pm} run ${name}`);
  }
  return { install: await nodeInstall(repoDir, pm), commands };
}

async function nodeInstall(repoDir: string, pm: PackageManager): Promise<string> {
  switch (pm) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install";
    case "npm":
      // `npm ci` requires a lockfile; fall back to `npm install` without one.
      return (await exists(join(repoDir, "package-lock.json"))) ? "npm ci" : "npm install";
  }
}

async function readScripts(repoDir: string): Promise<Record<string, string>> {
  const raw = await readTextIfExists(join(repoDir, "package.json"));
  if (raw === null) return {};
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(pkg.scripts ?? {})) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/* ------------------------------- Python -------------------------------- */

async function detectPython(repoDir: string): Promise<DetectedCommands> {
  const pyproject = await readTextIfExists(join(repoDir, "pyproject.toml"));
  const commands: string[] = [];
  if (await hasRuff(repoDir, pyproject)) commands.push("ruff check .");
  if (await hasMypy(repoDir, pyproject)) commands.push("mypy .");
  if (await hasPytest(repoDir, pyproject)) commands.push("pytest");
  return { install: await pythonInstall(repoDir, pyproject !== null), commands };
}

async function pythonInstall(repoDir: string, hasPyproject: boolean): Promise<string | null> {
  if (await exists(join(repoDir, "requirements.txt"))) return "pip install -r requirements.txt";
  if (hasPyproject || (await exists(join(repoDir, "setup.py")))) return "pip install -e .";
  return null;
}

async function hasRuff(repoDir: string, pyproject: string | null): Promise<boolean> {
  if (await anyExists(repoDir, ["ruff.toml", ".ruff.toml"])) return true;
  return pyproject !== null && pyproject.includes("[tool.ruff");
}

async function hasMypy(repoDir: string, pyproject: string | null): Promise<boolean> {
  if (await exists(join(repoDir, "mypy.ini"))) return true;
  return pyproject !== null && pyproject.includes("[tool.mypy]");
}

async function hasPytest(repoDir: string, pyproject: string | null): Promise<boolean> {
  if (await anyExists(repoDir, ["pytest.ini", "tox.ini", "conftest.py"])) return true;
  if (pyproject !== null && pyproject.includes("[tool.pytest")) return true;
  return exists(join(repoDir, "tests"));
}
