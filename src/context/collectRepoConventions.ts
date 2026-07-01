import { join } from "node:path";
import { anyExists, exists, readTextIfExists } from "./fsProbe.js";
import type { RepoConventions } from "./schema.js";

/**
 * Heuristic, best-effort extraction of repo conventions for the review packet
 * (Phase 4). Cheap signals from the README, package manifest, and directory
 * layout — enough to orient a reviewer. Later phases read the actual code; this
 * is not meant to be exhaustive. Every field degrades to null when unknown.
 */

const README_SUMMARY_LIMIT = 1200;

const TEST_DEP_NAMES = ["vitest", "jest", "mocha", "ava", "jasmine", "tap"] as const;
const API_FRAMEWORKS: Array<[string, string]> = [
  ["next", "Next.js app/pages routing"],
  ["@nestjs/core", "NestJS controllers/modules"],
  ["express", "Express-style HTTP route handlers"],
  ["fastify", "Fastify route handlers"],
  ["koa", "Koa middleware handlers"],
  ["@hapi/hapi", "hapi route handlers"],
];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

async function readPackageJson(repoDir: string): Promise<PackageJson | null> {
  const raw = await readTextIfExists(join(repoDir, "package.json"));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

async function readmeSummary(repoDir: string): Promise<string | null> {
  for (const name of ["README.md", "README.rst", "README.txt", "README"]) {
    const raw = await readTextIfExists(join(repoDir, name));
    if (raw !== null) {
      const trimmed = raw.trim();
      return trimmed.length > README_SUMMARY_LIMIT
        ? `${trimmed.slice(0, README_SUMMARY_LIMIT)}\n…[truncated]`
        : trimmed;
    }
  }
  return null;
}

async function testConventions(repoDir: string, pkg: PackageJson | null): Promise<string | null> {
  const parts: string[] = [];
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const framework = TEST_DEP_NAMES.find((name) => name in deps);
  if (framework) parts.push(`Uses ${framework}`);
  if (pkg?.scripts?.["test"]) parts.push(`test script: \`${pkg.scripts["test"]}\``);

  for (const dir of ["tests", "test", "__tests__", "spec"]) {
    if (await exists(join(repoDir, dir))) {
      parts.push(`tests under \`${dir}/\``);
      break;
    }
  }
  // Python
  if (await anyExists(repoDir, ["pytest.ini", "tox.ini", "conftest.py"])) parts.push("pytest config present");
  return parts.length > 0 ? parts.join("; ") : null;
}

function apiPatterns(pkg: PackageJson | null): string | null {
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hits = API_FRAMEWORKS.filter(([dep]) => dep in deps).map(([, label]) => label);
  return hits.length > 0 ? hits.join("; ") : null;
}

async function errorHandlingPatterns(repoDir: string): Promise<string | null> {
  // Cheap signal: a dedicated errors module is a strong convention hint.
  for (const rel of ["src/errors.ts", "src/errors.js", "src/error.ts", "errors.py", "src/exceptions.py"]) {
    if (await exists(join(repoDir, rel))) return `Dedicated error module at \`${rel}\``;
  }
  return null;
}

export async function collectRepoConventions(repoDir: string): Promise<RepoConventions> {
  const pkg = await readPackageJson(repoDir);
  return {
    readmeSummary: await readmeSummary(repoDir),
    testConventions: await testConventions(repoDir, pkg),
    errorHandlingPatterns: await errorHandlingPatterns(repoDir),
    apiPatterns: apiPatterns(pkg),
  };
}
