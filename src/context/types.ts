/**
 * Public type surface for repo-context detection (Phase 3). Import from here so
 * callers don't reach into the detection module internals.
 */
export type { ProjectType, PackageManager } from "./detectProjectType.js";
export type { DetectedCommands, DetectVerificationInput } from "./detectVerificationCommands.js";
export type {
  ReviewPacket,
  PacketPr,
  PacketRepository,
  PacketChangedFile,
  PacketVerification,
  PacketVerificationCommand,
  RepoConventions,
} from "./schema.js";
export type {
  BuildReviewPacketInput,
  BuildReviewPacketResult,
} from "./buildReviewPacket.js";
