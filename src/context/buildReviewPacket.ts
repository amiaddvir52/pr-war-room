import type { ParsedPr } from "../github/parsePrUrl.js";
import type { ChangedFile, ChangedFilesArtifact, PrMetadata } from "../github/types.js";
import type { WorkspaceResult } from "../workspace/prepareWorkspace.js";
import type { CommandExecution } from "../workspace/schema.js";
import type { Config } from "../config/types.js";
import type { ArtifactPaths } from "../storage/artifactPaths.js";
import { writeJsonArtifact, writeTextArtifact } from "../storage/writeArtifact.js";
import { collectNearbyContext } from "./collectNearbyContext.js";
import { collectRepoConventions } from "./collectRepoConventions.js";
import type {
  PacketChangedFile,
  PacketVerification,
  PacketVerificationCommand,
  ReviewPacket,
} from "./schema.js";

/**
 * Phase 4 — assemble the structured review packet from the Phase 1–3 outputs
 * (PR metadata, changed files/diffs, workspace detection + verification), plus
 * nearby code context and heuristic repo conventions. Writes both
 * `review_packet.json` (agent input) and `review_packet.md` (human/LLM read).
 * No AI review happens here.
 */

export interface BuildReviewPacketInput {
  pr: ParsedPr;
  prMetadata: PrMetadata;
  changedFiles: ChangedFilesArtifact;
  workspace: WorkspaceResult;
  config: Config;
  paths: ArtifactPaths;
  /** Base dir the `.ai-review/` tree is rooted in. */
  cwd: string;
  /** Injected in tests; defaults to the real nearby-context collector. */
  collectContext?: typeof collectNearbyContext;
}

export interface BuildReviewPacketResult {
  packet: ReviewPacket;
  markdown: string;
}

function toPacketCommand(exec: CommandExecution): PacketVerificationCommand {
  return {
    command: exec.command,
    exitCode: exec.exitCode,
    passed: exec.passed,
    timedOut: exec.timedOut,
    spawnError: exec.spawnError,
    // Already redacted + capped by Phase 3, so safe to embed as evidence.
    stdoutPreview: exec.stdoutPreview,
    stderrPreview: exec.stderrPreview,
  };
}

function buildVerification(workspace: WorkspaceResult): PacketVerification {
  const v = workspace.verification;
  return {
    enabled: v.enabled,
    ran: v.ran,
    allPassed: v.allPassed,
    install: v.install ? toPacketCommand(v.install) : null,
    commands: v.results.map(toPacketCommand),
  };
}

async function toPacketChangedFile(
  file: ChangedFile,
  repoDir: string,
  contextLines: number,
  maxNearbyLines: number,
  collect: typeof collectNearbyContext,
): Promise<PacketChangedFile> {
  const patch = file.patch ?? null;
  // Never let one file's context failure abort the whole packet — degrade to
  // null, matching the "failures are data" pattern used across the codebase.
  let nearbyContext: string | null = null;
  try {
    nearbyContext = await collect({
      repoDir,
      filePath: file.filename,
      patch,
      status: file.status,
      contextLines,
      maxTotalLines: maxNearbyLines,
    });
  } catch {
    nearbyContext = null;
  }
  return {
    path: file.filename,
    status: file.status,
    previousPath: file.previousFilename ?? null,
    additions: file.additions,
    deletions: file.deletions,
    patchOmitted: file.patchOmitted,
    patch,
    nearbyContext,
  };
}

/** Trim the packet in place to fit `maxPacketBytes`; returns accounting. */
function enforceSizeLimit(
  packet: ReviewPacket,
  maxPacketBytes: number,
): { approxBytes: number; truncated: boolean; trimmedFiles: number } {
  const sizeOf = (): number => Buffer.byteLength(JSON.stringify(packet), "utf8");
  let trimmedAny = false;
  let trimmedFiles = 0;

  if (sizeOf() > maxPacketBytes) {
    // Drop nearby context first (supplementary), largest first.
    for (const f of [...packet.changedFiles].sort(
      (a, b) => (b.nearbyContext?.length ?? 0) - (a.nearbyContext?.length ?? 0),
    )) {
      if (sizeOf() <= maxPacketBytes) break;
      if (f.nearbyContext !== null) {
        f.nearbyContext = null;
        trimmedAny = true;
      }
    }
    // Then drop patches, largest first.
    for (const f of [...packet.changedFiles].sort(
      (a, b) => (b.patch?.length ?? 0) - (a.patch?.length ?? 0),
    )) {
      if (sizeOf() <= maxPacketBytes) break;
      if (f.patch !== null) {
        f.patch = null;
        f.patchOmitted = true;
        trimmedFiles += 1;
        trimmedAny = true;
      }
    }
  }

  const approxBytes = sizeOf();
  return { approxBytes, truncated: trimmedAny || approxBytes > maxPacketBytes, trimmedFiles };
}

export async function buildReviewPacket(
  input: BuildReviewPacketInput,
): Promise<BuildReviewPacketResult> {
  const { pr, prMetadata, changedFiles, workspace, config, paths } = input;
  const repoDir = paths.workspace.repo;
  const contextLines = config.context.nearbyContextLines;
  const maxNearbyLines = config.context.maxNearbyLinesPerFile;
  const collect = input.collectContext ?? collectNearbyContext;

  const conventions = await collectRepoConventions(repoDir);
  const packetFiles = await Promise.all(
    changedFiles.files.map((f) =>
      toPacketChangedFile(f, repoDir, contextLines, maxNearbyLines, collect),
    ),
  );

  const packet: ReviewPacket = {
    schemaVersion: 1,
    pr: {
      owner: pr.owner,
      repo: pr.repo,
      number: pr.number,
      title: prMetadata.title,
      description: prMetadata.description,
      author: prMetadata.author,
      state: prMetadata.state,
      draft: prMetadata.draft,
      baseBranch: prMetadata.baseBranch,
      headBranch: prMetadata.headBranch,
      htmlUrl: prMetadata.htmlUrl,
    },
    repository: {
      projectTypes: workspace.metadata.projectTypes,
      packageManager: workspace.metadata.packageManager,
      detectedCommands: workspace.metadata.detected.commands,
      headSha: workspace.metadata.headSha,
    },
    verification: buildVerification(workspace),
    changedFiles: packetFiles,
    repoConventions: conventions,
    limits: { maxPacketBytes: config.context.maxPacketBytes, approxBytes: 0, truncated: false, trimmedFiles: 0 },
    generatedAt: new Date().toISOString(),
  };

  // The placeholder `limits` above must exist so the key is counted while
  // sizing; enforceSizeLimit fills in the real accounting in place.
  const accounting = enforceSizeLimit(packet, config.context.maxPacketBytes);
  packet.limits.approxBytes = accounting.approxBytes;
  packet.limits.truncated = accounting.truncated;
  packet.limits.trimmedFiles = accounting.trimmedFiles;

  const markdown = renderReviewPacketMarkdown(packet);

  await writeJsonArtifact(paths.context.packetJson, packet);
  await writeTextArtifact(paths.context.packetMd, markdown);

  return { packet, markdown };
}

/* ----------------------------- markdown --------------------------------- */

function fence(body: string, lang = ""): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

/**
 * One verification command as markdown: a status line, plus (for failures) a
 * collapsed block with the redacted output preview so reviewers see the actual
 * error, not just an exit code.
 */
function renderVerificationCommand(c: PacketVerificationCommand, label = ""): string[] {
  const prefix = label ? `${label} ` : "";
  const status = c.passed ? "✓" : c.timedOut ? "timed out ✗" : "✗";
  const lines = [`- ${prefix}\`${c.command}\`: exit ${c.exitCode ?? "—"} ${status}`];
  if (!c.passed) {
    const output = (c.stderrPreview || c.stdoutPreview || c.spawnError || "").trim();
    if (output) {
      lines.push("", "<details><summary>output</summary>", "", fence(output), "", "</details>");
    }
  }
  return lines;
}

export function renderReviewPacketMarkdown(packet: ReviewPacket): string {
  const p = packet.pr;
  const r = packet.repository;
  const v = packet.verification;
  const out: string[] = [];

  out.push(`# Review Packet: ${p.owner}/${p.repo}#${p.number}`);
  out.push(`**${p.title}**`);
  out.push("");
  out.push("## PR");
  out.push(`- Author: ${p.author}`);
  out.push(`- State: ${p.state}${p.draft ? " (draft)" : ""}`);
  out.push(`- Branch: \`${p.baseBranch}\` ← \`${p.headBranch}\` @ \`${r.headSha.slice(0, 12)}\``);
  out.push(`- URL: ${p.htmlUrl}`);
  out.push("");
  out.push("### Intent");
  out.push(p.description.trim() ? p.description.trim() : "_(no description provided)_");
  out.push("");

  out.push("## Repository");
  out.push(`- Project types: ${r.projectTypes.length ? r.projectTypes.join(", ") : "unknown"}`);
  out.push(`- Package manager: ${r.packageManager ?? "unknown"}`);
  out.push(`- Detected commands: ${r.detectedCommands.length ? r.detectedCommands.map((c) => `\`${c}\``).join(", ") : "none"}`);
  out.push("");

  out.push("## Verification");
  if (!v.enabled) {
    out.push("_Verification not run (detection only). Re-run with `--verify` to execute._");
  } else {
    out.push(`- Result: ${v.allPassed ? "all passed ✓" : "failures present ✗"}`);
    if (v.install) out.push(...renderVerificationCommand(v.install, "Install"));
    for (const c of v.commands) {
      out.push(...renderVerificationCommand(c));
    }
    out.push("");
    out.push("_Full command output is in `.ai-review/verification/` (previews + log files)._");
  }
  out.push("");

  const conv = packet.repoConventions;
  out.push("## Repo Conventions");
  out.push(`- Tests: ${conv.testConventions ?? "unknown"}`);
  out.push(`- API patterns: ${conv.apiPatterns ?? "unknown"}`);
  out.push(`- Error handling: ${conv.errorHandlingPatterns ?? "unknown"}`);
  if (conv.readmeSummary) {
    out.push("");
    out.push("<details><summary>README summary</summary>");
    out.push("");
    out.push(conv.readmeSummary);
    out.push("");
    out.push("</details>");
  }
  out.push("");

  out.push(`## Changed Files (${packet.changedFiles.length})`);
  if (packet.limits.truncated) {
    out.push("");
    out.push(
      `> ⚠ Packet trimmed to fit ${packet.limits.maxPacketBytes} bytes (${packet.limits.trimmedFiles} file patch(es) omitted). See individual files in \`.ai-review/workspace/repo\`.`,
    );
  }
  for (const f of packet.changedFiles) {
    out.push("");
    const origin = f.previousPath ? ` (from \`${f.previousPath}\`)` : "";
    out.push(`### \`${f.path}\` — ${f.status}${origin} (+${f.additions} −${f.deletions})`);
    if (f.patch) {
      out.push("");
      out.push("Diff:");
      out.push(fence(f.patch, "diff"));
    } else if (f.patchOmitted) {
      out.push("");
      out.push("_Patch omitted (binary, too large, or trimmed for size)._");
    }
    if (f.nearbyContext) {
      out.push("");
      out.push("Nearby code:");
      out.push(fence(f.nearbyContext));
    }
  }
  out.push("");

  return out.join("\n");
}
