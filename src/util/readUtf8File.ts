import { readFile } from "node:fs/promises";

/**
 * Read a file as UTF-8, returning `null` when its bytes are not valid UTF-8
 * (a binary file or a legacy encoding such as Latin-1). Node's utf8 decoder
 * silently turns invalid sequences into U+FFFD, so a caller that decodes,
 * edits, and rewrites a whole file would corrupt every non-UTF-8 byte in it —
 * even far from the edit. The round-trip re-encode check catches that before
 * any rewrite. Propagates fs errors (missing file, permissions) unchanged.
 */
export async function readUtf8File(path: string): Promise<string | null> {
  const bytes = await readFile(path);
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}
