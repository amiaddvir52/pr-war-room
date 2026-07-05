import { dirname, relative } from "node:path";
import type {
  PacketVerification,
  PacketVerificationCommand,
  ReviewPacket,
} from "../context/types.js";
import type {
  FinalFinding,
  FindingCluster,
  JudgeClassification,
  JudgeResult,
  SkepticResult,
  SupportLevel,
} from "../findings/schema.js";
import {
  CLASSIFICATION_PRIORITY,
  computePriorityScore,
  deterministicClassification,
} from "../findings/scoreFindings.js";
import type { ArtifactPaths } from "../storage/artifactPaths.js";

/**
 * Phase 10 — Markdown report generation (PRD §10.9). A PURE, IO-free renderer:
 * it takes the pipeline's already-computed, already-validated in-memory objects
 * and returns the `.ai-review/report.md` string. Keeping it pure (no disk reads,
 * no writes) mirrors `renderReviewPacketMarkdown` and makes every branch — the
 * grouping, the caps, the degraded modes — unit-testable without a filesystem.
 *
 * The report is deliberately concise (§9.2 actionable-over-exhaustive): grouped
 * findings with their evidence, a verification summary, a dropped-count, and
 * links to the raw JSON artifacts — never raw model output.
 */

export interface ReportInput {
  /** Phase-4 packet — PR header + condensed verification results. */
  packet: ReviewPacket;
  /** ALL clusters (Phase 7) — resolves dropped-finding titles; degraded-mode body. */
  clusters: FindingCluster[];
  /** Skeptic-supported subset that fed the judge; degraded-mode body input. */
  candidates: FindingCluster[];
  /** Skeptic results (Phase 8); `[]` when skeptic disabled. Includes drops. */
  skepticResults: SkepticResult[];
  /** Judge results (Phase 9); `null` when judge disabled. Includes drops. */
  ranked: JudgeResult[] | null;
  /** Report-ready findings (Phase 9), sorted, drops excluded; `null` when judge disabled. */
  final: FinalFinding[] | null;
  /** Raw normalized finding count (pre-dedup) — the funnel's origin. */
  rawFindingCount: number;
  /** Provenance for the footer. */
  meta: { toolVersion: string; generatedAt: string };
  options: {
    maxFindings: number;
    includeNiceToHave: boolean;
    judgeEnabled: boolean;
    skepticEnabled: boolean;
  };
  /** Artifact layout — used to compute relative links from `report.md`. */
  paths: ArtifactPaths;
}

/**
 * The normalized unit the body renders, identical whether the judge ran or not.
 * When the judge is disabled we synthesize it from the deterministic scoring
 * rules so the report reads the same as a deterministic-judge run.
 */
interface ReportFinding {
  cluster: FindingCluster;
  classification: Exclude<JudgeClassification, "drop">;
  score: number;
  support: SupportLevel | null;
}

const HEADER = "# AI Pre-Review Report";

export function renderMarkdownReport(input: ReportInput): string {
  const pool = buildPool(input);

  // Summary buckets reflect the TRUE totals (pre-cap); the sections below show
  // only what fits the display budget, with the difference called out.
  const poolBlockers = pool.filter((f) => f.classification === "blocker").length;
  const poolShouldFix = pool.filter((f) => f.classification === "should_fix_before_review").length;
  const optionalCount = pool.filter((f) => f.classification === "nice_to_have").length;

  // includeNiceToHave FIRST so hidden optionals never consume the maxFindings cap.
  const filtered = input.options.includeNiceToHave
    ? pool
    : pool.filter((f) => f.classification !== "nice_to_have");
  const hiddenOptional = input.options.includeNiceToHave ? 0 : optionalCount;

  const displayed = filtered.slice(0, Math.max(0, input.options.maxFindings));
  const omittedByCap = filtered.length - displayed.length;

  const mustFix = displayed.filter((f) => f.classification === "blocker");
  const shouldFix = displayed.filter((f) => f.classification === "should_fix_before_review");
  const optional = displayed.filter((f) => f.classification === "nice_to_have");

  // How many of each class the `maxFindings` cap pushed off the end. The verdict
  // and the Summary counts stay on the TRUE (pre-cap) totals; these per-class
  // omission counts let every section and the omission note say honestly what
  // was hidden — never call a capped blocker "lower-priority", and never print
  // "_None._" for a class that only looks empty because it was capped.
  const capped = filtered.slice(displayed.length);
  const omittedBlockers = capped.filter((f) => f.classification === "blocker").length;
  const omittedShouldFix = capped.filter(
    (f) => f.classification === "should_fix_before_review",
  ).length;
  const omittedOptional = capped.filter((f) => f.classification === "nice_to_have").length;

  const dropped = collectDropped(input);

  const out: string[] = [];
  out.push(HEADER, "");
  out.push(
    ...renderSummary(input, {
      poolBlockers,
      poolShouldFix,
      optionalCount,
      hiddenOptional,
      omittedByCap,
      omittedBlockers,
      omittedShouldFix,
      displayedEmpty: displayed.length === 0,
      poolEmpty: pool.length === 0,
      droppedTotal: dropped.length,
    }),
  );
  out.push(...renderFindingSection("Must Fix Before Human Review", mustFix, omittedBlockers));
  out.push(...renderFindingSection("Should Fix Before Human Review", shouldFix, omittedShouldFix));
  out.push(...renderSuggestedTests(displayed));
  out.push(
    ...renderOptionalSection(
      optional,
      input.options.includeNiceToHave,
      hiddenOptional,
      omittedOptional,
    ),
  );
  out.push(...renderVerificationSection(input.packet.verification, input.paths));
  out.push(...renderDropped(dropped));
  out.push(...renderRawArtifacts(input));

  out.push("---", "");
  out.push(`_Generated by pr-war-room v${input.meta.toolVersion} at ${input.meta.generatedAt}._`);
  out.push("");

  return out.join("\n");
}

/* ------------------------------- body pool ------------------------------- */

function buildPool(input: ReportInput): ReportFinding[] {
  // Judge ran: `final` is the report-ready, already-sorted (blocker → …, score
  // desc) join. A FinalFinding structurally IS a FindingCluster, so reuse it.
  if (input.final !== null) {
    return input.final.map((f) => ({
      cluster: f,
      classification: narrowClassification(f.final_classification),
      score: f.final_score,
      support: f.skeptic_support_level,
    }));
  }

  // Judge disabled: synthesize from the skeptic-supported candidates using the
  // same deterministic rules the offline judge path uses, then sort identically.
  const skepticById = new Map(input.skepticResults.map((r) => [r.cluster_id, r]));
  const synthesized = input.candidates.map((cluster): ReportFinding => {
    const skeptic = skepticById.get(cluster.cluster_id) ?? null;
    return {
      cluster,
      classification: narrowClassification(deterministicClassification(cluster, skeptic)),
      score: computePriorityScore(cluster, skeptic),
      support: skeptic?.model_verdict?.support_level ?? null,
    };
  });

  synthesized.sort((a, b) => {
    const byClass =
      CLASSIFICATION_PRIORITY[b.classification] - CLASSIFICATION_PRIORITY[a.classification];
    if (byClass !== 0) return byClass;
    if (b.score !== a.score) return b.score - a.score;
    return a.cluster.cluster_id.localeCompare(b.cluster.cluster_id);
  });
  return synthesized;
}

/** `deterministicClassification` never returns `drop`, and `final` excludes drops. */
function narrowClassification(c: JudgeClassification): Exclude<JudgeClassification, "drop"> {
  return c === "drop" ? "nice_to_have" : c;
}

/* -------------------------------- summary -------------------------------- */

interface SummaryCounts {
  poolBlockers: number;
  poolShouldFix: number;
  optionalCount: number;
  hiddenOptional: number;
  omittedByCap: number;
  /** High-priority findings the cap hid — surfaced explicitly, not as "lower-priority". */
  omittedBlockers: number;
  omittedShouldFix: number;
  displayedEmpty: boolean;
  /** No finding survived skeptic+judge (distinct from "all survivors are hidden optionals"). */
  poolEmpty: boolean;
  droppedTotal: number;
}

function renderSummary(input: ReportInput, c: SummaryCounts): string[] {
  const p = input.packet.pr;
  const title = sanitizeInline(p.title);
  const out: string[] = ["## Summary", ""];

  out.push(`- **PR:** [${p.owner}/${p.repo}#${p.number} — ${title}](${p.htmlUrl})`);
  out.push(`- **Result:** ${readinessVerdict(c.poolBlockers, c.poolShouldFix, input.packet.verification)}`);

  const notes: string[] = [];
  if (c.hiddenOptional > 0) {
    notes.push(
      `${c.hiddenOptional} optional ${plural(c.hiddenOptional, "finding")} hidden — enable \`review.includeNiceToHave\` to show`,
    );
  }
  if (c.omittedByCap > 0) {
    // Name the high-priority items the cap hid rather than calling everything
    // beyond the limit "lower-priority" — a capped blocker is still a blocker.
    const highPriority: string[] = [];
    if (c.omittedBlockers > 0) {
      highPriority.push(`${c.omittedBlockers} ${plural(c.omittedBlockers, "blocker")}`);
    }
    if (c.omittedShouldFix > 0) highPriority.push(`${c.omittedShouldFix} should-fix`);
    // Em-dash (not parens) so this reads cleanly inside the Findings line's own
    // parenthesized note suffix rather than nesting `(… (…))`.
    const detail = highPriority.length > 0 ? ` — including ${highPriority.join(", ")}` : "";
    notes.push(
      `${c.omittedByCap} ${plural(c.omittedByCap, "finding")} beyond the \`maxFindings=${input.options.maxFindings}\` limit not shown${detail}`,
    );
  }
  const noteSuffix = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  out.push(
    `- **Findings:** ${c.poolBlockers} blocker, ${c.poolShouldFix} should-fix, ${c.optionalCount} optional${noteSuffix}`,
  );

  out.push(`- **Verification:** ${verificationSummary(input.packet.verification)}`);
  out.push(`- **Funnel:** ${renderFunnel(input, c.droppedTotal)}`);

  if (c.displayedEmpty) {
    // Distinguish the three ways the body can be empty by the FUNNEL, not the
    // raw count: nothing found, everything dropped (nothing survived), or
    // survivors exist but are all hidden optionals (the default
    // includeNiceToHave=false path). The old raw-count branch wrongly claimed
    // "all dropped" for the last case, contradicting "Dropped Findings: None".
    let note: string;
    if (input.rawFindingCount === 0) {
      note = "The reviewers surfaced no findings on this PR.";
    } else if (c.poolEmpty) {
      note = "All findings were dropped as unsupported or low-value — see Dropped Findings.";
    } else {
      note =
        "All surviving findings are optional and hidden — enable `review.includeNiceToHave` to show them.";
    }
    out.push(`- **Note:** ${note}`);
  }

  out.push("");
  return out;
}

/** Qualitative readiness verdict derived from the true bucket totals + verification. */
function readinessVerdict(
  blockers: number,
  shouldFix: number,
  verification: PacketVerification,
): string {
  if (blockers > 0) {
    return `Not ready — ${blockers} ${plural(blockers, "blocker")} must be fixed before human review.`;
  }
  if (shouldFix > 0) {
    return `Needs work — ${shouldFix} ${plural(shouldFix, "item")} to address before requesting review.`;
  }
  if (verification.ran && !verification.allPassed) {
    return "Caution — no blockers found, but verification failed.";
  }
  return verification.ran
    ? "Looks ready for human review."
    : "Looks ready for human review. Verification not run — pass `--verify` to confirm.";
}

function renderFunnel(input: ReportInput, droppedTotal: number): string {
  const parts = [
    `${input.rawFindingCount} raw ${plural(input.rawFindingCount, "finding")}`,
    `${input.clusters.length} ${plural(input.clusters.length, "cluster")}`,
  ];
  if (input.options.skepticEnabled) parts.push(`${input.candidates.length} after skeptic`);
  if (input.options.judgeEnabled) parts.push(`${input.final?.length ?? 0} ranked`);
  return `${parts.join(" → ")} (${droppedTotal} dropped)`;
}

function verificationSummary(v: PacketVerification): string {
  if (!v.ran) return "not run";
  return v.allPassed ? "all commands passed ✓" : "failures present ✗";
}

/* ------------------------------- findings -------------------------------- */

function renderFindingSection(
  heading: string,
  findings: ReportFinding[],
  omittedInClass = 0,
): string[] {
  const out: string[] = [`## ${heading}`, ""];
  // Only truly empty (nothing here AND nothing capped) prints "_None._".
  // A class the cap emptied says so, so it never contradicts the Summary count.
  if (findings.length === 0 && omittedInClass === 0) {
    out.push("_None._", "");
    return out;
  }
  for (const f of findings) out.push(...renderFindingBlock(f));
  if (omittedInClass > 0) {
    out.push(
      `_${omittedInClass} more ${plural(omittedInClass, "finding")} not shown — capped by \`maxFindings\` (see Summary)._`,
      "",
    );
  }
  return out;
}

function renderOptionalSection(
  optional: ReportFinding[],
  includeNiceToHave: boolean,
  hiddenOptional: number,
  omittedOptional = 0,
): string[] {
  const out: string[] = ["## Optional Improvements", ""];
  if (!includeNiceToHave) {
    out.push(
      hiddenOptional > 0
        ? `_${hiddenOptional} optional ${plural(hiddenOptional, "improvement")} hidden. Enable \`review.includeNiceToHave\` to include them._`
        : "_None._",
      "",
    );
    return out;
  }
  if (optional.length === 0 && omittedOptional === 0) {
    out.push("_None._", "");
    return out;
  }
  for (const f of optional) out.push(...renderFindingBlock(f));
  if (omittedOptional > 0) {
    out.push(
      `_${omittedOptional} more ${plural(omittedOptional, "finding")} not shown — capped by \`maxFindings\` (see Summary)._`,
      "",
    );
  }
  return out;
}

function renderFindingBlock(f: ReportFinding): string[] {
  const c = f.cluster;
  const out: string[] = [`### ${sanitizeInline(c.merged_title)}`, ""];

  out.push(`- **Severity:** ${c.severity}`);
  out.push(`- **Category:** ${c.category}`);
  out.push(`- **Confidence:** ${c.confidence.toFixed(2)}`);
  out.push(`- **Human review likelihood:** ${c.human_review_likelihood.toFixed(2)}`);
  out.push(`- **File:** ${c.file === null ? "(none)" : `\`${c.file}\``}`);
  out.push(`- **Lines:** ${renderLines(c)}`);
  out.push(
    `- **Reported by:** ${c.agreement} ${plural(c.agreement, "reviewer")} (${c.source_agents.join(", ")})`,
  );
  if (f.support !== null) out.push(`- **Skeptic support:** ${f.support}`);
  out.push(`- **Score:** ${f.score.toFixed(2)}`);
  out.push("");

  out.push(`**Why this matters:** ${sanitizeInline(c.claim)}`, "");
  out.push(...renderEvidence(c.evidence));
  out.push(...renderSuggestion("Suggested fix", c.suggested_fix));
  out.push(...renderSuggestion("Suggested test", c.suggested_test));
  out.push("");
  return out;
}

function renderLines(c: FindingCluster): string {
  return c.line_start === 0 && c.line_end === 0
    ? "file-level (no line range)"
    : `${c.line_start}-${c.line_end}`;
}

/** Evidence as a bullet list; collapsed behind `<details>` once it gets long. */
function renderEvidence(evidence: string[]): string[] {
  const items = evidence.map((e) => `- ${sanitizeInline(e)}`);
  if (evidence.length > 4) {
    return [
      `<details><summary>Evidence (${evidence.length})</summary>`,
      "",
      ...items,
      "",
      "</details>",
      "",
    ];
  }
  return ["**Evidence:**", ...items, ""];
}

/** A nullable suggestion. Multi-line / long ones are fenced inside `<details>`. */
function renderSuggestion(label: string, value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  const trimmed = value.trim();
  if (trimmed.includes("\n") || trimmed.length > 200) {
    return [`<details><summary>${label}</summary>`, "", fence(trimmed), "", "</details>", ""];
  }
  return [`**${label}:** ${trimmed}`, ""];
}

function renderSuggestedTests(displayed: ReportFinding[]): string[] {
  const tests: string[] = [];
  for (const f of displayed) {
    const t = f.cluster.suggested_test;
    if (t !== null && t.trim() !== "") tests.push(t.trim());
  }
  const out: string[] = ["## Suggested Tests", ""];
  if (tests.length === 0) {
    out.push("_None._", "");
    return out;
  }
  for (const t of tests) {
    out.push(t.includes("\n") ? fence(t) : `- ${sanitizeInline(t)}`);
  }
  out.push("");
  return out;
}

/* ----------------------------- verification ------------------------------ */

function renderVerificationSection(v: PacketVerification, paths: ArtifactPaths): string[] {
  const out: string[] = ["## Verification Results", ""];
  if (!v.ran) {
    out.push("_Verification not run (detection only). Re-run with `--verify` to execute._", "");
    return out;
  }
  out.push(`- **Result:** ${v.allPassed ? "all passed ✓" : "failures present ✗"}`);
  if (v.install) out.push(...renderVerificationCommand(v.install, "Install"));
  for (const cmd of v.commands) out.push(...renderVerificationCommand(cmd));
  out.push("");
  out.push(`_Full output: ${link(paths.reportMd, paths.verification.initial)}_`, "");
  return out;
}

function renderVerificationCommand(c: PacketVerificationCommand, label = ""): string[] {
  const prefix = label ? `${label} ` : "";
  const status = c.passed ? "✓" : c.timedOut ? "timed out ✗" : "✗";
  const lines = [`- ${prefix}\`${c.command}\`: exit ${c.exitCode ?? "—"} ${status}`];
  if (!c.passed) {
    const output = (c.stderrPreview || c.stdoutPreview || c.spawnError || "").trim();
    if (output) lines.push("", "<details><summary>output</summary>", "", fence(output), "", "</details>");
  }
  return lines;
}

/* ------------------------------- dropped --------------------------------- */

interface DroppedEntry {
  title: string;
  reason: string;
  stage: "skeptic" | "judge";
}

function collectDropped(input: ReportInput): DroppedEntry[] {
  const clusterById = new Map(input.clusters.map((c) => [c.cluster_id, c]));
  const titleOf = (id: string): string => clusterById.get(id)?.merged_title ?? id;

  const entries: DroppedEntry[] = [];
  for (const r of input.skepticResults) {
    if (r.decision.action === "drop") {
      entries.push({ title: titleOf(r.cluster_id), reason: r.decision.reason, stage: "skeptic" });
    }
  }
  if (input.ranked !== null) {
    for (const r of input.ranked) {
      if (r.decision.classification === "drop") {
        entries.push({ title: titleOf(r.cluster_id), reason: r.decision.reason, stage: "judge" });
      }
    }
  }
  return entries;
}

function renderDropped(dropped: DroppedEntry[]): string[] {
  const out: string[] = ["## Dropped Findings", ""];
  if (dropped.length === 0) {
    out.push("_None._", "");
    return out;
  }
  out.push(`${dropped.length} ${plural(dropped.length, "finding")} dropped and not shown above:`, "");
  for (const d of dropped) {
    out.push(`- **${sanitizeInline(d.title)}** — ${sanitizeInline(d.reason)} _(${d.stage})_`);
  }
  out.push("");
  return out;
}

/* ------------------------------- artifacts ------------------------------- */

function renderRawArtifacts(input: ReportInput): string[] {
  const { paths, options } = input;
  const out: string[] = ["## Raw Artifacts", ""];
  const targets: string[] = [
    paths.runMetadata,
    paths.context.packetJson,
    paths.context.packetMd,
    paths.normalized.allFindings,
    paths.deduped.clusters,
  ];
  if (options.skepticEnabled) targets.push(paths.skeptic.results);
  if (options.judgeEnabled) targets.push(paths.judge.ranked, paths.finalFindings);
  for (const t of targets) out.push(`- ${link(paths.reportMd, t)}`);
  out.push("");
  return out;
}

/* -------------------------------- helpers -------------------------------- */

/** A markdown link from `report.md` to a sibling artifact, path relative to `.ai-review/`. */
function link(reportMd: string, target: string): string {
  const rel = relative(dirname(reportMd), target);
  return `[${rel}](${rel})`;
}

function fence(body: string, lang = ""): string {
  // The delimiter must be longer than any backtick run inside `body`, or
  // untrusted content (LLM suggestions, subprocess output) that contains its
  // own ``` fence would close this one early and corrupt the rest of the
  // report. Grow it to one more than the longest internal run (min 3) instead
  // of mutating the content, so what we render matches the model verbatim.
  const longestRun = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

/**
 * Prepare untrusted text for an INLINE markdown context (a `###` heading, a
 * list item, a link label): collapse every kind of line break — including a
 * standalone `\r` — to a space, then backslash-escape the metacharacters that
 * would otherwise inject structure (code spans, links/images, emphasis, raw
 * HTML, table cells). NEVER use this on fenced code/output blocks — escaping
 * would corrupt the very content those blocks exist to show verbatim.
 */
function sanitizeInline(s: string): string {
  return s
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>~|]/g, "\\$&")
    .trim();
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
