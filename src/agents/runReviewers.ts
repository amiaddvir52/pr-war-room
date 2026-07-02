import { relative } from "node:path";
import type { AgentSpec, Config, ReviewConfig } from "../config/types.js";
import type { ReviewPacket } from "../context/types.js";
import { ReviewerError, ReviewerTimeoutError } from "../errors.js";
import type { Finding } from "../findings/schema.js";
import { normalizeFindings } from "../findings/normalizeFindings.js";
import { partitionFindings } from "../findings/validateFinding.js";
import type { ArtifactPaths } from "../storage/artifactPaths.js";
import { writeJsonArtifact, writeTextArtifact } from "../storage/writeArtifact.js";
import type { Reporter } from "../ui/reporter.js";
import { MockReviewer } from "./MockReviewer.js";
import { Reviewer } from "./Reviewer.js";
import { createModelClient } from "./modelClient.js";
import type { ModelClient, RawAgentResult, ReviewerAgent } from "./types.js";
import { mapWithConcurrency } from "../util/mapWithConcurrency.js";
import { TIMEOUT_GRACE_MS, withTimeout } from "../util/withTimeout.js";

export interface RunReviewersInput {
  packet: ReviewPacket;
  packetMarkdown: string;
  config: Config;
  paths: ArtifactPaths;
  reporter: Reporter;
  /**
   * Injected in tests to avoid the network. Given the agent spec, returns the
   * `ModelClient` to use (only called for non-`mock` backends).
   */
  makeClient?: (spec: AgentSpec) => ModelClient;
}

/**
 * How a single reviewer's run ended. The first two are *usable* — the reviewer
 * returned valid structured output (`ok` with findings, `no_findings` with a
 * valid empty result). The rest produced nothing usable: `unusable_output` is a
 * refusal / truncation / unparseable or schema-invalid response, `failed` is a
 * hard error, `timeout` is exceeding the time budget.
 */
export type AgentStatus = "ok" | "no_findings" | "unusable_output" | "failed" | "timeout";

/** The usable outcomes: the reviewer returned valid structured output. */
export function isUsable(status: AgentStatus): boolean {
  return status === "ok" || status === "no_findings";
}

/** Per-agent execution record (written to `raw/agent_runs.json`). */
export interface AgentRun {
  name: string;
  backend: string;
  angle: string;
  status: AgentStatus;
  durationMs: number;
  findingCount: number;
  droppedCount: number;
  /** Set for `unusable_output`: the refusal / truncation / parse-failure detail. */
  parseError: string | null;
  /** Hard failure message (missing credentials, CLI not found, timeout, …). */
  error: string | null;
  /** Relative path to the raw output, when it was captured. */
  rawRef: string | null;
}

export interface RunReviewersResult {
  /** All agents' normalized findings, merged (input to Phase 7 dedup). */
  findings: Finding[];
  agents: AgentRun[];
}

export type RunReviewers = (input: RunReviewersInput) => Promise<RunReviewersResult>;

function classifyError(err: unknown): { status: "failed" | "timeout"; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  // Both the CLI backends (subprocess self-kill) and the orchestrator backstop
  // throw a `ReviewerTimeoutError`, so a single `instanceof` check classifies a
  // timeout regardless of which fired first — no fragile message matching.
  if (err instanceof ReviewerTimeoutError) {
    return { status: "timeout", message };
  }
  return { status: "failed", message };
}

function firstLine(s: string): string {
  return s.split("\n").find((line) => line.trim().length > 0)?.trim() ?? s;
}

function buildReviewer(spec: AgentSpec, review: ReviewConfig, input: RunReviewersInput): ReviewerAgent {
  if (spec.backend === "mock") return new MockReviewer(spec.name);
  const timeoutMs = spec.timeoutMs ?? input.config.agents.timeoutMs;
  const client = input.makeClient
    ? input.makeClient(spec)
    : createModelClient(spec.backend, { timeoutMs });
  return new Reviewer(spec.name, client, spec.angle, review);
}

/** Run one reviewer, capture its artifacts, and return its record + findings. */
async function runOne(
  spec: AgentSpec,
  input: RunReviewersInput,
): Promise<{ run: AgentRun; findings: Finding[] }> {
  const { paths, config } = input;
  const base = { name: spec.name, backend: spec.backend, angle: spec.angle };
  const timeoutMs = spec.timeoutMs ?? config.agents.timeoutMs;
  const start = Date.now();

  let result: RawAgentResult;
  try {
    const reviewer = buildReviewer(spec, config.review, input);
    // The CLI backends self-kill their subprocess at `timeoutMs`; this backstop
    // (a small grace later) covers the API backend and any hang. The grace lets
    // the subprocess-killing timer fire first, avoiding orphaned processes.
    result = await withTimeout(
      reviewer.review({ packet: input.packet, packetMarkdown: input.packetMarkdown }),
      timeoutMs + TIMEOUT_GRACE_MS,
    );
  } catch (err) {
    const { status, message } = classifyError(err);
    return {
      run: {
        ...base,
        status,
        durationMs: Date.now() - start,
        findingCount: 0,
        droppedCount: 0,
        parseError: null,
        error: message,
        rawRef: null,
      },
      findings: [],
    };
  }

  // Capture the raw output first, so it's on disk even if nothing parses.
  await writeTextArtifact(paths.raw.reviewMd(spec.name), result.rawText);
  const rawRef = relative(paths.root, paths.raw.reviewMd(spec.name));

  const { valid, dropped } = partitionFindings(result.findings, config.review);
  await writeJsonArtifact(paths.raw.findingsJson(spec.name), valid);
  const findings = normalizeFindings(valid, { agent: spec.name, rawRef });

  // A parse error (refusal / truncation / non-JSON / schema-invalid) is *not* a
  // clean empty review — it is unusable. `no_findings` is reserved for valid
  // structured output that legitimately contained zero findings.
  const status: AgentStatus =
    result.parseError !== null ? "unusable_output" : findings.length > 0 ? "ok" : "no_findings";

  return {
    run: {
      ...base,
      status,
      durationMs: Date.now() - start,
      findingCount: findings.length,
      droppedCount: dropped.length,
      parseError: result.parseError,
      error: null,
      rawRef,
    },
    findings,
  };
}

/**
 * Map a finished run to its board row: ✓ (usable output) or ✗, plus a short
 * detail. The longer failure diagnostic is emitted separately by `warnFailure`,
 * below the board, so it doesn't get squeezed onto the live row.
 */
function boardResult(run: AgentRun): { status: "ok" | "fail"; detail: string } {
  const dropped = run.droppedCount > 0 ? ` (${run.droppedCount} dropped)` : "";
  if (run.status === "ok") {
    return {
      status: "ok",
      detail: `${run.findingCount} finding${run.findingCount === 1 ? "" : "s"}${dropped}`,
    };
  }
  if (run.status === "no_findings") return { status: "ok", detail: `no findings${dropped}` };
  if (run.status === "unusable_output") return { status: "fail", detail: "unusable output" };
  if (run.status === "timeout") return { status: "fail", detail: "timed out" };
  return { status: "fail", detail: "failed" };
}

/** Emit the diagnostic for a non-usable run (shown once, below the finished board). */
function warnFailure(reporter: Reporter, run: AgentRun): void {
  if (run.status === "unusable_output" && run.parseError) {
    reporter.warn(`${run.name}: ${run.parseError}`);
  } else if (run.status === "failed" && run.error) {
    reporter.warn(`${run.name}: ${firstLine(run.error)}`);
  }
}

/**
 * Phase 6 fan-out. Build the enabled reviewer roster from `agents.reviewers`,
 * run them in parallel (bounded by `agents.concurrency`) each under a per-agent
 * timeout, and merge every agent's normalized findings into
 * `normalized/all_findings.json`. One agent failing, timing out, or producing
 * unusable output never aborts the run — it is recorded in `raw/agent_runs.json`.
 * We throw (so the CLI exits non-zero) only when fewer than
 * `agents.minUsableReviewers` produced *usable* output, so a run where every
 * reviewer refused or emitted garbage is a failure, not a misleading clean review.
 */
export const runReviewers: RunReviewers = async (input) => {
  const { config, paths, reporter } = input;
  const specs = config.agents.reviewers.filter((r) => r.enabled);
  if (specs.length === 0) {
    throw new ReviewerError(
      "No reviewer agents are enabled. Add at least one entry to `agents.reviewers` " +
        "(with `enabled: true`) in .pr-war-room.json.",
    );
  }

  // Live board: one row per reviewer, flipping queued → running → ✓/✗ in place,
  // so the user sees every agent and which are still running. (Off a TTY it
  // degrades to one line per agent as each resolves.)
  const board = reporter.board(specs.map((s) => ({ key: s.name, label: `${s.name} (${s.angle})` })));
  let outcomes: Array<{ run: AgentRun; findings: Finding[] }>;
  try {
    outcomes = await mapWithConcurrency(specs, config.agents.concurrency, async (spec) => {
      board.set(spec.name, "running");
      const outcome = await runOne(spec, input);
      const { status, detail } = boardResult(outcome.run);
      board.set(spec.name, status, detail);
      return outcome;
    });
  } finally {
    board.stop();
  }

  const agents = outcomes.map((o) => o.run);
  const findings = outcomes.flatMap((o) => o.findings);

  await writeJsonArtifact(paths.normalized.allFindings, findings);
  await writeJsonArtifact(paths.raw.agentRuns, { schemaVersion: 1, agents });

  // Surface any failure diagnostics once, below the finished board.
  for (const run of agents) warnFailure(reporter, run);

  const usable = agents.filter((a) => isUsable(a.status));
  const minUsable = config.agents.minUsableReviewers;
  if (usable.length < minUsable) {
    // Prefer a hard error to explain the shortfall; otherwise surface the first
    // unusable-output detail (all agents ran but none returned valid findings).
    const firstProblem =
      agents.find((a) => a.error !== null)?.error ??
      agents.find((a) => a.parseError !== null)?.parseError ??
      "unknown error";
    throw new ReviewerError(
      `Only ${usable.length} of ${agents.length} reviewer agents produced usable output ` +
        `(need at least ${minUsable}). See ${relative(paths.root, paths.raw.agentRuns)} for ` +
        `details. First problem: ${firstLine(firstProblem)}`,
    );
  }

  return { findings, agents };
};
