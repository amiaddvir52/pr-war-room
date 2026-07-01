import type { PackageManager, ProjectType } from "./detectProjectType.js";

/**
 * The review packet (Phase 4) — the single structured context object handed to
 * review agents in later phases. Plain typed interfaces (data we produce), with
 * a stable `schemaVersion`. Persisted as `.ai-review/context/review_packet.json`
 * and rendered to `review_packet.md`.
 */

export interface PacketPr {
  owner: string;
  repo: string;
  number: number;
  title: string;
  description: string;
  author: string;
  state: string;
  draft: boolean;
  baseBranch: string;
  headBranch: string;
  htmlUrl: string;
}

export interface PacketRepository {
  projectTypes: ProjectType[];
  packageManager: PackageManager | null;
  detectedCommands: string[];
  headSha: string;
}

/** One executed verification command, condensed for the packet. */
export interface PacketVerificationCommand {
  command: string;
  exitCode: number | null;
  passed: boolean;
  /** True when the command was killed for exceeding its timeout. */
  timedOut: boolean;
  /** Set when the command could not be spawned at all; null otherwise. */
  spawnError: string | null;
  /** Redacted head+tail preview of stdout (evidence for reviewers); "" when none. */
  stdoutPreview: string;
  /** Redacted head+tail preview of stderr (evidence for reviewers); "" when none. */
  stderrPreview: string;
}

export interface PacketVerification {
  enabled: boolean;
  ran: boolean;
  allPassed: boolean;
  install: PacketVerificationCommand | null;
  commands: PacketVerificationCommand[];
}

export interface PacketChangedFile {
  path: string;
  status: string;
  /** Prior path when the file was renamed/copied; null otherwise. */
  previousPath: string | null;
  additions: number;
  deletions: number;
  /** True when GitHub omitted the patch (binary/too large) or we trimmed it for size. */
  patchOmitted: boolean;
  patch: string | null;
  /** Line-numbered code around the changed hunks, read from the checkout; null when unavailable. */
  nearbyContext: string | null;
}

export interface RepoConventions {
  readmeSummary: string | null;
  testConventions: string | null;
  errorHandlingPatterns: string | null;
  apiPatterns: string | null;
}

export interface ReviewPacket {
  schemaVersion: 1;
  pr: PacketPr;
  repository: PacketRepository;
  verification: PacketVerification;
  changedFiles: PacketChangedFile[];
  repoConventions: RepoConventions;
  /** Size accounting so consumers know if the packet was trimmed. */
  limits: {
    maxPacketBytes: number;
    approxBytes: number;
    truncated: boolean;
    trimmedFiles: number;
  };
  generatedAt: string;
}
