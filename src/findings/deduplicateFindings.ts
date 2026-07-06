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
 * The clustering optimizes for ISSUE IDENTITY over line proximity. The first
 * demo run (TaskFlow PR #1) showed why: 27 findings covering 4 distinct issues
 * in one dense new file chained into a single giant cluster because
 * (a) line proximity gated candidates transitively (A near B, B near C ⇒ one
 * cluster even though A and C are unrelated), and (b) character-bigram
 * similarity over long claims about the same file is high even for different
 * root causes. Two safeguards fix that:
 *
 *  1. The pair score is a composite of ISSUE-IDENTITY signals — title/claim
 *     word overlap, shared code symbols (identifiers like `getUser` or
 *     `escapeCsvField`), and primary-span overlap — not raw text similarity.
 *     Nearby-but-different findings score low; same-issue findings phrased
 *     differently (helper duplication reported as "hand-rolled quote()" vs
 *     "bypasses escapeCsvField") score high via the shared symbols.
 *  2. Merging is COMPLETE-LINKAGE, not transitive union: two clusters merge
 *     only when EVERY cross pair is at least plausibly the same issue
 *     (≥ `minLinkScore`). A chain can therefore never absorb unrelated
 *     neighbours — the guardrail the over-merge demo failure asked for.
 *
 * An optional LLM adjudicator (injected, OFF by default) breaks ties in the
 * gray zone; its absence or failure simply means "don't merge" — the
 * deterministic result stands.
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

/* --------------------------- text tokenization ---------------------------- */

/**
 * Words that carry no issue-identity signal. Deliberately small and generic —
 * over-aggressive stopwording would erase real signal from terse titles.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "for", "to", "with", "by",
  "via", "into", "from", "as", "at", "is", "are", "be", "been", "was", "were",
  "it", "its", "this", "that", "these", "those", "their", "there", "which",
  "would", "should", "could", "can", "may", "might", "will", "must", "do",
  "does", "did", "not", "no", "than", "then", "when", "while", "where", "so",
  "such", "but", "if", "also", "any", "all", "per", "instead", "rather",
  "before", "after", "here", "only", "own", "same", "both", "each", "between",
  "code", "issue", "finding",
]);

/**
 * Strip a light plural/verb suffix so "scans"/"scanned"/"scanning" and "scan"
 * count as the same word. Deliberately crude (no dictionary): it only trims
 * when a plausible stem remains, so short words pass through untouched.
 */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** Lowercased, stopword-free, lightly-stemmed word multiset of `text`. */
function wordBag(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    const w = stem(raw);
    bag.set(w, (bag.get(w) ?? 0) + 1);
  }
  return bag;
}

/**
 * Down-weighting applied to the overlap coefficient before it can stand in for
 * Dice (see `bagSimilarity`). Containment is a weaker signal than balanced
 * overlap — a very short text trivially "contains" into anything — so it never
 * quite reaches parity with a same-length match.
 */
const OVERLAP_DISCOUNT = 0.85;

/**
 * Word-multiset similarity in `[0, 1]`; 0 when either side is empty.
 *
 * The base is Sørensen–Dice, but Dice punishes length imbalance: a terse
 * one-sentence Codex claim can never score high against a five-sentence Claude
 * claim about the same issue, because the long text's extra words dominate the
 * denominator. The demo runs showed exactly that failure (cross-vendor
 * duplicates of the same crash left unmerged). So the score is
 * `max(dice, OVERLAP_DISCOUNT × overlap-coefficient)` — the overlap coefficient
 * (intersection / smaller size) rewards the short text being *contained* in
 * the long one, discounted so containment alone can't beat a genuinely
 * balanced match.
 */
function bagSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let sizeA = 0;
  for (const n of a.values()) sizeA += n;
  let sizeB = 0;
  for (const n of b.values()) sizeB += n;
  if (sizeA === 0 || sizeB === 0) return 0;
  let intersection = 0;
  for (const [w, nb] of b) {
    const na = a.get(w);
    if (na !== undefined) intersection += Math.min(na, nb);
  }
  const dice = (2 * intersection) / (sizeA + sizeB);
  const overlap = intersection / Math.min(sizeA, sizeB);
  return Math.max(dice, OVERLAP_DISCOUNT * overlap);
}

/**
 * Code-symbol tokens in `text`: identifiers with camelCase / snake_case /
 * dotted / call syntax (`getUser`, `assignee_total_completed`, `csv.ts`,
 * `listTasks()`), plus anything backtick-quoted. These are the strongest
 * issue-identity anchors a finding carries — two findings that both talk about
 * `escapeCsvField` are about the same helper no matter how the prose differs.
 */
export function extractSymbols(text: string): Set<string> {
  const symbols = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const inner = m[1]!.trim().toLowerCase();
    if (inner.length >= 2 && inner.length <= 60) symbols.add(inner.replace(/\(\)$/, ""));
  }
  // Identifier-shaped words: contains an underscore, a dot between word chars,
  // an interior capital (camelCase), or a `()` call suffix.
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+|[a-z][A-Z][A-Za-z0-9]*)+\b(?:\(\))?|\b[A-Za-z][A-Za-z0-9_]*\(\)/g)) {
    const raw = m[0]!.replace(/\(\)$/, "").toLowerCase();
    if (raw.length >= 2) symbols.add(raw);
  }
  return symbols;
}

/** Jaccard similarity of two sets, in `[0, 1]`; 0 when either is empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of b) if (a.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/* --------------------------- pair scoring -------------------------------- */

/**
 * Weights of the composite same-issue score. Title similarity dominates — a
 * finding's title is its one-line statement of the root cause, so it is the
 * most discriminating text signal. Claims add context (and rescue terse
 * titles); shared code symbols are precise but sparse; span overlap is a weak
 * signal on its own (different issues legitimately share dense lines — the
 * demo's O(rows×tasks) scan and cross-project leak overlap almost exactly) so
 * it gets the smallest weight. Components that cannot be evaluated for a pair
 * (no line anchors / no symbols on one side) are dropped and the remaining
 * weights renormalized, rather than counted as dissimilarity.
 */
export const SAME_ISSUE_WEIGHTS = {
  title: 0.42,
  claim: 0.23,
  symbols: 0.2,
  span: 0.15,
} as const;

/**
 * A finding's precomputed similarity profile, so the O(n²) pair loop scores
 * against cached tokenizations instead of re-tokenizing on every comparison.
 */
interface IssueProfile {
  readonly titleBag: Map<string, number>;
  readonly claimBag: Map<string, number>;
  readonly symbols: Set<string>;
}

/**
 * Cap on the text fed to the tokenizers. Titles/claims are untrusted model
 * output; an adversarially long string would make the identifier regex in
 * `extractSymbols` backtrack quadratically, and past a few thousand characters
 * a claim adds no issue-identity signal anyway.
 */
const MAX_PROFILE_TEXT = 2_000;

function buildProfile(f: Finding): IssueProfile {
  const title = f.title.slice(0, MAX_PROFILE_TEXT);
  const titleClaim = `${f.title} ${f.claim}`.slice(0, MAX_PROFILE_TEXT * 2);
  return {
    titleBag: wordBag(title),
    claimBag: wordBag(titleClaim),
    symbols: extractSymbols(titleClaim),
  };
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
  // A file-level finding (no line anchor) doesn't gate on lines; let the
  // issue-identity signals decide.
  if (!hasLineAnchor(a) || !hasLineAnchor(b)) return true;
  const aEnd = Math.max(a.line_start, a.line_end);
  const bEnd = Math.max(b.line_start, b.line_end);
  if (a.line_start <= bEnd && b.line_start <= aEnd) return true; // overlap
  const gap = a.line_start > bEnd ? a.line_start - bEnd : b.line_start - aEnd;
  return gap <= proximity;
}

/** Jaccard overlap of two line ranges (0 for disjoint ranges). */
function spanOverlap(a: Finding, b: Finding): number {
  const aStart = Math.min(a.line_start, a.line_end);
  const aEnd = Math.max(a.line_start, a.line_end);
  const bStart = Math.min(b.line_start, b.line_end);
  const bEnd = Math.max(b.line_start, b.line_end);
  const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1;
  if (overlap <= 0) return 0;
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart) + 1;
  return overlap / union;
}

/**
 * Whether a pair is even eligible to merge: same file, and (for file-anchored
 * findings) within `proximityLines`. Null-file pairs have no line anchor, so
 * they rely on the text/symbol signals alone.
 */
function candidatePair(a: Finding, b: Finding, opts: DedupConfig): boolean {
  if (a.file !== b.file) return false; // never merge across files (§10.6)
  if (a.file !== null && !linesClose(a, b, opts.proximityLines)) return false;
  return true;
}

function scoreFromProfiles(
  a: Finding,
  b: Finding,
  pa: IssueProfile,
  pb: IssueProfile,
): number {
  const components: Array<[weight: number, value: number]> = [
    [SAME_ISSUE_WEIGHTS.title, bagSimilarity(pa.titleBag, pb.titleBag)],
    [SAME_ISSUE_WEIGHTS.claim, bagSimilarity(pa.claimBag, pb.claimBag)],
  ];
  // Symbols are only evidence when BOTH sides carry some — a terse finding
  // with no identifiers isn't "dissimilar", it's silent on this signal.
  if (pa.symbols.size > 0 && pb.symbols.size > 0) {
    components.push([SAME_ISSUE_WEIGHTS.symbols, jaccard(pa.symbols, pb.symbols)]);
  }
  // Span overlap only when both findings anchor to lines.
  if (hasLineAnchor(a) && hasLineAnchor(b)) {
    components.push([SAME_ISSUE_WEIGHTS.span, spanOverlap(a, b)]);
  }
  const totalWeight = components.reduce((sum, [w]) => sum + w, 0);
  const blend = components.reduce((sum, [w, v]) => sum + w * v, 0);
  return totalWeight > 0 ? blend / totalWeight : 0;
}

/**
 * Composite same-issue score for a *candidate* pair, in `[0, 1]`. Returns 0 for
 * pairs that are never candidates (different files, or same file but lines too
 * far apart). Exported for tests and threshold tuning.
 */
export function findingSimilarity(a: Finding, b: Finding, opts: DedupConfig): number {
  if (!candidatePair(a, b, opts)) return 0;
  return scoreFromProfiles(a, b, buildProfile(a), buildProfile(b));
}

/* ------------------------------ clustering -------------------------------- */

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

/** How the deterministic pass and the (optional) LLM pass each contributed. */
export interface DedupStats {
  /** Candidate pairs at/above `mergeThreshold` (before the linkage guardrail). */
  autoMergePairs: number;
  /** Merges the complete-linkage guardrail refused despite a qualifying score. */
  mergesBlockedByLinkage: number;
  /** Gray-zone pairs (candidate ≤ score < merge) present in the input. */
  grayPairs: number;
  /** Gray-zone pairs actually sent to the LLM adjudicator. */
  grayPairsAdjudicated: number;
  /** Gray-zone merges approved by the adjudicator and applied. */
  llmMerges: number;
  /** Adjudicator calls that threw (each treated as "don't merge"). */
  adjudicatorErrors: number;
  /** Whether an adjudicator was available for this run. */
  llmAvailable: boolean;
}

export interface ClusteringResult {
  groups: Finding[][];
  stats: DedupStats;
}

/**
 * Cluster findings into groups of the same underlying issue.
 *
 * Merging is greedy agglomerative in descending score order (deterministic:
 * ties break on finding ids). A pair at/above `mergeThreshold` merges its two
 * clusters only when the COMPLETE-LINKAGE guardrail holds: every cross pair of
 * the two clusters must itself score ≥ `minLinkScore`. That is what
 * prevents transitive proximity chains — with pure union-find, A~B and B~C
 * would pull unrelated A and C together; here the A–C pair must at least be
 * plausibly the same issue or the merge is refused.
 *
 * Pairs in the gray zone (`candidateThreshold ≤ score < mergeThreshold`) merge
 * only when `adjudicate` is provided, returns `true`, and the same linkage
 * guardrail holds. An adjudicator that throws is treated as "don't merge"
 * (fail-open) so a flaky model never aborts the run.
 */
export async function clusterFindings(
  findings: Finding[],
  opts: DedupConfig,
  adjudicate?: Adjudicator,
): Promise<ClusteringResult> {
  // Sort by id for deterministic pair ordering and stable cluster membership.
  const ordered = [...findings].sort((a, b) => a.id.localeCompare(b.id));
  const n = ordered.length;
  const dsu = new DisjointSet(n);
  const profiles = ordered.map(buildProfile);

  const stats: DedupStats = {
    autoMergePairs: 0,
    mergesBlockedByLinkage: 0,
    grayPairs: 0,
    grayPairsAdjudicated: 0,
    llmMerges: 0,
    adjudicatorErrors: 0,
    llmAvailable: adjudicate !== undefined,
  };

  // Score every candidate pair once (dense n×n upper triangle). The score
  // matrix also powers the complete-linkage check, so it must outlive the
  // merge loop.
  const score = new Float64Array(n * n);
  const at = (i: number, j: number): number => score[i * n + j]!;
  interface ScoredPair {
    i: number;
    j: number;
    s: number;
  }
  const autoPairs: ScoredPair[] = [];
  const grayPairs: ScoredPair[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = ordered[i]!;
      const b = ordered[j]!;
      if (!candidatePair(a, b, opts)) continue;
      const s = scoreFromProfiles(a, b, profiles[i]!, profiles[j]!);
      score[i * n + j] = s;
      score[j * n + i] = s;
      if (s >= opts.mergeThreshold) autoPairs.push({ i, j, s });
      else if (s >= opts.candidateThreshold) grayPairs.push({ i, j, s });
    }
  }
  stats.autoMergePairs = autoPairs.length;
  stats.grayPairs = grayPairs.length;

  // Current members per root — kept incrementally so the linkage check is
  // O(|Ci|·|Cj|) per attempted merge rather than a full rescan.
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) members.set(i, [i]);

  /** Complete-linkage guardrail: every cross pair must clear `minLinkScore`. */
  const clustersCompatible = (ra: number, rb: number): boolean => {
    for (const u of members.get(ra)!) {
      for (const v of members.get(rb)!) {
        if (at(u, v) < opts.minLinkScore) return false;
      }
    }
    return true;
  };

  const tryUnion = (i: number, j: number): boolean => {
    const ra = dsu.find(i);
    const rb = dsu.find(j);
    if (ra === rb) return false;
    if (!clustersCompatible(ra, rb)) {
      stats.mergesBlockedByLinkage++;
      return false;
    }
    dsu.union(ra, rb);
    const root = dsu.find(ra);
    const other = root === ra ? rb : ra;
    members.get(root)!.push(...members.get(other)!);
    members.delete(other);
    return true;
  };

  // Deterministic greedy order: strongest pairs first, ids break ties.
  const pairOrder = (x: ScoredPair, y: ScoredPair): number => {
    if (y.s !== x.s) return y.s - x.s;
    if (x.i !== y.i) return x.i - y.i;
    return x.j - y.j;
  };

  // Pass 1 — deterministic merges.
  autoPairs.sort(pairOrder);
  for (const { i, j } of autoPairs) tryUnion(i, j);

  // Pass 2 — resolve gray-zone pairs with the (optional) LLM adjudicator.
  // Skip pairs the deterministic pass already connected, run the rest with
  // bounded concurrency, then apply approved unions in sorted order so the
  // result never depends on which call finished first. A throwing adjudicator
  // is treated as "don't merge" (fail-open) so a flaky model can't abort a run.
  if (adjudicate && grayPairs.length > 0) {
    grayPairs.sort(pairOrder);
    const pending = grayPairs.filter(({ i, j }) => dsu.find(i) !== dsu.find(j));
    stats.grayPairsAdjudicated = pending.length;
    const verdicts = await mapWithConcurrency(
      pending,
      GRAY_ADJUDICATION_CONCURRENCY,
      async ({ i, j }) => {
        try {
          return await adjudicate(ordered[i]!, ordered[j]!);
        } catch {
          stats.adjudicatorErrors++;
          return false;
        }
      },
    );
    pending.forEach(({ i, j }, k) => {
      if (verdicts[k] && tryUnion(i, j)) stats.llmMerges++;
    });
  }

  const groups = new Map<number, Finding[]>();
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    const group = groups.get(root);
    if (group) group.push(ordered[i]!);
    else groups.set(root, [ordered[i]!]);
  }
  return { groups: [...groups.values()], stats };
}

/* ------------------------------- merging ---------------------------------- */

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
 * the max; evidence is the de-duplicated union ordered strongest-first (the
 * representative's evidence leads, then the remaining members in descending
 * severity/confidence order — so a capped display shows the best items);
 * `needs_code_change` is the OR.
 */
export function mergeCluster(members: Finding[]): Omit<FindingCluster, "cluster_id"> {
  const rep = representative(members);
  // Representative first, then the rest by the same strength order the
  // representative was chosen with — evidence and "first non-null" fields then
  // prefer the strongest members.
  const byStrength = [...members].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.id.localeCompare(b.id);
  });
  const ordered = [rep, ...byStrength.filter((m) => m !== rep)];

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

export interface DedupResult {
  clusters: FindingCluster[];
  stats: DedupStats;
}

/**
 * Deduplicate normalized findings into ordered clusters (Phase 7 entry point).
 * Clusters are sorted most-important-first (severity, then human-review
 * likelihood, then agreement, then file/line/id) and assigned stable
 * `cluster-001…` ids in that order, so identical input yields identical output.
 * The returned `stats` record how the deterministic and LLM passes contributed,
 * so the CLI can say whether LLM dedup ran or was skipped.
 */
export async function deduplicateFindings(
  findings: Finding[],
  opts: DedupConfig,
  adjudicate?: Adjudicator,
): Promise<DedupResult> {
  const { groups, stats } = await clusterFindings(findings, opts, adjudicate);
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

  return {
    clusters: merged.map((cluster, i) => ({
      cluster_id: `cluster-${String(i + 1).padStart(3, "0")}`,
      ...cluster,
    })),
    stats,
  };
}
