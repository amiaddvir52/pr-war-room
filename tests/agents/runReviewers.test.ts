import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewers, isUsable } from "../../src/agents/runReviewers.js";
import type { AgentRun } from "../../src/agents/runReviewers.js";
import type { ModelClient } from "../../src/agents/types.js";
import type { DetectBackend } from "../../src/agents/backendAvailability.js";
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

  it("records disabled agents as skipped (visible), not silently omitted", async () => {
    const paths = getArtifactPaths(dir);
    const reviewers: AgentSpec[] = [
      { name: "on", backend: "mock", angle: "general", enabled: true },
      { name: "off", backend: "mock", angle: "general", enabled: false },
    ];
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths,
      reporter: silentReporter(),
    });
    // Both configured agents appear; the disabled one is a visible skip, not omitted.
    expect(result.agents.map((a) => a.name).sort()).toEqual(["off", "on"]);
    const off = byName(result.agents, "off");
    expect(off.status).toBe("skipped");
    expect(off.error).toMatch(/disabled by config/);
    expect(isUsable(off.status)).toBe(false);
    expect(off.rawRef).toBeNull();
    expect(byName(result.agents, "on").status).toBe("ok");
    // The disabled agent contributed nothing, and it's recorded in agent_runs.json.
    expect(result.findings.every((f) => f.source_agent !== "off")).toBe(true);
    const runs = JSON.parse(await readFile(paths.raw.agentRuns, "utf8"));
    expect(runs.agents.map((a: AgentRun) => a.name).sort()).toEqual(["off", "on"]);
  });

  it("runs a codex-backed reviewer when the codex backend is detected available", async () => {
    const reviewers: AgentSpec[] = [
      { name: "codex_general_reviewer", backend: "codex", angle: "general", enabled: true },
    ];
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
      detectBackend: async () => ({ available: true }),
      makeClient: () => findingClient("from codex"),
    });
    const codex = byName(result.agents, "codex_general_reviewer");
    expect(codex.status).toBe("ok");
    expect(codex.backend).toBe("codex");
    expect(result.findings.some((f) => f.source_agent === "codex_general_reviewer")).toBe(true);
  });

  it("reports codex as skipped (not omitted) when unavailable, and keeps the other reviewers", async () => {
    const paths = getArtifactPaths(dir);
    const reviewers: AgentSpec[] = [
      { name: "claude_general_reviewer", backend: "claude", angle: "general", enabled: true },
      { name: "codex_general_reviewer", backend: "codex", angle: "general", enabled: true },
    ];
    const detectBackend: DetectBackend = async (backend) =>
      backend === "codex"
        ? { available: false, reason: "codex CLI not found on PATH" }
        : { available: true };
    const result = await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths,
      reporter: silentReporter(),
      detectBackend,
      makeClient: () => findingClient("real"), // only called for the claude agent
    });

    const codex = byName(result.agents, "codex_general_reviewer");
    expect(codex.status).toBe("skipped");
    expect(codex.error).toMatch(/codex CLI not found/);
    expect(codex.rawRef).toBeNull();
    expect(isUsable(codex.status)).toBe(false);
    // Not silently omitted: present in the roster AND in agent_runs.json.
    const runs = JSON.parse(await readFile(paths.raw.agentRuns, "utf8"));
    expect(runs.agents.map((a: AgentRun) => a.name).sort()).toEqual([
      "claude_general_reviewer",
      "codex_general_reviewer",
    ]);
    // The claude reviewer still ran; the run succeeds on its strength.
    expect(byName(result.agents, "claude_general_reviewer").status).toBe("ok");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.source_agent).toBe("claude_general_reviewer");
  });

  it("detects each backend at most once, even across multiple agents sharing it", async () => {
    const reviewers: AgentSpec[] = [
      { name: "c1", backend: "claude", angle: "general", enabled: true },
      { name: "c2", backend: "claude", angle: "correctness", enabled: true },
      { name: "cx", backend: "codex", angle: "general", enabled: true },
    ];
    const probes: string[] = [];
    await runReviewers({
      packet,
      packetMarkdown: "# packet",
      config: configWith(reviewers),
      paths: getArtifactPaths(dir),
      reporter: silentReporter(),
      detectBackend: async (backend) => {
        probes.push(backend);
        return { available: true };
      },
      makeClient: () => findingClient("x"),
    });
    // Two claude agents share one probe; codex is the second probe.
    expect(probes.sort()).toEqual(["claude", "codex"]);
  });

  it("throws a clear error when every configured agent is skipped (none ran)", async () => {
    const paths = getArtifactPaths(dir);
    const reviewers: AgentSpec[] = [
      { name: "codex_general_reviewer", backend: "codex", angle: "general", enabled: true },
    ];
    await expect(
      runReviewers({
        packet,
        packetMarkdown: "# packet",
        config: configWith(reviewers),
        paths,
        reporter: silentReporter(),
        detectBackend: async () => ({ available: false, reason: "codex CLI not found on PATH" }),
      }),
    ).rejects.toThrow(/were skipped \(none ran\)/);
    // The skip is still recorded for inspection.
    const runs = JSON.parse(await readFile(paths.raw.agentRuns, "utf8"));
    expect(runs.agents[0].status).toBe("skipped");
    expect(runs.agents[0].error).toMatch(/codex CLI not found/);
  });

  it("default roster includes an independent codex_general_reviewer alongside the Claude agents", () => {
    const roster = defaultConfig.agents.reviewers;
    const names = roster.map((r) => r.name);
    expect(names).toContain("codex_general_reviewer");
    const codex = roster.find((r) => r.name === "codex_general_reviewer")!;
    expect(codex.backend).toBe("codex");
    expect(codex.angle).toBe("general");
    expect(codex.enabled).toBe(true);
    // Codex is added, the Claude reviewers are not removed.
    expect(names).toContain("claude_general_reviewer");
    expect(names).toContain("claude_test_gap_reviewer");
    expect(names).toContain("claude_correctness_reviewer");
  });

  it("default roster covers all eight PRD §10.4 angles with cross-vendor duplicates (standard preset)", () => {
    const roster = defaultConfig.agents.reviewers;
    // Every name→backend→angle pairing is pinned (not just the preset-added
    // agents): a swap between any two members must fail this test.
    const expected: ReadonlyArray<readonly [string, string, string]> = [
      ["claude_general_reviewer", "claude", "general"],
      ["codex_general_reviewer", "codex", "general"],
      ["claude_test_gap_reviewer", "claude", "test-gap"],
      ["claude_correctness_reviewer", "claude", "correctness"],
      ["claude_repo_pattern_reviewer", "claude", "repo-pattern"],
      ["claude_security_reviewer", "claude", "security"],
      ["claude_performance_reviewer", "claude", "performance"],
      ["claude_product_intent_reviewer", "claude", "product-intent"],
      ["codex_correctness_reviewer", "codex", "correctness"],
      ["codex_security_reviewer", "codex", "security"],
    ];
    expect(roster.map((r) => [r.name, r.backend, r.angle])).toEqual(expected);
    expect(roster.every((r) => r.enabled)).toBe(true);
    // Two waves by default: concurrency stays below the roster size to bound
    // simultaneous `claude` subprocesses (memory + one account's rate limits).
    expect(defaultConfig.agents.concurrency).toBe(4);
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
    ).rejects.toThrow(/Only 1 of 2 reviewer agents that ran produced usable output/);
  });
});
