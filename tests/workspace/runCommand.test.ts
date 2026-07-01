import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { runCommand } from "../../src/workspace/runCommand.js";

const CWD = process.cwd();

// Uses the real `node` binary (always present) so the runner is exercised
// end-to-end without depending on any project-specific tooling.
describe("runCommand", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await runCommand("node --version", { cwd: CWD });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^v\d+/);
    expect(r.spawnError).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(typeof r.durationMs).toBe("number");
  });

  it("does not throw on a non-zero exit code", async () => {
    const r = await runCommand('node -e "process.exit(3)"', { cwd: CWD });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
  });

  it("captures stderr", async () => {
    const r = await runCommand('node -e "process.stderr.write(\'boom\')"', { cwd: CWD });
    expect(r.stderr).toContain("boom");
  });

  it("marks a command that exceeds the timeout", async () => {
    const r = await runCommand('node -e "setTimeout(() => {}, 10000)"', {
      cwd: CWD,
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(5000);
  });

  it("records a spawn error instead of throwing", async () => {
    const r = await runCommand("node --version", {
      cwd: join(CWD, "definitely", "does", "not", "exist"),
    });
    expect(r.spawnError).not.toBeNull();
  });

  it("reports byte counts and no truncation for small output", async () => {
    const r = await runCommand('node -e "process.stdout.write(\'hello\')"', { cwd: CWD });
    expect(r.stdoutBytes).toBe(5);
    expect(r.stdoutTruncated).toBe(false);
  });

  it("caps retained output but still reports the true byte count when truncated", async () => {
    const r = await runCommand('node -e "process.stdout.write(\'x\'.repeat(2*1024*1024))"', {
      cwd: CWD,
    });
    expect(r.stdoutBytes).toBe(2 * 1024 * 1024);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1024 * 1024);
  });
});
