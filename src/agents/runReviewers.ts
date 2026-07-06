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
import { defaultDetectBackend } from "./backendAvailability.js";
import type { DetectBackend } from "./backendAvailability.js";
import type { ModelClient, RawAgentResult, ReviewerAgent } from "./types.js";
import { mapWithConcurrency } from "../util/mapWithConcurrency.js";
import { retryOnTimeout } from "../util/retryOnTimeout.js";

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
  /**
   * Injected in tests to simulate an available / unavailable backend without
   * touching the real PATH or environment. Defaults to {@link defaultDetectBackend},
   * which gates the optional `codex` backend on a `codex`-CLI PATH probe.
   */
  detectBackend?: DetectBackend;
}

/**
 * How a single reviewer's run ended. The first two are *usable* — the reviewer
 * returned valid structured output (`ok` with findings, `no_findings` with a
 * valid empty result). The rest produced nothing usable: `unusable_output` is a
 * refusal / truncation / unparseable or schema-invalid response, `failed` is a
 * hard error, `timeout` is exceeding the time budget, and `skipped` means the
 * agent never ran (disabled by config, or its backend was detected unavailable).
 * `skipped` is deliberately distinct from `failed`: a skip is expected and benign
 * (e.g. Codex isn't installed), a failure is a run that tried and errored.
 */
export type AgentStatus =
  | "ok"
  | "no_findings"
  | "unusable_output"
  | "failed"
  | "timeout"
  | "skipped";

/** The usable outcomes: the reviewer returned valid structured output. */
export function isUsable(status: AgentStatus): boolean {
  return status === "ok" || status === "no_findings";
}

/** True when the agent actually executed (i.e. was not skipped). */
export function didRun(status: AgentStatus): boolean {
  return status !== "skipped";
}

/** Per-agent execution record (written to `raw/agent_runs.json`). */
export interface AgentRun {
  name: string;
  backend: string;
  angle: string;
  status: AgentStatus;
  durationMs: number;
  /**
   * How many times the reviewer was invoked (1 = no retry). > 1 means an earlier
   * attempt timed out and was retried (`agents.retries`); the final `status`
   * reflects the last attempt (`ok`/`no_findings` if a retry succeeded, `timeout`
   * if they all timed out). `skipped` agents never ran, so this is 0.
   */
  attempts: number;
  findingCount: number;
  droppedCount: number;
  /** Set for `unusable_output`: the refusal / truncation / parse-failure detail. */
  parseError: string | null;
  /**
   * Hard failure message (missing credentials, CLI not found, timeout, …) for
   * `failed`/`timeout`, or the human-readable reason for a `skipped` agent
   * ("disabled by config", "codex CLI not found on PATH").
   */
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

/**
 * A reviewer that never ran (disabled by config, or its backend was detected
 * unavailable). Recorded so the roster stays fully transparent — every
 * configured agent appears in `agent_runs.json` and the summary, none is silently
 * omitted. The `reason` is stored in `error` and surfaced to the user.
 */
function skippedRun(spec: AgentSpec, reason: string): AgentRun {
  return {
    name: spec.name,
    backend: spec.backend,
    angle: spec.angle,
    status: "skipped",
    durationMs: 0,
    attempts: 0,
    findingCount: 0,
    droppedCount: 0,
    parseError: null,
    error: reason,
    rawRef: null,
  };
}

/** Run one reviewer, capture its artifacts, and return its record + findings. */
async function runOne(
  spec: AgentSpec,
  input: RunReviewersInput,
  onTimeout?: (attempt: number) => void,
): Promise<{ run: AgentRun; findings: Finding[] }> {
  const { paths, config } = input;
  const base = { name: spec.name, backend: spec.backend, angle: spec.angle };
  const timeoutMs = spec.timeoutMs ?? config.agents.timeoutMs;
  const start = Date.now();

  // Build the reviewer once; retryOnTimeout re-invokes `review()`, which spawns a
  // fresh subprocess each call. A transient timeout is retried (agents.retries)
  // so one slow Claude CLI call doesn't remove a whole reviewer angle; refusals /
  // parse failures / hard errors are deterministic and NOT retried.
  const reviewer = buildReviewer(spec, config.review, input);
  let attempts = 0;

  let result: RawAgentResult;
  try {
    // Each attempt gets its own `timeoutMs + grace` backstop inside retryOnTimeout;
    // the CLI backends self-kill their subprocess at `timeoutMs`, and the grace
    // lets that timer win the race so no subprocess is orphaned.
    result = await retryOnTimeout(
      () => {
        attempts++;
        return reviewer.review({ packet: input.packet, packetMarkdown: input.packetMarkdown });
      },
      { timeoutMs, retries: config.agents.retries, onTimeout: (n) => onTimeout?.(n) },
    );
  } catch (err) {
    const { status, message } = classifyError(err);
    return {
      run: {
        ...base,
        status,
        durationMs: Date.now() - start,
        attempts,
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
      attempts,
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
  // Every configured reviewer — including disabled ones — appears in the roster
  // so the run stays transparent: disabled/unavailable agents are recorded as
  // `skipped`, never silently omitted (PRD Phase 6).
  const specs = config.agents.reviewers;
  if (specs.every((s) => !s.enabled)) {
    throw new ReviewerError(
      "No reviewer agents are enabled. Add at least one entry to `agents.reviewers` " +
        "(with `enabled: true`) in .pr-war-room.json.",
    );
  }

  // Detect each backend's availability at most once, even when several agents
  // share a backend (e.g. three `claude` agents → one probe).
  const detect = input.detectBackend ?? defaultDetectBackend;
  const availabilityCache = new Map<AgentSpec["backend"], ReturnType<DetectBackend>>();
  const availabilityOf = (backend: AgentSpec["backend"]): ReturnType<DetectBackend> => {
    let cached = availabilityCache.get(backend);
    if (cached === undefined) {
      cached = detect(backend);
      availabilityCache.set(backend, cached);
    }
    return cached;
  };

  // Live board: one row per configured reviewer, flipping queued → running →
  // ✓/✗/⊘ in place, so the user sees every agent and which are still running.
  // (Off a TTY it degrades to one line per agent as each resolves.)
  const board = reporter.board(specs.map((s) => ({ key: s.name, label: `${s.name} (${s.angle})` })));
  // Retry notes are collected during the concurrent run and flushed AFTER the
  // board freezes, so a "retrying" line never interleaves with the animation.
  const retryNotes: string[] = [];
  let outcomes: Array<{ run: AgentRun; findings: Finding[] }>;
  try {
    outcomes = await mapWithConcurrency(specs, config.agents.concurrency, async (spec) => {
      // Disabled agents are skipped without running — visible, never omitted.
      if (!spec.enabled) {
        board.set(spec.name, "skipped", "disabled by config");
        return { run: skippedRun(spec, "disabled by config"), findings: [] };
      }
      // A backend that can't be attempted (e.g. the `codex` CLI isn't installed)
      // is skipped with its reason — distinct from a run that tried and failed.
      const availability = await availabilityOf(spec.backend);
      if (!availability.available) {
        const reason = availability.reason ?? `${spec.backend} backend unavailable`;
        board.set(spec.name, "skipped", reason);
        return { run: skippedRun(spec, reason), findings: [] };
      }
      board.set(spec.name, "running");
      const outcome = await runOne(spec, input, (attempt) =>
        retryNotes.push(
          `${spec.name} timed out (attempt ${attempt}/${config.agents.retries + 1}) — retrying`,
        ),
      );
      const { status, detail } = boardResult(outcome.run);
      board.set(spec.name, status, detail);
      return outcome;
    });
  } finally {
    board.stop();
  }
  for (const note of retryNotes) reporter.note(note);

  const agents = outcomes.map((o) => o.run);
  const findings = outcomes.flatMap((o) => o.findings);

  await writeJsonArtifact(paths.normalized.allFindings, findings);
  // schemaVersion 2 adds `attempts` per agent (retry-on-timeout, Phase 6).
  await writeJsonArtifact(paths.raw.agentRuns, { schemaVersion: 2, agents });

  // Surface any failure diagnostics once, below the finished board.
  for (const run of agents) warnFailure(reporter, run);

  const usable = agents.filter((a) => isUsable(a.status));
  const ran = agents.filter((a) => didRun(a.status));
  const skipped = agents.filter((a) => a.status === "skipped");
  const minUsable = config.agents.minUsableReviewers;
  if (usable.length < minUsable) {
    const runsRef = relative(paths.root, paths.raw.agentRuns);
    // When every configured agent was skipped, the shortfall is an availability
    // problem, not a review failure — say so plainly with the first skip reason.
    if (ran.length === 0) {
      throw new ReviewerError(
        `All ${agents.length} configured reviewer agents were skipped (none ran). ` +
          `See ${runsRef} for details. First skip reason: ` +
          `${firstLine(skipped[0]?.error ?? "unknown")}`,
      );
    }
    // Otherwise agents ran but too few were usable. Prefer a hard error, then an
    // unusable-output detail, then (last) a skip reason, to explain the shortfall.
    const firstProblem =
      ran.find((a) => a.error !== null)?.error ??
      ran.find((a) => a.parseError !== null)?.parseError ??
      skipped[0]?.error ??
      "unknown error";
    throw new ReviewerError(
      `Only ${usable.length} of ${ran.length} reviewer agents that ran produced usable output ` +
        `(need at least ${minUsable}). See ${runsRef} for details. ` +
        `First problem: ${firstLine(firstProblem)}`,
    );
  }

  return { findings, agents };
};
