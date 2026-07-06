import type { Config } from "../config/schema.js";
import { FixAgentError } from "../errors.js";
import type { FixProposal } from "../fix/schema.js";
import { FixProposalSchema, FIX_OUTPUT_JSON_SCHEMA } from "../fix/schema.js";
import { parseLastValidObject } from "../util/parseLastValidObject.js";
import { createModelClient } from "./modelClient.js";
import {
  buildFixSystemPrompt,
  buildFixUserPrompt,
  type FixPromptContext,
} from "./prompts/fixPrompt.js";
import type { ModelClient } from "./types.js";

/**
 * The fix agent (Phase 11, PRD §10.10). Same `ModelClient` seam and
 * one-narrow-question-per-call shape as the skeptic and judge: one finding in,
 * one structured proposal out. It THROWS a typed `FixAgentError` on any soft
 * failure or unparseable output; the orchestrator (`runFixes`) catches it,
 * records the failure `kind` on the finding's outcome, and moves on — one
 * unfixable finding never aborts the fix run.
 */

/** A fixer asks the model for one edit proposal on one finding. */
export type Fixer = (ctx: FixPromptContext) => Promise<FixProposal>;

/**
 * Return the LAST brace-balanced object in `text` that parses as a valid
 * proposal (see `parseLastValidObject` for why last-wins), or `null`.
 */
export function parseFixProposal(text: string): FixProposal | null {
  return parseLastValidObject(text, FixProposalSchema);
}

/**
 * Build a fixer over a given `ModelClient` — the testable seam (tests inject a
 * fake client, exactly as the judge is tested).
 */
export function fixerFromClient(client: ModelClient): Fixer {
  const system = buildFixSystemPrompt();

  return async (ctx) => {
    const result = await client.complete({
      system,
      user: buildFixUserPrompt(ctx),
      jsonSchema: FIX_OUTPUT_JSON_SCHEMA,
    });
    if (
      result.stopReason === "refusal" ||
      result.stopReason === "max_tokens" ||
      result.stopReason === "error"
    ) {
      const kind =
        result.stopReason === "refusal"
          ? "refusal"
          : result.stopReason === "max_tokens"
            ? "max_tokens"
            : "backend_error";
      throw new FixAgentError(
        `fix agent could not complete (stop reason: ${result.stopReason})`,
        kind,
      );
    }
    const proposal = parseFixProposal(result.text);
    if (proposal === null) {
      throw new FixAgentError("fix agent output did not contain a valid proposal", "parse_error");
    }
    return proposal;
  };
}

/**
 * Build a fixer from config. The client is constructed eagerly so a
 * misconfigured backend fails loudly here, not mid-run. Callers only reach
 * this for a non-`mock` backend — `runFixes` uses `createMockFixer` for `mock`.
 */
export function createFixer(config: Config): Fixer {
  const client: ModelClient = createModelClient(config.fix.backend, {
    timeoutMs: config.fix.timeoutMs,
  });
  return fixerFromClient(client);
}

/**
 * Deterministic offline fixer for the `mock` backend (demo / CI / tests) — no
 * model call, mirroring how the skeptic and judge special-case `mock`. It
 * proposes inserting a `// TODO(pr-war-room)` marker above the finding's
 * anchor line when that line is unique in the shown content, and declines
 * otherwise — enough to exercise the full apply → diff → verify → report flow.
 * Windowed (truncated) files are always declined: uniqueness inside the window
 * cannot prove uniqueness in the whole file, which is what `applyFixEdits`
 * enforces at apply time.
 */
export function createMockFixer(): Fixer {
  return async (ctx) => {
    const { finding, fileContent, fileWindow } = ctx;
    if (fileWindow.truncated) {
      return {
        edits: [],
        summary: "Mock fixer: the file is shown as a window, not in full.",
        needs_manual_review: `Fix "${finding.merged_title}" manually — the mock backend only edits files it can see in full.`,
      };
    }
    const lines = fileContent.split("\n");
    const index = finding.line_start - fileWindow.startLine;
    const anchor = index >= 0 && index < lines.length ? lines[index] : undefined;

    const occurrences =
      anchor === undefined || anchor === ""
        ? 0
        : fileContent.split(anchor).length - 1;
    if (anchor === undefined || anchor.trim() === "" || occurrences !== 1) {
      return {
        edits: [],
        summary: "Mock fixer: no unique anchor line to attach a fix to.",
        needs_manual_review: `Fix "${finding.merged_title}" manually — the mock backend only marks unique anchor lines.`,
      };
    }

    const indent = /^\s*/.exec(anchor)?.[0] ?? "";
    return {
      edits: [
        {
          path: finding.file ?? "",
          search: anchor,
          replace: `${indent}// TODO(pr-war-room): ${finding.merged_title}\n${anchor}`,
        },
      ],
      summary: `Marked the flagged line with a TODO for: ${finding.merged_title}`,
      needs_manual_review: "Mock backend: replace the TODO marker with a real fix.",
    };
  };
}
