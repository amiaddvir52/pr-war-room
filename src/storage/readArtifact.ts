import { readFile } from "node:fs/promises";

/**
 * Reading counterpart to `writeArtifact.ts`. Distinguishes "the artifact does
 * not exist" (a normal, actionable state — e.g. `fix` before `review`) from
 * "the artifact exists but is corrupt", so callers can give each its own
 * user-facing message.
 */

export class ArtifactNotFoundError extends Error {
  constructor(path: string) {
    super(`artifact not found: ${path}`);
    this.name = "ArtifactNotFoundError";
  }
}

/** Read and JSON-parse an artifact. Missing file → `ArtifactNotFoundError`. */
export async function readJsonArtifact(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ArtifactNotFoundError(path);
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`artifact is not valid JSON: ${path}`);
  }
}
