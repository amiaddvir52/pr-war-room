import { z } from "zod";
import type { ParsedPr } from "./parsePrUrl.js";

/**
 * GitHub ingestion schemas — two layers, mirroring the config-schema pattern
 * (`config/schema.ts`):
 *
 *   • LENIENT INPUT schemas parse the raw GitHub REST payloads. They declare
 *     only the fields we read, `.passthrough()` GitHub's many extra fields, and
 *     tolerate the nulls that appear in the wild (deleted forks, ghost users,
 *     empty bodies). A parse failure here is the user-facing "malformed
 *     response" case.
 *   • STRICT OUTPUT schemas describe the curated artifacts we persist. They are
 *     the stable contract every later phase (review packet, agents) reads, so
 *     they don't break when GitHub reshapes its payloads.
 */

/* ------------------------------- input ---------------------------------- */

const RepoRefSchema = z.object({ full_name: z.string() }).passthrough();

const BranchRefSchema = z
  .object({ ref: z.string(), repo: RepoRefSchema.nullable() })
  .passthrough();

export const GitHubPullResponseSchema = z
  .object({
    title: z.string(),
    body: z.string().nullable(),
    state: z.string(),
    draft: z.boolean().optional(),
    merged: z.boolean().optional(),
    user: z.object({ login: z.string() }).passthrough().nullable(),
    base: BranchRefSchema,
    head: BranchRefSchema,
    additions: z.number(),
    deletions: z.number(),
    changed_files: z.number(),
    commits: z.number(),
    html_url: z.string(),
  })
  .passthrough();

export const GitHubFileSchema = z
  .object({
    filename: z.string(),
    status: z.string(),
    additions: z.number(),
    deletions: z.number(),
    changes: z.number(),
    previous_filename: z.string().optional(),
    patch: z.string().optional(),
  })
  .passthrough();

export const GitHubFilesResponseSchema = z.array(GitHubFileSchema);

export type GitHubPullResponse = z.infer<typeof GitHubPullResponseSchema>;
export type GitHubFile = z.infer<typeof GitHubFileSchema>;

/* ------------------------------- output --------------------------------- */

export const PR_STATES = ["open", "closed", "merged"] as const;
export type PrState = (typeof PR_STATES)[number];

export const FILE_STATUSES = [
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const PrMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.string(),
    repo: z.string(),
    number: z.number().int().positive(),
    title: z.string(),
    description: z.string(),
    author: z.string(),
    state: z.enum(PR_STATES),
    draft: z.boolean(),
    baseBranch: z.string(),
    headBranch: z.string(),
    baseRepo: z.string().nullable(),
    headRepo: z.string().nullable(),
    counts: z.object({
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      changedFiles: z.number().int().nonnegative(),
      commits: z.number().int().nonnegative(),
    }),
    htmlUrl: z.string(),
    fetchedAt: z.string(),
  })
  .strict();

export const ChangedFileSchema = z
  .object({
    filename: z.string(),
    status: z.enum(FILE_STATUSES),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    previousFilename: z.string().optional(),
    patch: z.string().optional(),
    // GitHub omits `patch` for binary files AND for very large text files; the
    // files API has no binary flag, so we record the factual signal instead.
    patchOmitted: z.boolean(),
  })
  .strict();

export const ChangedFilesArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    files: z.array(ChangedFileSchema),
  })
  .strict();

export type PrMetadata = z.infer<typeof PrMetadataSchema>;
export type ChangedFile = z.infer<typeof ChangedFileSchema>;
export type ChangedFilesArtifact = z.infer<typeof ChangedFilesArtifactSchema>;

/* ------------------------------- mappers -------------------------------- */

function normalizeFileStatus(status: string): FileStatus {
  return (FILE_STATUSES as readonly string[]).includes(status)
    ? (status as FileStatus)
    : "changed";
}

/** Map a raw GitHub PR payload + parsed URL into the persisted metadata shape. */
export function toPrMetadata(
  raw: GitHubPullResponse,
  pr: ParsedPr,
  fetchedAt: string = new Date().toISOString(),
): PrMetadata {
  const state: PrState =
    raw.merged === true ? "merged" : raw.state === "closed" ? "closed" : "open";

  return {
    schemaVersion: 1,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    title: raw.title,
    description: raw.body ?? "",
    author: raw.user?.login ?? "unknown",
    state,
    draft: raw.draft ?? false,
    baseBranch: raw.base.ref,
    headBranch: raw.head.ref,
    baseRepo: raw.base.repo?.full_name ?? null,
    headRepo: raw.head.repo?.full_name ?? null,
    counts: {
      additions: raw.additions,
      deletions: raw.deletions,
      changedFiles: raw.changed_files,
      commits: raw.commits,
    },
    htmlUrl: raw.html_url,
    fetchedAt,
  };
}

/** Map a raw GitHub changed-file entry into the persisted shape. */
export function toChangedFile(raw: GitHubFile): ChangedFile {
  // Build optional keys conditionally — exactOptionalPropertyTypes forbids
  // assigning `undefined` to `patch?` / `previousFilename?`.
  return {
    filename: raw.filename,
    status: normalizeFileStatus(raw.status),
    additions: raw.additions,
    deletions: raw.deletions,
    changes: raw.changes,
    patchOmitted: raw.patch === undefined,
    ...(raw.previous_filename !== undefined
      ? { previousFilename: raw.previous_filename }
      : {}),
    ...(raw.patch !== undefined ? { patch: raw.patch } : {}),
  };
}
