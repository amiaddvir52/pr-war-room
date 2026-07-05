import {
  AgentSpecSchema,
  PRESET_NAMES,
  reviewerNameKey,
  type AgentSpec,
  type PresetName,
} from "./schema.js";
import { ConfigError } from "../errors.js";
import { isPlainObject } from "../util/isPlainObject.js";
import { formatZodError } from "../util/formatZodError.js";

/**
 * Reviewer roster presets (PRD §10.4). A preset expands into a concrete
 * `agents.reviewers` roster inside `mergeConfig` BEFORE schema validation, on
 * the raw user JSON. Resolving pre-parse is what makes partial per-agent
 * overrides work: `{ "name": "claude_security_reviewer", "enabled": false }`
 * merges onto the preset entry field-by-field, whereas a post-parse merge
 * would already have rejected the entry (no `backend`) or defaulted its
 * `angle` to "general", clobbering the preset's value.
 *
 * Resolution cases (see mergeConfig):
 *   - neither `preset` nor `reviewers` set → the default roster (standard).
 *   - `preset` only → that preset's roster.
 *   - `reviewers` only → exact replacement roster (legacy behavior, unchanged);
 *     in a layered merge this also clears any `preset` label inherited from
 *     the base, so metadata never records a preset the roster didn't come from.
 *   - both → preset roster as base; each `reviewers` entry overrides the
 *     preset member with the same name (per `reviewerNameKey`, the same
 *     case-insensitive rule as the uniqueness check in AgentsConfigSchema) or
 *     appends as a new agent. Invalid entries fail HERE, with the entry's
 *     index in the user's own array — post-merge the schema would report
 *     roster indices that don't map back to the user's config.
 */

/**
 * The default roster: every PRD §10.4 review angle, one backend per angle.
 * Eight independent perspectives beat duplicating fewer angles across
 * backends (PRD §15.2); cross-backend duplication lives in `deep`. The Claude
 * agents work with just `claude login`; the Codex agent only runs when a
 * usable `codex` CLI is detected (otherwise it is reported as skipped, never
 * a silent omission — see backendAvailability.ts).
 */
export const STANDARD_ROSTER: readonly AgentSpec[] = [
  { name: "claude_general_reviewer", backend: "claude", angle: "general", enabled: true },
  { name: "codex_general_reviewer", backend: "codex", angle: "general", enabled: true },
  { name: "claude_test_gap_reviewer", backend: "claude", angle: "test-gap", enabled: true },
  { name: "claude_correctness_reviewer", backend: "claude", angle: "correctness", enabled: true },
  { name: "claude_repo_pattern_reviewer", backend: "claude", angle: "repo-pattern", enabled: true },
  { name: "claude_security_reviewer", backend: "claude", angle: "security", enabled: true },
  { name: "claude_performance_reviewer", backend: "claude", angle: "performance", enabled: true },
  {
    name: "claude_product_intent_reviewer",
    backend: "claude",
    angle: "product-intent",
    enabled: true,
  },
];

export const PRESET_ROSTERS: Record<PresetName, readonly AgentSpec[]> = {
  // Quick sanity pass: the two cross-vendor general reviewers plus the
  // highest-value focused angle.
  fast: [
    { name: "claude_general_reviewer", backend: "claude", angle: "general", enabled: true },
    { name: "codex_general_reviewer", backend: "codex", angle: "general", enabled: true },
    { name: "claude_correctness_reviewer", backend: "claude", angle: "correctness", enabled: true },
  ],
  standard: STANDARD_ROSTER,
  // Standard plus cross-backend duplication of the two angles where
  // independent agreement is the strongest ranking signal. The codex entries
  // are detection-gated like codex_general_reviewer.
  deep: [
    ...STANDARD_ROSTER,
    { name: "codex_correctness_reviewer", backend: "codex", angle: "correctness", enabled: true },
    { name: "codex_security_reviewer", backend: "codex", angle: "security", enabled: true },
  ],
  // Stage-run roster. Currently identical to `standard` (an alias, not a
  // copy — a copy in the same file just drifts in lockstep); fork it into a
  // pinned literal snapshot the first time `standard` evolves, so demos stay
  // stable across versions.
  demo: STANDARD_ROSTER,
};

function isPresetName(value: unknown): value is PresetName {
  return typeof value === "string" && (PRESET_NAMES as readonly string[]).includes(value);
}

/**
 * Clone a roster entry-by-entry so user configs can't mutate the shared
 * preset constants. AgentSpec is flat, so a shallow per-entry spread is a
 * full clone; revisit every caller if AgentSpec ever grows a nested field.
 */
export function cloneRoster(roster: readonly AgentSpec[]): AgentSpec[] {
  return roster.map((spec) => ({ ...spec }));
}

/**
 * Merge user `reviewers` entries onto a preset roster by agent name
 * (`reviewerNameKey`). A matching name overrides that preset member
 * field-by-field, keeping the member's canonical name casing (it is the
 * artifact filename stem and finding-id prefix); an unmatched name appends a
 * new agent and must be a full, enabled spec — a partial or disabled append
 * is almost always a typo'd override name, so both fail loudly with the
 * member list. Every entry is validated here against AgentSpecSchema so
 * errors carry the entry's index in the USER's array.
 */
function mergeRosterByName(
  preset: PresetName,
  base: readonly AgentSpec[],
  entries: readonly unknown[],
): Record<string, unknown>[] {
  const roster: Record<string, unknown>[] = cloneRoster(base);
  const memberNames = base.map((member) => member.name).join(", ");
  const seen = new Set<string>();

  entries.forEach((entry, i) => {
    const at = `agents.reviewers[${i}]`;
    if (!isPlainObject(entry) || typeof entry["name"] !== "string") {
      throw new ConfigError(
        `${at}: with \`preset\` set, each reviewers entry must be an object with a string ` +
          `\`name\` (a \`${preset}\` preset member to override, or a new agent to append)`,
      );
    }
    const name = entry["name"];
    const key = reviewerNameKey(name);
    if (seen.has(key)) {
      throw new ConfigError(
        `${at}: duplicate entry for reviewer "${name}" — names must be unique (compared case-insensitively)`,
      );
    }
    seen.add(key);

    const validateAs = (candidate: Record<string, unknown>): Record<string, unknown> => {
      const check = AgentSpecSchema.safeParse(candidate);
      if (!check.success) {
        throw new ConfigError(`${at} ("${name}"): ${formatZodError(check.error)}`);
      }
      // Keep the raw (pre-default) shape: the full config schema applies
      // defaults once, after the merge.
      return candidate;
    };

    const index = roster.findIndex(
      (member) => typeof member["name"] === "string" && reviewerNameKey(member["name"]) === key,
    );
    if (index >= 0) {
      const existing = roster[index]!;
      // `name` last: the preset member keeps its canonical casing even when
      // the override matched case-insensitively.
      roster[index] = validateAs({ ...existing, ...entry, name: existing["name"] });
      return;
    }

    if (typeof entry["backend"] !== "string" || typeof entry["angle"] !== "string") {
      throw new ConfigError(
        `${at} ("${name}") matches no \`${preset}\` preset member and is not a full spec — ` +
          `appending a new agent requires \`backend\` and \`angle\`; to override a preset ` +
          `member, use its exact name (one of: ${memberNames})`,
      );
    }
    if (entry["enabled"] === false) {
      throw new ConfigError(
        `${at} ("${name}") appends a new agent that is disabled — a no-op; to disable a ` +
          `\`${preset}\` preset member, use its exact name (one of: ${memberNames})`,
      );
    }
    roster.push(validateAs({ ...entry }));
  });
  return roster;
}

/**
 * Expand `agents.preset` in a raw (pre-validation) user config into a concrete
 * `agents.reviewers` roster. No-ops when there is no usable preset — including
 * an *invalid* preset value, which is deliberately left in place for the
 * schema's enum to reject loudly — and when `reviewers` is present but not an
 * array, which is likewise left untouched so the schema rejects the user's
 * actual value instead of this function silently replacing it with the preset
 * roster. Never mutates its input; preset entries are cloned so user configs
 * can't mutate the shared roster constants.
 */
export function resolvePresetRoster(override: unknown): unknown {
  if (!isPlainObject(override) || !isPlainObject(override["agents"])) return override;
  const agents = override["agents"];
  const preset = agents["preset"];
  if (!isPresetName(preset)) return override;
  const userReviewers = agents["reviewers"];
  if (userReviewers !== undefined && !Array.isArray(userReviewers)) return override;
  const base = PRESET_ROSTERS[preset];
  const reviewers = Array.isArray(userReviewers)
    ? mergeRosterByName(preset, base, userReviewers)
    : cloneRoster(base);
  return { ...override, agents: { ...agents, reviewers } };
}

/**
 * True when `override` writes `agents.reviewers` without an `agents.preset`
 * key of its own — the "replace the roster exactly" case. `mergeConfig` uses
 * this to drop a `preset` label inherited from its base: after the replace,
 * the roster no longer comes from that preset, and run metadata must not
 * record a preset the run never used (only reachable through layered use of
 * the exported `mergeConfig`; the CLI merges once over presetless defaults).
 */
export function replacesRosterWithoutPreset(override: unknown): boolean {
  if (!isPlainObject(override) || !isPlainObject(override["agents"])) return false;
  const agents = override["agents"];
  return Array.isArray(agents["reviewers"]) && !("preset" in agents);
}
