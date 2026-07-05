import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExists, defaultDetectBackend } from "../../src/agents/backendAvailability.js";

describe("commandExists", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-cmd-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds an executable on PATH", async () => {
    const bin = "prwr_fake_tool";
    // Windows resolves via PATHEXT; POSIX ignores it and matches the bare name.
    const file = join(dir, process.platform === "win32" ? `${bin}.cmd` : bin);
    await writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") await chmod(file, 0o755);

    const env = { PATH: dir, PATHEXT: ".CMD" } as NodeJS.ProcessEnv;
    expect(await commandExists(bin, env)).toBe(true);
  });

  it("returns false when the executable is absent", async () => {
    const env = { PATH: dir } as NodeJS.ProcessEnv;
    expect(await commandExists("prwr_definitely_not_installed_xyz", env)).toBe(false);
  });

  it("returns false when PATH is empty", async () => {
    expect(await commandExists("node", { PATH: "" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("defaultDetectBackend", () => {
  it("reports claude, claude-api and mock as available without probing", async () => {
    expect(await defaultDetectBackend("claude")).toEqual({ available: true });
    expect(await defaultDetectBackend("claude-api")).toEqual({ available: true });
    expect(await defaultDetectBackend("mock")).toEqual({ available: true });
  });

  it("gates the codex backend on CLI presence, with a reason when unavailable", async () => {
    // Availability depends on the host, but the contract holds either way: an
    // `available` boolean, and a codex-specific reason string when unavailable.
    const result = await defaultDetectBackend("codex");
    expect(typeof result.available).toBe("boolean");
    if (!result.available) {
      expect(result.reason).toMatch(/codex CLI not found/i);
    }
  });
});
