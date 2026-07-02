import type { ReviewPacket } from "../../src/context/types.js";

/** A minimal, valid `ReviewPacket` for unit tests. Override fields as needed. */
export function makeReviewPacket(overrides: Partial<ReviewPacket> = {}): ReviewPacket {
  return {
    schemaVersion: 1,
    pr: {
      owner: "org",
      repo: "repo",
      number: 1,
      title: "Test PR",
      description: "",
      author: "alice",
      state: "open",
      draft: false,
      baseBranch: "main",
      headBranch: "feature",
      htmlUrl: "https://github.com/org/repo/pull/1",
    },
    repository: {
      projectTypes: ["node"],
      packageManager: "npm",
      detectedCommands: [],
      headSha: "deadbeef",
    },
    verification: { enabled: false, ran: false, allPassed: true, install: null, commands: [] },
    changedFiles: [],
    repoConventions: {
      readmeSummary: null,
      testConventions: null,
      errorHandlingPatterns: null,
      apiPatterns: null,
    },
    limits: { maxPacketBytes: 524_288, approxBytes: 10, truncated: false, trimmedFiles: 0 },
    generatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
