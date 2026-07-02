import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewers, isUsable } from "../../src/agents/runReviewers.js";
import type { AgentRun } from "../../src/agents/runReviewers.js";
import type { ModelClient } from "../../src/agents/types.js";
import { getArtifactPaths } from "../../src/storage/artifactPaths.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import type { AgentSpec, Config } from "../../src/config/types.js";
import { FindingSchema } from "../../src/findings/schema.js";
import type { FindingCore } from "../../src/findings/schema.js";
import { ReviewerError, ReviewerTimeoutError } from "../../src/errors.js";
import { silentReporter } from "../../src/ui/reporter.js";
import { makeReviewPacket } from "../fixtures/reviewPacket.js";

const packet = makeReviewPacket({
  changedFiles: [
    {
      path: "src/x.ts",
      status: "modified",
      previousPath: null,
      additions: 3,
      deletions: 1,
      patchOmitted: false,
      patch: "@@ -1 +1 @@",
      nearbyContext: null,
    },
  ],
});

function coreFinding(title = "Null deref"): FindingCore {
  return {
    title,
    category: "correctness",
    severity: "high",
    confidence: 0.7,
    file: "src/x.ts",
    line_start: 10,
    line_end: 12,
    claim: "x may be undefined",
    evidence: ["guard removed in diff"],
    suggested_fix: null,
    suggested_test: null,
    human_review_likelihood: 0.6,
    needs_code_change: true,
  };
}

/** A client that returns one canned finding, tagged with the request so we can tell agents apart. */
function findingClient(title: string): ModelClient {
  return {
    async complete() {
      return { text: JSON.stringify({ findings: [coreFinding(title)] }), stopReason: "end_turn" };
    },
  };
}

/** A client that returns valid structured output with zero findings (a clean empty result). */
function emptyFindingsClient(): ModelClient {
  return {
    async complete() {
      return { text: JSON.stringify({ findings: [] }), stopReason: "end_turn" };
    },
  };
}

/** A client whose output cannot be parsed into findings (a refusal / prose — unusable). */
function unusableClient(): ModelClient {
  return {
    async complete() {
      return { text: "sorry, I can't help with that", stopReason: "end_turn" };
    },
  };
}

function configWith(reviewers: AgentSpec[], overrides: Partial<Config["agents"]> = {}): Config {
  return {
    ...defaultConfig,
    agents: { ...defaultConfig.agents, reviewers, ...overrides },
  };
}

const byName = (agents: AgentRun[], name: string): AgentRun =>
  agents.find((a) => a.name === name)!;

describe("runReviewers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-reviewers-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs multiple agents in parallel and merges their findings, provenance intact", async () => {
    const paths = getArtifactPaths(dir);
    const reviewers: AgentSpec[] = [
      { name: "alpha", backend: "claude", angle: "general", enabled: true },
      { name: "beta", backend: "claude", angle: "correctness", enabled: true },
      { name: "mock_gamma", backend: "mock", angle: "general", enabled: true },
    ];
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths,
      reporter: silentReporter(),
      makeClient: (spec) => findingClient(`from ${spec.name}`),
    });

    // One finding from each model agent + the mock agent's fabricated findings.
    expect(result.agents).toHaveLength(3);
    expect(result.agents.every((a) => a.status === "ok")).toBe(true);
    expect(byName(result.agents, "alpha").findingCount).toBe(1);

    // Merged findings carry the right source_agent and non-colliding ids.
    const sources = new Set(result.findings.map((f) => f.source_agent));
    expect(sources).toEqual(new Set(["alpha", "beta", "mock_gamma"]));
    expect(result.findings.some((f) => f.id === "alpha-001")).toBe(true);
    expect(result.findings.some((f) => f.id === "beta-001")).toBe(true);
    const ids = result.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique

    // Per-agent raw artifacts + merged normalized findings + run summary written.
    const alphaRaw = await readFile(paths.raw.reviewMd("alpha"), "utf8");
    expect(alphaRaw).toContain("from alpha");
    const normalized = JSON.parse(await readFile(paths.normalized.allFindings, "utf8"));
    expect(() => FindingSchema.array().parse(normalized)).not.toThrow();
    expect(normalized).toHaveLength(result.findings.length);

    const runs = JSON.parse(await readFile(paths.raw.agentRuns, "utf8"));
    expect(runs.agents).toHaveLength(3);
    expect(runs.agents.map((a: AgentRun) => a.name).sort()).toEqual(["alpha", "beta", "mock_gamma"]);
  });

  it("continues when one agent hard-fails, recording it and keeping the others", async () => {
    const paths = getArtifactPaths(dir);
    const reviewers: AgentSpec[] = [
      { name: "good", backend: "claude", angle: "general", enabled: true },
      { name: "broken", backend: "claude", angle: "general", enabled: true },
    ];
    const failingClient: ModelClient = {
      async complete() {
        throw new ReviewerError("`codex` was not found on PATH");
      },
    };
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths,
      reporter: silentReporter(),
      makeClient: (spec) => (spec.name === "broken" ? failingClient : findingClient("ok")),
    });

    expect(byName(result.agents, "good").status).toBe("ok");
    const broken = byName(result.agents, "broken");
    expect(broken.status).toBe("failed");
    expect(broken.error).toMatch(/not found on PATH/);
    // The surviving agent's findings are still merged and written.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.source_agent).toBe("good");
  });

  it("records unparseable output as unusable_output (not a clean empty result) without aborting", async () => {
    const reviewers: AgentSpec[] = [
      { name: "good", backend: "claude", angle: "general", enabled: true },
      { name: "garbled", backend: "claude", angle: "general", enabled: true },
    ];
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
      makeClient: (spec) => (spec.name === "garbled" ? unusableClient() : findingClient("ok")),
    });
    const garbledRun = byName(result.agents, "garbled");
    // A parse failure is unusable, NOT a clean `no_findings` (which is reserved
    // for valid structured output that legitimately contained zero findings).
    expect(garbledRun.status).toBe("unusable_output");
    expect(isUsable(garbledRun.status)).toBe(false);
    expect(garbledRun.parseError).toMatch(/JSON/);
    expect(garbledRun.rawRef).toBe("raw/garbled_review.md");
    // The run still succeeds on the strength of the one usable reviewer.
    expect(result.findings).toHaveLength(1); // only "good"
  });

  it("records a hung agent as a timeout via the orchestrator backstop", async () => {
    // A `mock` agent survives so the run returns and we can inspect the timeout.
    const reviewers: AgentSpec[] = [
      { name: "slow", backend: "claude", angle: "general", enabled: true },
      { name: "fast", backend: "mock", angle: "general", enabled: true },
    ];
    const hanging: ModelClient = {
      complete() {
        return new Promise(() => {}); // never resolves
      },
    };
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers, { timeoutMs: 30 }),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
      makeClient: () => hanging, // only called for the non-mock "slow" agent
    });
    expect(byName(result.agents, "slow").status).toBe("timeout");
    expect(byName(result.agents, "slow").error).toMatch(/timed out/);
    expect(byName(result.agents, "fast").status).toBe("ok");
  });

  it("classifies a CLI backend's ReviewerTimeoutError as a timeout (typed, not message-matched)", async () => {
    const reviewers: AgentSpec[] = [
      { name: "cli_slow", backend: "claude", angle: "general", enabled: true },
      { name: "fast", backend: "mock", angle: "general", enabled: true },
    ];
    const client: ModelClient = {
      async complete() {
        throw new ReviewerTimeoutError("The Claude CLI reviewer timed out after 300000ms");
      },
    };
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
      makeClient: () => client, // only called for the non-mock "cli_slow" agent
    });
    expect(byName(result.agents, "cli_slow").status).toBe("timeout");
  });

  it("classifies a hard failure that merely mentions 'timed out' as failed, not timeout", async () => {
    // Guards against the old substring-matching classifier: a genuine hard error
    // (e.g. a 504 whose message says "connection timed out") is NOT a timeout.
    const reviewers: AgentSpec[] = [
      { name: "misleading", backend: "claude", angle: "general", enabled: true },
      { name: "fast", backend: "mock", angle: "general", enabled: true },
    ];
    const client: ModelClient = {
      async complete() {
        throw new ReviewerError("HTTP 504: upstream connection timed out");
      },
    };
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
      makeClient: () => client,
    });
    expect(byName(result.agents, "misleading").status).toBe("failed");
  });

  it("skips disabled agents", async () => {
    const reviewers: AgentSpec[] = [
      { name: "on", backend: "mock", angle: "general", enabled: true },
      { name: "off", backend: "mock", angle: "general", enabled: false },
    ];
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
    });
    expect(result.agents.map((a) => a.name)).toEqual(["on"]);
  });

  it("throws ReviewerError when every agent fails (after writing artifacts)", async () => {
    const paths = getArtifactPaths(dir);
    const reviewers: AgentSpec[] = [
      { name: "a", backend: "claude", angle: "general", enabled: true },
      { name: "b", backend: "claude", angle: "general", enabled: true },
    ];
    const failing: ModelClient = {
      async complete() {
        throw new ReviewerError("missing credentials");
      },
    };
    await expect(
      runReviewers({
        packet,
        packetMarkdown: "# packet",
        config: configWith(reviewers),
        paths,
        reporter: silentReporter(),
        makeClient: () => failing,
      }),
    ).rejects.toBeInstanceOf(ReviewerError);

    // Artifacts are still written so the failure is inspectable.
    const runs = JSON.parse(await readFile(paths.raw.agentRuns, "utf8"));
    expect(runs.agents).toHaveLength(2);
    expect(runs.agents.every((a: AgentRun) => a.status === "failed")).toBe(true);
  });

  it("throws ReviewerError when no agents are enabled", async () => {
    await expect(
      runReviewers({
        packet,
        packetMarkdown: "# packet",
        config: configWith([{ name: "off", backend: "mock", angle: "general", enabled: false }]),
        paths: getArtifactPaths(dir),
        reporter: silentReporter(),
      }),
    ).rejects.toThrow(/No reviewer agents are enabled/);
  });
});

describe("runReviewers usable-output policy", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prwr-usable-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (
    reviewers: AgentSpec[],
    makeClient: (spec: AgentSpec) => ModelClient,
    overrides: Partial<Config["agents"]> = {},
  ) =>
    runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers, overrides),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
      makeClient,
    });

  it("succeeds with zero findings when every reviewer returns a valid empty result", async () => {
    const reviewers: AgentSpec[] = [
      { name: "e1", backend: "claude", angle: "general", enabled: true },
      { name: "e2", backend: "claude", angle: "general", enabled: true },
    ];
    const result = await run(reviewers, () => emptyFindingsClient());
    expect(result.findings).toHaveLength(0);
    expect(result.agents.every((a) => a.status === "no_findings")).toBe(true);
    expect(result.agents.every((a) => isUsable(a.status))).toBe(true);
  });

  it("fails (non-zero) when every reviewer returns unusable output", async () => {
    const paths = getArtifactPaths(dir);
    const reviewers: AgentSpec[] = [
      { name: "u1", backend: "claude", angle: "general", enabled: true },
      { name: "u2", backend: "claude", angle: "general", enabled: true },
    ];
    await expect(
      runReviewers({
        packet,
        packetMarkdown: "# packet",
        config: configWith(reviewers),
        paths,
        reporter: silentReporter(),
        makeClient: () => unusableClient(),
      }),
    ).rejects.toBeInstanceOf(ReviewerError);
    // Recorded as unusable_output (not no_findings), so the failure is explicable.
    const runs = JSON.parse(await readFile(paths.raw.agentRuns, "utf8"));
    expect(runs.agents.every((a: AgentRun) => a.status === "unusable_output")).toBe(true);
  });

  it("is a partial success when at least the threshold of reviewers is usable", async () => {
    const reviewers: AgentSpec[] = [
      { name: "usable", backend: "claude", angle: "general", enabled: true },
      { name: "broken", backend: "claude", angle: "general", enabled: true },
    ];
    const result = await run(reviewers, (spec) =>
      spec.name === "broken" ? unusableClient() : findingClient("real"),
    );
    expect(byName(result.agents, "usable").status).toBe("ok");
    expect(byName(result.agents, "broken").status).toBe("unusable_output");
    expect(result.findings).toHaveLength(1);
  });

  it("succeeds when reviewers mix a valid-empty result with valid findings", async () => {
    const reviewers: AgentSpec[] = [
      { name: "empty", backend: "claude", angle: "general", enabled: true },
      { name: "finder", backend: "claude", angle: "general", enabled: true },
    ];
    const result = await run(reviewers, (spec) =>
      spec.name === "empty" ? emptyFindingsClient() : findingClient("real"),
    );
    expect(byName(result.agents, "empty").status).toBe("no_findings");
    expect(byName(result.agents, "finder").status).toBe("ok");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.source_agent).toBe("finder");
  });

  it("honors minUsableReviewers as a threshold above 1", async () => {
    const reviewers: AgentSpec[] = [
      { name: "usable", backend: "claude", angle: "general", enabled: true },
      { name: "broken", backend: "claude", angle: "general", enabled: true },
    ];
    // Only one reviewer is usable, but the config requires two.
    await expect(
      run(reviewers, (spec) => (spec.name === "broken" ? unusableClient() : findingClient("real")), {
        minUsableReviewers: 2,
      }),
    ).rejects.toThrow(/Only 1 of 2 reviewer agents produced usable output/);
  });
});
