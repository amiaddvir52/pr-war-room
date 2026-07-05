/**
 * True only for plain objects — not arrays, not `null`. The config layer's
 * shared shape guard: deep-merge recursion (config/loadConfig.ts) and preset
 * resolution (config/presets.ts) must classify the same override value the
 * same way, so both import this one predicate instead of keeping copies that
 * could drift.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
