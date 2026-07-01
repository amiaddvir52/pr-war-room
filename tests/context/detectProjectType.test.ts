import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectProjectTypes,
  detectPackageManager,
} from "../../src/context/detectProjectType.js";

describe("detectProjectTypes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-detect-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects a Node project", async () => {
    await writeFile(join(dir, "package.json"), "{}", "utf8");
    expect(await detectProjectTypes(dir)).toEqual(["node"]);
  });

  it("detects a Go project", async () => {
    await writeFile(join(dir, "go.mod"), "module x\n", "utf8");
    expect(await detectProjectTypes(dir)).toEqual(["go"]);
  });

  it("detects a Python project from any marker", async () => {
    await writeFile(join(dir, "requirements.txt"), "flask\n", "utf8");
    expect(await detectProjectTypes(dir)).toEqual(["python"]);
  });

  it("detects multiple types in a polyglot repo (ordered node, python, go)", async () => {
    await writeFile(join(dir, "package.json"), "{}", "utf8");
    await writeFile(join(dir, "go.mod"), "module x\n", "utf8");
    expect(await detectProjectTypes(dir)).toEqual(["node", "go"]);
  });

  it("returns an empty array for an unrecognized repo", async () => {
    expect(await detectProjectTypes(dir)).toEqual([]);
  });
});

describe("detectPackageManager", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-pm-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("prefers the corepack packageManager field over lockfiles", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ packageManager: "pnpm@9.1.0" }),
      "utf8",
    );
    await writeFile(join(dir, "yarn.lock"), "", "utf8");
    expect(await detectPackageManager(dir)).toBe("pnpm");
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ] as const)("infers %s -> %s", async (lockfile, expected) => {
    await writeFile(join(dir, "package.json"), "{}", "utf8");
    await writeFile(join(dir, lockfile), "", "utf8");
    expect(await detectPackageManager(dir)).toBe(expected);
  });

  it("returns null when nothing indicates a manager", async () => {
    await writeFile(join(dir, "package.json"), "{}", "utf8");
    expect(await detectPackageManager(dir)).toBeNull();
  });
});
