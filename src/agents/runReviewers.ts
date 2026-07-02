import { relative } from "node:path";
import type { AgentSpec, Config, ReviewConfig } from "../config/types.js";
import type { ReviewPacket } from "../context/types.js";
import { ReviewerError } from "../errors.js";
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

/** How a single reviewer's run ended. */
export type AgentStatus = "ok" | "no_findings" | "failed" | "timeout";

/** Per-agent execution record (written to `raw/agent_runs.json`). */
export interface AgentRun {
  name: string;
  backend: string;
  angle: string;
  status: AgentStatus;
  durationMs: number;
  findingCount: number;
  droppedCount: number;
  /** Benign soft failure (refusal / truncation / unparseable output). */
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

/** Grace added to a reviewer's own timeout before the orchestrator backstop fires. */
const TIMEOUT_GRACE_MS = 250;

/** Distinguishes an orchestrator-level timeout from other rejections. */
class TimeoutError extends Error {}

/**
 * Reject with a `TimeoutError` if `promise` doesn't settle within `ms`. This is
 * the backstop for the API backend (which has no internal timeout) and any hung
 * reviewer; the CLI backends also self-kill their subprocess at their own
 * timeout. Either way the caught error is classified as a timeout.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Run `fn` over `items` with at most `limit` in flight; preserves order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function classifyError(err: unknown): { status: "failed" | "timeout"; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  // CLI backends surface their own timeout as a ReviewerError whose message says
  // "timed out"; the orchestrator backstop throws a TimeoutError. Treat both as
  // a timeout so the status is consistent regardless of which fired first.
  if (err instanceof TimeoutError || /timed out/i.test(message)) {
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

  return {
    run: {
      ...base,
      status: result.parseError !== null ? "no_findings" : "ok",
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

function reportAgent(reporter: Reporter, run: AgentRun): void {
  const label = `${run.name} (${run.angle})`;
  const dropped = run.droppedCount > 0 ? ` (${run.droppedCount} dropped)` : "";
  switch (run.status) {
    case "ok":
      reporter.step(
        `${label} — ${run.findingCount} finding${run.findingCount === 1 ? "" : "s"}${dropped}`,
        true,
      );
      break;
    case "no_findings":
      reporter.step(`${label} — no usable findings`, false);
      if (run.parseError) reporter.warn(`${run.name}: ${run.parseError}`);
      break;
    case "timeout":
      reporter.step(`${label} — timed out`, false);
      break;
    case "failed":
      reporter.step(`${label} — failed`, false);
      if (run.error) reporter.warn(`${run.name}: ${firstLine(run.error)}`);
      break;
  }
}

/**
 * Phase 6 fan-out. Build the enabled reviewer roster from `agents.reviewers`,
 * run them in parallel (bounded by `agents.concurrency`) each under a per-agent
 * timeout, and merge every agent's normalized findings into
 * `normalized/all_findings.json`. One agent failing, timing out, or producing no
 * usable output never aborts the run — it is recorded in `raw/agent_runs.json`.
 * Only if *every* agent fails do we throw (so the CLI exits non-zero).
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

  const spin = reporter.spinner(
    `running ${specs.length} reviewer${specs.length === 1 ? "" : "s"} in parallel…`,
  );
  let outcomes: Array<{ run: AgentRun; findings: Finding[] }>;
  try {
    outcomes = await mapWithConcurrency(specs, config.agents.concurrency, (spec) =>
      runOne(spec, input),
    );
  } finally {
    spin.stop();
  }

  const agents = outcomes.map((o) => o.run);
  const findings = outcomes.flatMap((o) => o.findings);

  await writeJsonArtifact(paths.normalized.allFindings, findings);
  await writeJsonArtifact(paths.raw.agentRuns, { schemaVersion: 1, agents });

  for (const run of agents) reportAgent(reporter, run);

  const completed = agents.filter((a) => a.status === "ok" || a.status === "no_findings");
  if (completed.length === 0) {
    const firstError = agents.find((a) => a.error !== null)?.error ?? "unknown error";
    throw new ReviewerError(
      `All ${agents.length} reviewer agents failed. See ` +
        `${relative(paths.root, paths.raw.agentRuns)} for details. First error: ${firstLine(firstError)}`,
    );
  }

  return { findings, agents };
};
