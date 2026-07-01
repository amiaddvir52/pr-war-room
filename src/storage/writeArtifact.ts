import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Write text to `path`, creating parent directories as needed. */
export async function writeTextArtifact(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

/** Write pretty-printed JSON (with trailing newline) to `path`. */
export async function writeJsonArtifact(path: string, data: unknown): Promise<void> {
  await writeTextArtifact(path, `${JSON.stringify(data, null, 2)}\n`);
}
