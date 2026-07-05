import type { ZodError } from "zod";

/**
 * Render a ZodError as one `path: message` fragment per issue, joined with
 * "; ". Shared by config validation (config/loadConfig.ts) and preset roster
 * resolution (config/presets.ts) so user-facing config errors read the same
 * everywhere.
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
