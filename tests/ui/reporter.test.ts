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
  });

  describe("board (non-TTY path)", () => {
    it("prints each row once when it resolves, in completion order, skipping queued/running", () => {
      const { reporter, out } = capture();
      const board = reporter.board([
        { key: "a", label: "agent_a (general)" },
        { key: "b", label: "agent_b (test-gap)" },
      ]);
      board.set("a", "running"); // running/queued produce no output off-TTY
      board.set("b", "running");
      board.set("b", "fail", "timed out"); // b finishes first
      board.set("a", "ok", "3 findings");
      board.stop();
      const text = out.join("\n");
      expect(text).not.toContain("running");
      expect(text).toContain("agent_b (test-gap) — timed out");
      expect(text).toContain("agent_a (general) — 3 findings");
      expect(text.indexOf("agent_b")).toBeLessThan(text.indexOf("agent_a")); // completion order
      expect(text).toContain("✓");
      expect(text).toContain("✗");
    });

    it("resolves each row at most once", () => {
      const { reporter, out } = capture();
      const board = reporter.board([{ key: "a", label: "agent_a" }]);
      board.set("a", "ok", "1 finding");
      board.set("a", "fail", "should be ignored");
      board.stop();
      const text = out.join("\n");
      expect(text).toContain("agent_a — 1 finding");
      expect(text).not.toContain("should be ignored");
    });
  });
});
