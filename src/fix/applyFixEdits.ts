import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readUtf8File } from "../util/readUtf8File.js";
import type { FixEdit, FixFailureKind } from "./schema.js";

/**
 * Apply a proposal's edits to the workspace checkout — all-or-nothing per
 * finding: every edit is staged in memory first, and files are only written
 * when the whole set staged cleanly, so a bad edit never leaves a half-applied
 * proposal in the tree (a write failure mid-commit rolls the written files
 * back). Failures are data (`ok: false` + kind), not throws; the orchestrator
 * records them on the finding's outcome and continues.
 */

/** Where one applied edit landed — lets the orchestrator shift later findings' line anchors. */
export interface AppliedEdit {
  path: string;
  /** 1-based line where the replaced text started, in the file as it was before this edit. */
  line: number;
  /** Net line-count change (newlines in `replace` minus newlines in `search`). */
  lineDelta: number;
}

export type ApplyResult =
  | { ok: true; editsApplied: number; filesTouched: string[]; appliedEdits: AppliedEdit[] }
  | { ok: false; kind: FixFailureKind; message: string };

/**
 * `allowedPaths` is the PR's changed-file set (minus removed files) — the MVP
 * safety guard: the fix agent may only touch code this PR already touches.
 */
export async function applyFixEdits(
  edits: FixEdit[],
  repoDir: string,
  allowedPaths: ReadonlySet<string>,
): Promise<ApplyResult> {
  // Staged content per repo-relative path; multiple edits to one file compose
  // in order against the staged text, not the on-disk original. Originals are
  // kept for rollback if the final commit fails mid-way.
  const staged = new Map<string, string>();
  const originals = new Map<string, string>();
  const appliedEdits: AppliedEdit[] = [];

  for (const edit of edits) {
    // Path guards before any IO: reject absolute paths and anything that
    // resolves outside the checkout (e.g. `../…`).
    if (isAbsolute(edit.path)) {
      return { ok: false, kind: "path_escapes_repo", message: `absolute path: ${edit.path}` };
    }
    const rel = relative(repoDir, resolve(repoDir, edit.path));
    if (rel.startsWith(`..${sep}`) || rel === "..") {
      return { ok: false, kind: "path_escapes_repo", message: `path escapes the checkout: ${edit.path}` };
    }
    if (!allowedPaths.has(edit.path)) {
      return {
        ok: false,
        kind: "path_not_in_changeset",
        message: `"${edit.path}" is not a file this PR changed — fix mode only edits PR-changed files`,
      };
    }

    let content = staged.get(edit.path);
    if (content === undefined) {
      let read: string | null;
      try {
        read = await readUtf8File(resolve(repoDir, edit.path));
      } catch (err) {
        return {
          ok: false,
          kind: "file_unreadable",
          message: `cannot read ${edit.path}: ${(err as Error).message}`,
        };
      }
      if (read === null) {
        return {
          ok: false,
          kind: "file_not_utf8",
          message: `${edit.path} is not valid UTF-8 (binary or legacy encoding) — rewriting it would corrupt it`,
        };
      }
      content = read;
      originals.set(edit.path, content);
    }

    const first = content.indexOf(edit.search);
    if (first === -1) {
      return {
        ok: false,
        kind: "search_not_found",
        message: `search string not found in ${edit.path} (must match byte-exact): ${previewSearch(edit.search)}`,
      };
    }
    if (content.indexOf(edit.search, first + edit.search.length) !== -1) {
      return {
        ok: false,
        kind: "ambiguous_search",
        message: `search string occurs more than once in ${edit.path} (must be unique): ${previewSearch(edit.search)}`,
      };
    }
    appliedEdits.push({
      path: edit.path,
      line: countNewlines(content.slice(0, first)) + 1,
      lineDelta: countNewlines(edit.replace) - countNewlines(edit.search),
    });
    // Splice, not String.replace: the model's `replace` text may contain `$&`,
    // `$'`, `$$`, … which a string replacement pattern would expand.
    staged.set(edit.path, content.slice(0, first) + edit.replace + content.slice(first + edit.search.length));
  }

  // Every edit staged cleanly — commit the writes. A failure mid-loop rolls
  // back what was already written so the all-or-nothing contract holds.
  const written: string[] = [];
  for (const [path, content] of staged) {
    try {
      await writeFile(resolve(repoDir, path), content, "utf8");
    } catch (err) {
      for (const done of written) {
        try {
          await writeFile(resolve(repoDir, done), originals.get(done)!, "utf8");
        } catch {
          // Best effort — the caller's workspace restore is the backstop.
        }
      }
      return {
        ok: false,
        kind: "write_failed",
        message: `cannot write ${path}: ${(err as Error).message} (already-written files rolled back)`,
      };
    }
    written.push(path);
  }
  return { ok: true, editsApplied: edits.length, filesTouched: [...staged.keys()], appliedEdits };
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

function previewSearch(search: string): string {
  const oneLine = search.replace(/\n/g, "\\n");
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}
