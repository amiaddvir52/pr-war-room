import type { Finding, FindingCategory, FindingCluster } from "./schema.js";
import { SEVERITY_RANK } from "./validateFinding.js";
import type { DedupConfig } from "../config/schema.js";
import { mapWithConcurrency } from "../util/mapWithConcurrency.js";

/**
 * Max gray-zone adjudicator calls in flight at once. The LLM path is off by
 * default; when enabled we bound concurrency (rather than serialize or flood)
 * to keep latency down without hammering the backend. Output stays deterministic
 * because unions are applied in sorted pair order after all verdicts resolve.
 */
const GRAY_ADJUDICATION_CONCURRENCY = 4;

/**
 * Deduplication & clustering (PRD §10.6 / Phase 7). The independent reviewers
 * frequently report the same underlying issue in different words, so this step
 * merges overlapping findings from `normalized/all_findings.json` into
 * `deduped/finding_clusters.json`. Every finding lands in exactly one cluster —
 * singletons included — giving the skeptic (Phase 8) and judge (Phase 9) a
 * single uniform unit to work on.
 *
 * The core is deterministic heuristics (pure, dependency-free, unit-testable):
 * same file + line proximity gate the candidates, string similarity scores them,
 * and union-find clusters them (so A~B and B~C put A, B, C together). An optional
 * LLM adjudicator (injected, OFF by default) breaks ties in the gray zone; its
 * absence or failure simply means "don't merge" — the heuristic result stands.
 */

/** Deterministic tie-break when two findings are otherwise equal representatives. */
const CATEGORY_PRIORITY: Record<FindingCategory, number> = {
  correctness: 7,
  security: 6,
  performance: 5,
  tests: 4,
  product: 3,
  maintainability: 2,
  style: 1,
  other: 0,
};

/** Decide whether a gray-zone pair is the same underlying issue. */
export type Adjudicator = (a: Finding, b: Finding) => Promise<boolean>;

/**
 * A finding's normalized signature plus its precomputed bigram multiset, so the
 * O(n²) pair loop scores each finding against the same cached profile instead of
 * re-normalizing and re-building the bigram map on every comparison.
 */
interface SignatureProfile {
  /** Lower-cased, whitespace-collapsed `title claim`. */
  readonly norm: string;
  /** Bigram → occurrence count over `norm`. */
  readonly bigrams: ReadonlyMap<string, number>;
  /** Number of bigrams (`max(0, norm.length - 1)`), the Dice denominator term. */
  readonly size: number;
}

function buildProfile(raw: string): SignatureProfile {
  const norm = normalizeText(raw);
  const bigrams = new Map<string, number>();
  for (let i = 0; i < norm.length - 1; i++) {
    const bg = norm.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  return { norm, bigrams, size: Math.max(0, norm.length - 1) };
}

/**
 * Sørensen–Dice coefficient over two precomputed bigram profiles, in `[0, 1]`.
 * Symmetric; identical (non-trivial) strings → 1; disjoint → 0. Strings shorter
 * than two characters have no bigrams and are treated as incomparable (→ 0) even
 * when identical, so the length guard and the equality shortcut agree.
 */
function diceFromProfiles(x: SignatureProfile, y: SignatureProfile): number {
  if (x.size < 1 || y.size < 1) return 0; // fewer than 2 chars → no bigrams
  if (x.norm === y.norm) return 1;
  let intersection = 0;
  for (const [bg, cy] of y.bigrams) {
    const cx = x.bigrams.get(bg);
    if (cx !== undefined) intersection += Math.min(cx, cy);
  }
  return (2 * intersection) / (x.size + y.size);
}

/**
 * Sørensen–Dice coefficient over character bigrams, in `[0, 1]`. Symmetric;
 * identical (non-trivial) strings → 1; disjoint → 0. Case- and whitespace-
 * insensitive. Dependency-free so it stays trivially testable.
 */
export function textSimilarity(a: string, b: string): number {
  return diceFromProfiles(buildProfile(a), buildProfile(b));
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Combined title+claim text used for similarity scoring. */
function signature(f: Finding): string {
  return `${f.title} ${f.claim}`;
}

/**
 * Whether a finding carries a real line anchor. The `0/0` sentinel (and any
 * non-positive bound) means "file-level, no specific line", so such findings do
 * not gate on proximity and must not drag a merged cluster's range to line 0.
 */
function hasLineAnchor(f: Finding): boolean {
  return f.line_start > 0 || f.line_end > 0;
}

/** Do two `[start, end]` line ranges overlap or sit within `proximity` lines? */
function linesClose(a: Finding, b: Finding, proximity: number): boolean {
  // A file-level finding (no line anchor) doesn't gate on lines; let text
  // similarity decide.
  if (!hasLineAnchor(a) || !hasLineAnchor(b)) return true;
  const aEnd = Math.max(a.line_start, a.line_end);
  const bEnd = Math.max(b.line_start, b.line_end);
  if (a.line_start <= bEnd && b.line_start <= aEnd) return true; // overlap
  const gap = a.line_start > bEnd ? a.line_start - bEnd : b.line_start - aEnd;
  return gap <= proximity;
}

/**
 * Whether a pair is even eligible to merge: same file, and (for file-anchored
 * findings) within `proximityLines`. Null-file pairs have no line anchor, so
 * they rely on text similarity alone.
 */
function candidatePair(a: Finding, b: Finding, opts: DedupConfig): boolean {
  if (a.file !== b.file) return false; // never merge across files (§10.6)
  if (a.file !== null && !linesClose(a, b, opts.proximityLines)) return false;
  return true;
}

/**
 * Similarity score for a *candidate* pair, in `[0, 1]`. Returns 0 for pairs that
 * are never candidates (different non-null files, or same file but lines too far
 * apart). The score itself is the title+claim text similarity.
 */
export function findingSimilarity(a: Finding, b: Finding, opts: DedupConfig): number {
  return candidatePair(a, b, opts) ? textSimilarity(signature(a), signature(b)) : 0;
}

/** Minimal union-find (disjoint set) over array indices. */
class DisjointSet {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[i] !== root) {
      const next = this.parent[i]!;
      this.parent[i] = root;
      i = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/**
 * Cluster findings into groups of the same underlying issue. Pairs are visited
 * in stable id order. A pair merges when its score ≥ `mergeThreshold`; a pair in
 * the gray zone (`candidateThreshold ≤ score < mergeThreshold`) merges only when
 * `adjudicate` is provided and returns `true`. An adjudicator that throws is
 * treated as "don't merge" (fail-open) so a flaky model never aborts the run.
 */
export async function clusterFindings(
  findings: Finding[],
  opts: DedupConfig,
  adjudicate?: Adjudicator,
): Promise<Finding[][]> {
  // Sort by id for deterministic pair ordering and stable cluster membership.
  const ordered = [...findings].sort((a, b) => a.id.localeCompare(b.id));
  const dsu = new DisjointSet(ordered.length);
  // Precompute each finding's signature profile once (O(n)), not per pair.
  const profiles = ordered.map((f) => buildProfile(signature(f)));

  // Pass 1 — deterministic heuristics. Score every candidate pair against the
  // cached profiles; auto-merge at/above `mergeThreshold`, and set aside
  // gray-zone pairs for the adjudicator (only when one is provided).
  const grayPairs: Array<[number, number]> = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      // Already in the same cluster (via an earlier merge) → union is a no-op
      // and any adjudicator call would be wasted; skip it.
      if (dsu.find(i) === dsu.find(j)) continue;
      const a = ordered[i]!;
      const b = ordered[j]!;
      const score = candidatePair(a, b, opts) ? diceFromProfiles(profiles[i]!, profiles[j]!) : 0;
      if (score >= opts.mergeThreshold) {
        dsu.union(i, j);
      } else if (adjudicate && score >= opts.candidateThreshold) {
        grayPairs.push([i, j]);
      }
    }
  }

  // Pass 2 — resolve gray-zone pairs with the (optional) LLM adjudicator.
  // Skip any pair the heuristic merges already connected, run the rest with
  // bounded concurrency, then union the approved pairs in sorted order so the
  // result never depends on which call finished first. A throwing adjudicator
  // is treated as "don't merge" (fail-open) so a flaky model can't abort a run.
  if (adjudicate && grayPairs.length > 0) {
    const pending = grayPairs.filter(([i, j]) => dsu.find(i) !== dsu.find(j));
    const verdicts = await mapWithConcurrency(
      pending,
      GRAY_ADJUDICATION_CONCURRENCY,
      async ([i, j]) => {
        try {
          return await adjudicate(ordered[i]!, ordered[j]!);
        } catch {
          return false;
        }
      },
    );
    pending.forEach(([i, j], k) => {
      if (verdicts[k]) dsu.union(i, j);
    });
  }

  const groups = new Map<number, Finding[]>();
  for (let i = 0; i < ordered.length; i++) {
    const root = dsu.find(i);
    const group = groups.get(root);
    if (group) group.push(ordered[i]!);
    else groups.set(root, [ordered[i]!]);
  }
  return [...groups.values()];
}

/** Pick the representative finding a cluster inherits its title/claim from. */
function representative(members: Finding[]): Finding {
  return [...members].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.human_review_likelihood !== a.human_review_likelihood) {
      return b.human_review_likelihood - a.human_review_likelihood;
    }
    const byCategory = CATEGORY_PRIORITY[b.category] - CATEGORY_PRIORITY[a.category];
    if (byCategory !== 0) return byCategory;
    return a.id.localeCompare(b.id);
  })[0]!;
}

/** First non-null value across members, representative first. */
function firstNonNull(members: Finding[], pick: (f: Finding) => string | null): string | null {
  for (const m of members) {
    const value = pick(m);
    if (value !== null && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Merge a group of findings into one cluster (without the `cluster_id`, which is
 * assigned later once clusters are ordered). Severity/confidence/likelihood take
 * the max; evidence is the de-duplicated union; `needs_code_change` is the OR.
 */
export function mergeCluster(members: Finding[]): Omit<FindingCluster, "cluster_id"> {
  const rep = representative(members);
  // Representative first, then the rest — so "first non-null" prefers the rep.
  const ordered = [rep, ...members.filter((m) => m !== rep)];

  const sourceAgents = [...new Set(members.map((m) => m.source_agent))].sort();

  const seen = new Set<string>();
  const evidence: string[] = [];
  for (const m of ordered) {
    for (const e of m.evidence) {
      const t = e.trim();
      if (t.length > 0 && !seen.has(t)) {
        seen.add(t);
        evidence.push(e);
      }
    }
  }

  // Build the merged line range from the members that actually carry a line
  // anchor, ignoring the 0/0 file-level sentinel (and any non-positive bound).
  // Otherwise mixing a file-level member with a line-anchored one would pull
  // `line_start` down to 0, producing a bogus range like 0–50. A cluster with
  // no anchored member at all stays file-level (0/0).
  const anchored = members.filter(hasLineAnchor);
  const lineStarts = anchored.map((m) => m.line_start).filter((n) => n > 0);
  const lineEnds = anchored.map((m) => m.line_end).filter((n) => n > 0);

  return {
    merged_title: rep.title,
    source_finding_ids: members.map((m) => m.id).sort(),
    source_agents: sourceAgents,
    agreement: sourceAgents.length,
    category: rep.category,
    // `rep` is the highest-severity member (see `representative`'s ordering),
    // so its severity is already the cluster max (§10.6).
    severity: rep.severity,
    confidence: Math.max(...members.map((m) => m.confidence)),
    human_review_likelihood: Math.max(...members.map((m) => m.human_review_likelihood)),
    file: rep.file,
    line_start: lineStarts.length > 0 ? Math.min(...lineStarts) : 0,
    line_end: lineEnds.length > 0 ? Math.max(...lineEnds) : 0,
    claim: rep.claim,
    evidence: evidence.length > 0 ? evidence : rep.evidence,
    suggested_fix: firstNonNull(ordered, (m) => m.suggested_fix),
    suggested_test: firstNonNull(ordered, (m) => m.suggested_test),
    needs_code_change: members.some((m) => m.needs_code_change),
  };
}

/**
 * Deduplicate normalized findings into ordered clusters (Phase 7 entry point).
 * Clusters are sorted most-important-first (severity, then human-review
 * likelihood, then agreement, then file/line/id) and assigned stable
 * `cluster-001…` ids in that order, so identical input yields identical output.
 */
export async function deduplicateFindings(
  findings: Finding[],
  opts: DedupConfig,
  adjudicate?: Adjudicator,
): Promise<FindingCluster[]> {
  const groups = await clusterFindings(findings, opts, adjudicate);
  const merged = groups.map(mergeCluster);

  merged.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    if (b.human_review_likelihood !== a.human_review_likelihood) {
      return b.human_review_likelihood - a.human_review_likelihood;
    }
    if (b.agreement !== a.agreement) return b.agreement - a.agreement;
    const byFile = (a.file ?? "").localeCompare(b.file ?? "");
    if (byFile !== 0) return byFile;
    if (a.line_start !== b.line_start) return a.line_start - b.line_start;
    return a.source_finding_ids[0]!.localeCompare(b.source_finding_ids[0]!);
  });

  return merged.map((cluster, i) => ({
    cluster_id: `cluster-${String(i + 1).padStart(3, "0")}`,
    ...cluster,
  }));
}
