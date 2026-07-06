import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyFixEdits } from "../../src/fix/applyFixEdits.js";

let repoDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "pwr-apply-"));
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

async function seed(path: string, content: string): Promise<void> {
  const full = join(repoDir, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function read(path: string): Promise<string> {
  return readFile(join(repoDir, path), "utf8");
}

const allowed = new Set(["src/a.ts", "src/b.ts"]);

describe("applyFixEdits", () => {
  it("applies a single edit", async () => {
    await seed("src/a.ts", "const x = 1;\nconst y = 2;\n");
    const result = await applyFixEdits(
      [{ path: "src/a.ts", search: "const x = 1;", replace: "const x = 42;" }],
      repoDir,
      allowed,
    );
    expect(result).toEqual({
      ok: true,
      editsApplied: 1,
      filesTouched: ["src/a.ts"],
      appliedEdits: [{ path: "src/a.ts", line: 1, lineDelta: 0 }],
    });
    expect(await read("src/a.ts")).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("composes multiple edits to the same file in order", async () => {
    await seed("src/a.ts", "alpha\nbeta\n");
    const result = await applyFixEdits(
      [
        { path: "src/a.ts", search: "alpha", replace: "ALPHA" },
        // The second edit's search matches text the FIRST edit introduced.
        { path: "src/a.ts", search: "ALPHA\nbeta", replace: "ALPHA\nBETA" },
      ],
      repoDir,
      allowed,
    );
    expect(result.ok).toBe(true);
    expect(await read("src/a.ts")).toBe("ALPHA\nBETA\n");
  });

  it("edits multiple files in one proposal", async () => {
    await seed("src/a.ts", "aaa");
    await seed("src/b.ts", "bbb");
    const result = await applyFixEdits(
      [
        { path: "src/a.ts", search: "aaa", replace: "AAA" },
        { path: "src/b.ts", search: "bbb", replace: "BBB" },
      ],
      repoDir,
      allowed,
    );
    expect(result.ok).toBe(true);
    expect(await read("src/a.ts")).toBe("AAA");
    expect(await read("src/b.ts")).toBe("BBB");
  });

  it("deletes text when replace is empty", async () => {
    await seed("src/a.ts", "keep\nremove me\nkeep too\n");
    const result = await applyFixEdits(
      [{ path: "src/a.ts", search: "remove me\n", replace: "" }],
      repoDir,
      allowed,
    );
    expect(result.ok).toBe(true);
    expect(await read("src/a.ts")).toBe("keep\nkeep too\n");
  });

  it("fails with search_not_found when the search string is absent", async () => {
    await seed("src/a.ts", "actual content");
    const result = await applyFixEdits(
      [{ path: "src/a.ts", search: "imagined content", replace: "x" }],
      repoDir,
      allowed,
    );
    expect(result).toMatchObject({ ok: false, kind: "search_not_found" });
  });

  it("fails with ambiguous_search when the search string repeats", async () => {
    await seed("src/a.ts", "dup\ndup\n");
    const result = await applyFixEdits(
      [{ path: "src/a.ts", search: "dup", replace: "x" }],
      repoDir,
      allowed,
    );
    expect(result).toMatchObject({ ok: false, kind: "ambiguous_search" });
  });

  it("rejects paths outside the PR changeset", async () => {
    await seed("src/other.ts", "content");
    const result = await applyFixEdits(
      [{ path: "src/other.ts", search: "content", replace: "x" }],
      repoDir,
      allowed,
    );
    expect(result).toMatchObject({ ok: false, kind: "path_not_in_changeset" });
  });

  it("rejects absolute and traversal paths before any IO", async () => {
    const abs = await applyFixEdits(
      [{ path: join(repoDir, "src/a.ts"), search: "x", replace: "y" }],
      repoDir,
      allowed,
    );
    expect(abs).toMatchObject({ ok: false, kind: "path_escapes_repo" });

    const traversal = await applyFixEdits(
      [{ path: "../outside.ts", search: "x", replace: "y" }],
      repoDir,
      new Set(["../outside.ts"]), // even allowlisted, traversal is rejected
    );
    expect(traversal).toMatchObject({ ok: false, kind: "path_escapes_repo" });
  });

  it("fails with file_unreadable when the file is missing from the checkout", async () => {
    const result = await applyFixEdits(
      [{ path: "src/a.ts", search: "x", replace: "y" }],
      repoDir,
      allowed,
    );
    expect(result).toMatchObject({ ok: false, kind: "file_unreadable" });
  });

  it("inserts replacement text literally, even $-substitution patterns", async () => {
    // String.replace with a string replacement would expand $&, $', $$ — an
    // LLM-proposed fix legitimately contains these (regex code, shell $'…').
    await seed("src/a.ts", "const re = X;\n");
    const replace = "const re = s.replace(/x/g, \"$&$'$$\");";
    const result = await applyFixEdits(
      [{ path: "src/a.ts", search: "const re = X;", replace }],
      repoDir,
      allowed,
    );
    expect(result.ok).toBe(true);
    expect(await read("src/a.ts")).toBe(`${replace}\n`);
  });

  it("reports where each edit landed for the caller's line-shift ledger", async () => {
    await seed("src/a.ts", "l1\nl2\nl3\n");
    const result = await applyFixEdits(
      [{ path: "src/a.ts", search: "l2", replace: "inserted\nl2" }],
      repoDir,
      allowed,
    );
    expect(result).toMatchObject({
      ok: true,
      appliedEdits: [{ path: "src/a.ts", line: 2, lineDelta: 1 }],
    });
  });

  it("fails with file_not_utf8 instead of corrupting a non-UTF-8 file", async () => {
    // 0xE9 is Latin-1 'é' — invalid UTF-8. A lossy decode + whole-file rewrite
    // would turn it into U+FFFD far from the edit site.
    const full = join(repoDir, "src/a.ts");
    await mkdir(dirname(full), { recursive: true });
    const bytes = Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a, 0x6f, 0x6b, 0x0a]); // "// é\nok\n" in Latin-1
    await writeFile(full, bytes);
    const result = await applyFixEdits(
      [{ path: "src/a.ts", search: "ok", replace: "OK" }],
      repoDir,
      allowed,
    );
    expect(result).toMatchObject({ ok: false, kind: "file_not_utf8" });
    expect(Buffer.compare(await readFile(full), bytes)).toBe(0); // untouched
  });

  it("rolls back already-written files when a later write fails", async () => {
    await seed("src/a.ts", "original a");
    await seed("src/b.ts", "original b");
    await chmod(join(repoDir, "src/b.ts"), 0o444); // stages fine, write fails
    const result = await applyFixEdits(
      [
        { path: "src/a.ts", search: "original a", replace: "CHANGED A" },
        { path: "src/b.ts", search: "original b", replace: "CHANGED B" },
      ],
      repoDir,
      allowed,
    );
    await chmod(join(repoDir, "src/b.ts"), 0o644); // let afterEach clean up
    expect(result).toMatchObject({ ok: false, kind: "write_failed" });
    expect(await read("src/a.ts")).toBe("original a"); // rolled back
    expect(await read("src/b.ts")).toBe("original b");
  });

  it("is all-or-nothing: a failing later edit leaves earlier files untouched", async () => {
    await seed("src/a.ts", "original a");
    await seed("src/b.ts", "original b");
    const result = await applyFixEdits(
      [
        { path: "src/a.ts", search: "original a", replace: "CHANGED" },
        { path: "src/b.ts", search: "not there", replace: "x" },
      ],
      repoDir,
      allowed,
    );
    expect(result).toMatchObject({ ok: false, kind: "search_not_found" });
    expect(await read("src/a.ts")).toBe("original a"); // nothing written
    expect(await read("src/b.ts")).toBe("original b");
  });
});
