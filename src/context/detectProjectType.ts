import { join } from "node:path";
import { anyExists, exists, readTextIfExists } from "./fsProbe.js";

/**
 * Heuristic project-type and package-manager detection over a checked-out repo
 * (Phase 3). Marker-file based and deliberately simple; the result feeds
 * `detectVerificationCommands` and the Phase-4 review packet's `repository`
 * block. `projectTypes` is an array so multi-language / monorepo checkouts
 * report every stack that applies.
 */

export const PROJECT_TYPES = ["node", "python", "go"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PACKAGE_MANAGERS = ["pnpm", "yarn", "bun", "npm"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const PYTHON_MARKERS = [
  "pyproject.toml",
  "requirements.txt",
  "poetry.lock",
  "setup.py",
  "setup.cfg",
] as const;

/** Detect every project type whose marker files are present. */
export async function detectProjectTypes(repoDir: string): Promise<ProjectType[]> {
  const types: ProjectType[] = [];
  if (await exists(join(repoDir, "package.json"))) types.push("node");
  if (await anyExists(repoDir, PYTHON_MARKERS)) types.push("python");
  if (await exists(join(repoDir, "go.mod"))) types.push("go");
  return types;
}

/**
 * Detect the Node package manager: the corepack `packageManager` field wins,
 * then lockfiles (pnpm > yarn > bun > npm). Returns null for a non-Node repo or
 * a Node repo with no discernible manager.
 */
export async function detectPackageManager(repoDir: string): Promise<PackageManager | null> {
  const fromField = await packageManagerFromField(repoDir);
  if (fromField) return fromField;
  if (await exists(join(repoDir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(repoDir, "yarn.lock"))) return "yarn";
  if (await exists(join(repoDir, "bun.lockb"))) return "bun";
  if (await exists(join(repoDir, "package-lock.json"))) return "npm";
  return null;
}

async function packageManagerFromField(repoDir: string): Promise<PackageManager | null> {
  const raw = await readTextIfExists(join(repoDir, "package.json"));
  if (raw === null) return null;
  try {
    const pkg = JSON.parse(raw) as { packageManager?: unknown };
    // corepack format: "pnpm@9.1.0" — take the name before the version.
    const field = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
    const name = field.split("@")[0] ?? "";
    return (PACKAGE_MANAGERS as readonly string[]).includes(name)
      ? (name as PackageManager)
      : null;
  } catch {
    return null;
  }
}
