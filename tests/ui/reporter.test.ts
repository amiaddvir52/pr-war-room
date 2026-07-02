import { describe, it, expect } from "vitest";
import { Reporter } from "../../src/ui/reporter.js";

const ANSI = /\[/;

function capture(quiet = false): {
  reporter: Reporter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const reporter = new Reporter({
    color: false,
    quiet,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { reporter, out, err };
}

describe("Reporter", () => {
  it("renders key-values and steps as plain text when color is off", () => {
    const { reporter, out } = capture();
    reporter.keyValues([["PR", "org/repo#1"]]);
    reporter.step("parsed PR URL");
    const text = out.join("\n");
    expect(text).toContain("PR");
    expect(text).toContain("org/repo#1");
    expect(text).toContain("✓");
    expect(text).not.toMatch(ANSI);
  });

  it("suppresses normal output in quiet mode but still emits errors", () => {
    const { reporter, out, err } = capture(true);
    reporter.info("hello");
    reporter.step("did a thing");
    reporter.error("boom");
    expect(out).toHaveLength(0);
    expect(err.join("\n")).toContain("boom");
  });

  it("emits ANSI escape codes when color is enabled", () => {
    const out: string[] = [];
    const reporter = new Reporter({ color: true, out: (line) => out.push(line), err: () => {} });
    reporter.success("done");
    expect(out.join("")).toMatch(ANSI);
  });

  describe("spinner (non-TTY path)", () => {
    it("prints a start line then a succeeded step", () => {
      const { reporter, out } = capture();
      reporter.spinner("reviewing with claude…").succeed("reviewed code — 6 findings");
      const text = out.join("\n");
      expect(text).toContain("reviewing with claude");
      expect(text).toContain("reviewed code — 6 findings");
      expect(text).toContain("✓");
      expect(text).not.toMatch(ANSI);
    });

    it("renders a failed step with the ✗ mark", () => {
      const { reporter, out } = capture();
      reporter.spinner("reviewing…").fail("reviewer failed");
      const text = out.join("\n");
      expect(text).toContain("reviewer failed");
      expect(text).toContain("✗");
    });

    it("stop() resolves without printing a final step line", () => {
      const { reporter, out } = capture();
      reporter.spinner("working…").stop();
      expect(out.join("\n")).toContain("working");
      expect(out.join("\n")).not.toContain("✓");
    });

    it("is silent in quiet mode", () => {
      const { reporter, out } = capture(true);
      reporter.spinner("working…").succeed("done");
      expect(out).toHaveLength(0);
    });

    it("streams logAbove lines in order and treats update as a no-op off-TTY", () => {
      const { reporter, out } = capture();
      const spin = reporter.spinner("reviewing (0/2 done)…");
      spin.update("reviewing (1/2 done)…"); // no-op when not animating
      spin.logAbove(() => reporter.step("agent_a (general) — 3 findings", true));
      spin.logAbove(() => reporter.step("agent_b (test-gap) — failed", false));
      spin.stop();
      const text = out.join("\n");
      expect(text).toContain("reviewing (0/2 done)"); // start line
      expect(text).not.toContain("1/2"); // update is suppressed off-TTY
      const a = text.indexOf("agent_a");
      const b = text.indexOf("agent_b");
      expect(a).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(a); // streamed in completion order
      expect(text).toContain("✗"); // the failed agent's mark
    });
  });
});
