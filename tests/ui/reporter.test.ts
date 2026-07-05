import { describe, it, expect } from "vitest";
import { Reporter, supportsOsc8Hyperlinks, resolveLinkStyle } from "../../src/ui/reporter.js";

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

  describe("fileLink", () => {
    // OSC 8 hyperlink: ESC ] 8 ; ; <uri> BEL <text> ESC ] 8 ; ; BEL
    const OPEN = (uri: string) => `\x1b]8;;${uri}\x07`;
    const CLOSE = "\x1b]8;;\x07";
    // Force the link style so assertions don't depend on which terminal the test
    // process itself happens to run under.
    const withStyle = (linkStyle: "osc8" | "url" | "path") =>
      new Reporter({ linkStyle, out: () => {}, err: () => {} });

    it("wraps text in an OSC 8 hyperlink to a file:// URL in osc8 style", () => {
      const link = withStyle("osc8").fileLink(
        "all_findings.json",
        "/Users/me/proj/.ai-review/all_findings.json",
      );
      expect(link).toBe(
        `${OPEN("file:///Users/me/proj/.ai-review/all_findings.json")}all_findings.json${CLOSE}`,
      );
    });

    it("URL-encodes paths containing spaces in osc8 style", () => {
      const link = withStyle("osc8").fileLink("report.md", "/Users/me/My Project/report.md");
      expect(link).toContain("file:///Users/me/My%20Project/report.md");
      expect(link).toContain("\x1b]8;;"); // still a real OSC 8 sequence
    });

    it("emits a bare, Cmd-clickable file:// URL in url style (Apple Terminal / Warp)", () => {
      const link = withStyle("url").fileLink(
        ".ai-review/all_findings.json",
        "/Users/me/proj/.ai-review/all_findings.json",
      );
      expect(link).toBe("file:///Users/me/proj/.ai-review/all_findings.json");
      expect(link).not.toContain("\x1b]8"); // no OSC 8 escapes for these terminals
    });

    it("returns the plain text unchanged in path style (piped / no color)", () => {
      const text = withStyle("path").fileLink("all_findings.json", "/abs/all_findings.json");
      expect(text).toBe("all_findings.json");
      expect(text).not.toContain("\x1b]8");
      expect(text).not.toContain("file://");
    });
  });

  describe("resolveLinkStyle", () => {
    it("is 'path' when color is off, regardless of terminal", () => {
      expect(resolveLinkStyle(false, { TERM_PROGRAM: "iTerm.app" })).toBe("path");
      expect(resolveLinkStyle(false, { TERM_PROGRAM: "Apple_Terminal" })).toBe("path");
    });

    it("is 'url' for Warp and Apple Terminal when color is on", () => {
      expect(resolveLinkStyle(true, { TERM_PROGRAM: "WarpTerminal" })).toBe("url");
      expect(resolveLinkStyle(true, { TERM_PROGRAM: "Apple_Terminal" })).toBe("url");
    });

    it("is 'osc8' for OSC 8-capable and unknown terminals when color is on", () => {
      expect(resolveLinkStyle(true, { TERM_PROGRAM: "iTerm.app" })).toBe("osc8");
      expect(resolveLinkStyle(true, { TERM_PROGRAM: "vscode" })).toBe("osc8");
      expect(resolveLinkStyle(true, {})).toBe("osc8");
    });
  });

  describe("supportsOsc8Hyperlinks", () => {
    it("is false for Warp and Apple Terminal, true for others", () => {
      expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: "WarpTerminal" })).toBe(false);
      expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
      expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
      expect(supportsOsc8Hyperlinks({ TERM_PROGRAM: "vscode" })).toBe(true);
      expect(supportsOsc8Hyperlinks({})).toBe(true);
    });
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

    it("renders a skipped row with a neutral marker, not a failure ✗", () => {
      const { reporter, out } = capture();
      const board = reporter.board([{ key: "cx", label: "codex_general_reviewer (general)" }]);
      board.set("cx", "skipped", "codex CLI not found on PATH");
      board.stop();
      const text = out.join("\n");
      expect(text).toContain("codex_general_reviewer (general) — codex CLI not found on PATH");
      expect(text).toContain("⊘");
      expect(text).not.toContain("✗");
    });
  });
});
