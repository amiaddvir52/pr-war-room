import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Internal filesystem probes shared by the Phase-3 detection heuristics. */

/** True if `path` exists (any type). */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True if any of `names` exists directly under `dir`. */
export async function anyExists(dir: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    if (await exists(join(dir, name))) return true;
  }
  return false;
}

/** Read a file as UTF-8, or return null if it is missing/unreadable. */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
