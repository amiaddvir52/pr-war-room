# Follow-up cleanup items

Non-blocking cleanup/reuse findings surfaced during the Phase 9/10 (judge +
report) code review, plus later follow-ups (item 5, from the reviewer-roster
expansion). The four **report-renderer correctness bugs** from that review are
already fixed and covered by regression tests; these are quality-only
follow-ups (no behavior bug) deferred to a later pass.

## 1. Extract the tolerant "parse last valid JSON object" loop (reuse)

`parseJudgeVerdict` in `src/agents/JudgeAgent.ts` is a near-byte-for-byte copy
of `parseSkepticVerdict` in `src/agents/SkepticAgent.ts`; the same
extract → `JSON.parse` → `schema.safeParse` → keep-last-valid loop also lives in
`src/agents/DedupAdjudicator.ts`. That's a 4th copy. Extract a shared
`parseLastValidObject(text, zodSchema)` beside `src/util/extractJsonObjects.ts`
and have all three call it, so a parsing fix (e.g. accepting a top-level array,
or switching keep-last→keep-first) is applied once.

## 2. Share the reviewer soft-failure plumbing (reuse)

`classifyFailure` in `src/agents/runJudge.ts` is identical to the one in
`src/agents/runSkeptic.ts`, and the `stopReason → failure-kind` block in
`JudgeAgent.ts` duplicates the one in `SkepticAgent.ts` (and the stopReason
triple in `DedupAdjudicator.ts`). Both `JudgeError` and `SkepticError` are
`ReviewerError`-with-`kind` subclasses, so a single
`classifyReviewerFailure(err)` and a `stopReasonToFailureKind(stopReason)` (or
`assertUsableCompletion(result)`) could back all of them and stop the judge and
skeptic from classifying the same backend failure under different kinds.

## 3. Single sort comparator for finding order (reuse)

`buildPool` in `src/report/generateMarkdownReport.ts` re-implements the
`classification-priority → score desc → id` comparator that
`selectFinalFindings` in `src/findings/scoreFindings.ts` already uses (only the
field names differ). Extract one comparator keyed by `{classification, score,
id}` so the judge-enabled report (order baked in by `selectFinalFindings`) and
the judge-disabled report (re-sorted in `buildPool`) can never drift on a future
tiebreak change.

## 4. Make `narrowClassification`'s invariant explicit (simplification)

`narrowClassification` in `src/report/generateMarkdownReport.ts` has an
unreachable runtime branch (`drop → nice_to_have`): both callers feed it values
that are provably never `"drop"` (`selectFinalFindings` excludes drops;
`deterministicClassification` never returns drop). Replace the silent
reclassification with a typed exhaustive assertion so a real `"drop"` reaching
here would fail loudly instead of being masked; only the type-level `Exclude`
narrow is actually needed.

## 5. Revisit skeptic/judge concurrency for the 10-agent default roster (tuning)

The default roster grew from 4 to 10 reviewers (`standard` preset, now
including cross-vendor codex correctness/security duplicates), so dedupe
now feeds more clusters into the per-cluster skeptic and judge phases, which
still run at `concurrency: 4` (deliberately unchanged — don't pre-optimize).
If a real run measures slow in those phases, bump `skeptic.concurrency` /
`judge.concurrency` defaults (6–8); the calls are short (60 s timeout) and
I/O-bound, so the raise is low-risk.

## 6. Trim redundant work in the judge/report path (simplification + efficiency)

- `reconcileJudge`'s failure branch in `src/agents/runJudge.ts` returns
  `model_verdict: modelVerdict`, which is always `null` on that path (every
  caller pairs a non-null failure with a null verdict). Prefer `model_verdict:
  null` locally so a reader need not trace both call sites to confirm it.
- `skepticById` / `clusterById` lookup Maps are rebuilt for the same arrays at
  several stages (`runJudge`, `selectFinalFindings`, `buildPool`,
  `collectDropped`). Low impact at current sizes, but a single shared index
  passed down would remove the repeated construction.

## 7. Consider `.strict()` for the remaining config sub-schemas (consistency)

`AgentSpecSchema` and `AgentsConfigSchema` are now `.strict()`, so a typo'd
`preset` key or per-agent field key fails loudly. The other sub-schemas
(`verification`, `review`, `context`, `dedup`, `skeptic`, `judge`, `ci`) still
strip unknown keys silently — the same footgun at lower stakes (e.g.
`{"skeptic": {"concurency": 8}}` is a silent no-op). Sweep them in one pass,
minding the `.default({})` wrappers, rather than piecemeal.
