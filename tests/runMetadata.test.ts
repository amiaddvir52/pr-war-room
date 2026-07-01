import { describe, it, expect } from "vitest";
import { buildRunMetadata } from "../src/runMetadata.js";
import { defaultConfig } from "../src/config/defaultConfig.js";

describe("buildRunMetadata", () => {
  it("builds a well-formed metadata object", () => {
    const meta = buildRunMetadata({
      command: "review",
      version: "0.1.0",
      pr: { owner: "org", repo: "repo", number: 123 },
      prUrl: "https://github.com/org/repo/pull/123",
      config: defaultConfig,
      configSource: "default",
      configPath: null,
      cwd: "/work",
    });

    expect(meta.tool).toEqual({ name: "pr-war-room", version: "0.1.0" });
    expect(meta.command).toBe("review");
    expect(meta.phase).toBe(1);
    expect(meta.pr?.number).toBe(123);
    expect(meta.config).toEqual(defaultConfig);
    expect(Number.isNaN(Date.parse(meta.timestamp))).toBe(false);
  });
});
