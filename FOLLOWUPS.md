# Follow-up cleanup items

Non-blocking cleanup/reuse findings surfaced during the Phase 9/10 (judge +
report) code review, plus later follow-ups (item 5, from the reviewer-roster
expansion). The four **report-renderer correctness bugs** from that review are
already fixed and covered by regression tests; these are quality-only
follow-ups (no behavior bug) deferred to a later pass.

## 1. Extract the tolerant "parse last valid JSON object" loop (reuse) — PARTIALLY DONE

**Phase 11 extracted the shared util**: `parseLastValidObject(text, zodSchema)`
now lives in `src/util/parseLastValidObject.ts`, and `parseJudgeVerdict`
(`src/agents/JudgeAgent.ts`) and `parseFixProposal` (`src/agents/FixAgent.ts`)
delegate to it. Still pending: migrate `parseSkepticVerdict`
(`src/agents/SkepticAgent.ts`), `src/agents/DedupAdjudicator.ts`, and the
reviewer parser so a parsing fix is applied once everywhere.

## 2. Share the reviewer soft-failure plumbing (reuse)

`classifyFailure` in `src/agents/runJudge.ts` is identical to the one in
`src/agents/runSkeptic.ts` (and Phase 11 added a third sibling in
`src/fix/runFixes.ts`), and the `stopReason → failure-kind` block in
`JudgeAgent.ts` duplicates the one in `SkepticAgent.ts` (plus the stopReason
triple in `DedupAdjudicator.ts` and now `FixAgent.ts`). `JudgeError`,
`SkepticError`, and `FixAgentError` are all `ReviewerError`-with-`kind`
subclasses, so a single `classifyReviewerFailure(err)` and a
`stopReasonToFailureKind(stopReason)` (or `assertUsableCompletion(result)`)
could back all of them and stop the phases from classifying the same backend
failure under different kinds.

## 3. Single sort comparator for finding order (reuse)

`buildPool` (now in `src/report/reportModel.ts`, shared by the HTML and
Markdown renderers) re-implements the
`classification-priority → score desc → id` comparator that
`selectFinalFindings` in `src/findings/scoreFindings.ts` already uses (only the
field names differ). Extract one comparator keyed by `{classification, score,
id}` so the judge-enabled report (order baked in by `selectFinalFindings`) and
the judge-disabled report (re-sorted in `buildPool`) can never drift on a future
tiebreak change.

## 4. Make `narrowClassification`'s invariant explicit (simplification)

`narrowClassification` in `src/report/reportModel.ts` has an
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

## 7. Return a fresh config from `loadConfig`'s no-config-file path (hardening)

When no `.pr-war-room.json` exists, `loadConfig` returns the module-level
`defaultConfig` singleton by reference (`src/config/loadConfig.ts`), while the
file-present path re-parses through `ConfigSchema` and returns fresh objects.
No in-repo caller mutates the config and the CLI is one-shot, but both
`loadConfig` and `defaultConfig` are exported from `src/index.ts`, so a
long-lived programmatic consumer that mutates the returned config would
silently poison every later default load in the same process. Clone (or
schema-re-parse) on that path, or `Object.freeze` the exported default.

## 8. Consider `.strict()` for the remaining config sub-schemas (consistency)

`AgentSpecSchema`, `AgentsConfigSchema`, and the Phase-11 `FixConfigSchema` are
`.strict()`, so a typo'd key fails loudly. The other sub-schemas
(`verification`, `review`, `context`, `dedup`, `skeptic`, `judge`, `ci`) still
strip unknown keys silently — the same footgun at lower stakes (e.g.
`{"skeptic": {"concurency": 8}}` is a silent no-op). Sweep them in one pass,
minding the `.default({})` wrappers, rather than piecemeal.

## 9. Move the per-call timeout into ModelRequest (altitude)

The adaptive per-cluster budget (agents/clusterTimeout.ts) is threaded by
constructing a fresh skeptic/judge per cluster (`makeSkeptic(config, timeoutMs)`)
— construction is closure-only today, but timeout is really a per-REQUEST
concern. For the `claude-api` backend the client-level override is a silent
no-op (createAnthropicModelClient takes no timeout; only the orchestrator's
`withTimeout` wrapper enforces the budget there). A `timeoutMs` on
`ModelRequest`/`complete()` with one reused client would put the knob at the
right layer, make all backends behave identically, and delete the
construction-probe pattern duplicated across runSkeptic/runJudge.

## 10. Dedup's dense score matrix is O(n²) memory (efficiency, low priority)

`clusterFindings` backs the complete-linkage check with a dense
`Float64Array(n*n)`; candidate pairs are same-file-only so it is mostly zeros.
Irrelevant at realistic scale (200 findings ≈ 320 KB) but a sparse
`Map<i*n+j, score>` with a `?? 0` default would drop memory to
O(candidate pairs) if finding counts ever grow by orders of magnitude.
