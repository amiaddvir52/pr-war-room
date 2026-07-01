import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRepoConventions } from "../../src/context/collectRepoConventions.js";

describe("collectRepoConventions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-conv-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts README summary, test/api/error conventions from a Node repo", async () => {
    await writeFile(join(dir, "README.md"), "# My Lib\n\nDoes a thing.", "utf8");
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        dependencies: { express: "^4" },
        devDependencies: { vitest: "^2" },
        scripts: { test: "vitest run" },
      }),
      "utf8",
    );
    await mkdir(join(dir, "tests"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "errors.ts"), "export class E extends Error {}", "utf8");

    const conv = await collectRepoConventions(dir);
    expect(conv.readmeSummary).toContain("My Lib");
    expect(conv.testConventions).toContain("vitest");
    expect(conv.testConventions).toContain("tests/");
    expect(conv.apiPatterns).toContain("Express");
    expect(conv.errorHandlingPatterns).toContain("src/errors.ts");
  });

  it("returns all-null for a bare directory", async () => {
    const conv = await collectRepoConventions(dir);
    expect(conv).toEqual({
      readmeSummary: null,
      testConventions: null,
      errorHandlingPatterns: null,
      apiPatterns: null,
    });
  });
});
