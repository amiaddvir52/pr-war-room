import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultConfig } from "./defaultConfig.js";
import { replacesRosterWithoutPreset, resolvePresetRoster } from "./presets.js";
import { ConfigSchema, type Config } from "./schema.js";
import { ConfigError } from "../errors.js";
import { isPlainObject } from "../util/isPlainObject.js";
import { formatZodError } from "../util/formatZodError.js";

export const CONFIG_FILENAME = ".pr-war-room.json";

export interface LoadedConfig {
  config: Config;
  source: "default" | "file";
  path: string | null;
}

/**
 * Deep-merge `override` onto `base`. Plain objects merge recursively; arrays and
 * primitives replace (so `verification.commands` is fully overridden, not
 * concatenated). Neither input is mutated.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: unknown,
): Record<string, unknown> {
  if (!isPlainObject(override)) {
    // A non-object override is meaningless here; keep base and let schema
    // validation report the real problem.
    return { ...base };
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      result[key] = deepMerge(baseValue, overrideValue);
    } else {
      result[key] = overrideValue;
    }
  }
  return result;
}

/**
 * Pure merge + validation. `agents.preset` (if any) is first expanded into a
 * concrete `agents.reviewers` roster on the raw override (see presets.ts),
 * then `override` is deep-merged onto `base` and the result is validated
 * against the config schema. Throws `ConfigError` on any violation.
 */
export function mergeConfig(base: Config, override: unknown): Config {
  const merged = deepMerge(
    base as unknown as Record<string, unknown>,
    resolvePresetRoster(override),
  );
  // Layering: an override that replaces the roster without naming a preset
  // makes a `preset` label inherited from `base` stale — drop it so the
  // parsed config only records a preset its roster actually came from. (The
  // CLI merges once over the presetless defaults; this protects layered use
  // of the exported API.)
  if (replacesRosterWithoutPreset(override) && isPlainObject(merged["agents"])) {
    delete merged["agents"]["preset"];
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid configuration: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Load configuration from `<cwd>/.pr-war-room.json` if present, merged over the
 * defaults. Missing file → defaults. Unreadable/invalid file → `ConfigError`.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<LoadedConfig> {
  const path = resolve(cwd, CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: defaultConfig, source: "default", path: null };
    }
    throw new ConfigError(`Cannot read ${CONFIG_FILENAME}: ${(err as Error).message}`);
  }

  let userConfig: unknown;
  try {
    userConfig = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${CONFIG_FILENAME} (${path}) is not valid JSON`);
  }

  return { config: mergeConfig(defaultConfig, userConfig), source: "file", path };
}
