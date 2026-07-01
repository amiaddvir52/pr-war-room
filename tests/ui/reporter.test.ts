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
});
