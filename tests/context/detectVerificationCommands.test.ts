import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVerificationCommands } from "../../src/context/detectVerificationCommands.js";

describe("detectVerificationCommands", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-cmds-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("suggests pm-scoped scripts (typecheck, lint, test) and a frozen install", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: { build: "tsup", test: "vitest", lint: "eslint .", typecheck: "tsc --noEmit" },
      }),
      "utf8",
    );
    const result = await detectVerificationCommands({
      repoDir: dir,
      projectTypes: ["node"],
      packageManager: "pnpm",
    });
    expect(result.commands).toEqual(["pnpm run typecheck", "pnpm run lint", "pnpm run test"]);
    expect(result.install).toBe("pnpm install --frozen-lockfile");
  });

  it("falls back to `npm install` without a lockfile and `npm ci` with one", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "jest" } }),
      "utf8",
    );
    expect(
      (await detectVerificationCommands({ repoDir: dir, projectTypes: ["node"], packageManager: "npm" }))
        .install,
    ).toBe("npm install");

    await writeFile(join(dir, "package-lock.json"), "{}", "utf8");
    expect(
      (await detectVerificationCommands({ repoDir: dir, projectTypes: ["node"], packageManager: "npm" }))
        .install,
    ).toBe("npm ci");
  });

  it("suggests Go build/vet/test and `go mod download`", async () => {
    const result = await detectVerificationCommands({
      repoDir: dir,
      projectTypes: ["go"],
      packageManager: null,
    });
    expect(result.install).toBe("go mod download");
    expect(result.commands).toEqual(["go build ./...", "go vet ./...", "go test ./..."]);
  });

  it("detects Python tooling from pyproject signals + requirements install", async () => {
    await writeFile(
      join(dir, "pyproject.toml"),
      "[tool.ruff]\n[tool.mypy]\n[tool.pytest.ini_options]\n",
      "utf8",
    );
    await writeFile(join(dir, "requirements.txt"), "pytest\n", "utf8");
    const result = await detectVerificationCommands({
      repoDir: dir,
      projectTypes: ["python"],
      packageManager: null,
    });
    expect(result.commands).toEqual(["ruff check .", "mypy .", "pytest"]);
    expect(result.install).toBe("pip install -r requirements.txt");
  });

  it("combines commands for a polyglot repo and picks the highest-priority install", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
      "utf8",
    );
    await writeFile(join(dir, "package-lock.json"), "{}", "utf8");
    const result = await detectVerificationCommands({
      repoDir: dir,
      projectTypes: ["node", "go"],
      packageManager: "npm",
    });
    expect(result.commands).toEqual([
      "npm run test",
      "go build ./...",
      "go vet ./...",
      "go test ./...",
    ]);
    expect(result.install).toBe("npm ci"); // node install wins over go
  });
});
