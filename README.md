# PR War Room

Multi-agent AI **pre-review** orchestrator for GitHub pull requests.

Run it on a PR *before* you request human review. It ingests the PR, builds a
review context packet, runs multiple independent AI review agents, deduplicates
and challenges their findings, ranks what a human reviewer would actually care
about, and produces a short, actionable report — with optional local fix
patches.

> Goal: not to replace human review, but to make every PR significantly more
> review-ready before a teammate ever looks at it.

## Status

The PRD (`Full PRD.rtf`) plans 15 phases. **Phases 1–11 are implemented** and
covered by the test suite. Phases 12–15 (eval mode, team reviewer profile,
GitHub publish, GitHub Action) are **not built yet** — see
[Not yet implemented & the proof gap](#not-yet-implemented--the-proof-gap).

A `review` run executes this pipeline, writing each stage's artifacts under
`.ai-review/`:

1. **Ingest** (Phase 2) — fetch the PR's metadata, changed files, and diff
   from the GitHub REST API.
2. **Workspace** (Phase 3) — shallow-clone the PR head into
   `.ai-review/workspace/repo`; detect project type, package manager, and
   verification commands; optionally run them (`--verify`).
3. **Review packet** (Phase 4) — assemble a structured `review_packet.json` +
   `review_packet.md`: PR intent, diffs, nearby code context, detected repo
   conventions, and verification results.
4. **Reviewer fan-out** (Phases 5–6) — run several independent review agents
   in parallel against the packet, each a **backend × angle** persona;
   validate each agent's output and merge it into one normalized findings set.
5. **Dedup** (Phase 7) — cluster overlapping findings from different agents
   into one issue each (singletons included), so later stages see each
   underlying issue once.
6. **Skeptic** (Phase 8) — challenge every cluster with deterministic
   file/line/diff checks and (unless disabled) an LLM skeptic that tries to
   disprove it; unsupported findings are dropped, recall-first.
7. **Judge** (Phase 9) — classify each supported cluster (`blocker`,
   `should_fix_before_review`, `nice_to_have`, or `drop`) and compute a
   deterministic priority score, producing `judge/ranked_findings.json` (the
   full record, drops included with reasons) and `final_findings.json` (the
   report-ready subset).
8. **Report** (Phase 10) — render `report.md`: findings grouped
   must-fix / should-fix / optional with their evidence and suggested fixes, a
   readiness verdict, the review funnel (raw → clustered → skeptic → ranked,
   with the dropped count), verification results, and links to the raw
   artifacts. Honours `review.maxFindings` / `review.includeNiceToHave` and
   degrades cleanly when the skeptic or judge is disabled.

On top of that sits **fix mode** (Phase 11, `pr-war-room fix <pr-url>`): it
selects the review's fixable findings, has a fix agent propose exact
search/replace edits per finding, applies them to the workspace checkout, and
produces `.ai-review/patch.diff` via `git diff` — a patch that is valid by
construction. It **never touches your working tree, never commits, never
pushes, and never posts to GitHub**. Details under [Fix mode](#fix-mode).

Every stage degrades cleanly: a reviewer that fails or times out is recorded
and the run continues; a skeptic or judge call that can't complete keeps the
finding rather than silently dropping it.

### GitHub auth

GitHub access uses `GITHUB_TOKEN` if set, otherwise `GH_TOKEN`, otherwise
`GITHUB_PERSONAL_ACCESS_TOKEN` (the same token the GitHub MCP server uses, so if
you've set up GitHub MCP on `claude`/`codex` ingestion works with no extra
setup), otherwise the `gh` CLI (`gh auth token`). If none is available the tool
prints a setup message and exits. Ingestion stays a deterministic REST fetch —
we reuse the MCP's credential rather than driving MCP tools through the CLI.

### Reviewers: backends × angles

The reviewer roster is a list of agents under `agents.reviewers`, run in
parallel. Each agent is a **backend × angle**: the `backend` picks the model
client, the `angle` picks the review persona. If one agent fails, times out, or
returns nothing, the run continues and records it. Every **configured** agent —
including ones that never ran — appears in the terminal board and in
`.ai-review/raw/agent_runs.json` with a status: `ok` / `no_findings` (usable),
`unusable_output` / `failed` / `timeout` (ran, but produced nothing usable), or
`skipped` (never ran — disabled by config, or its backend was detected
unavailable). A `skipped` agent is a visible, benign skip, never silently
omitted and never a hard failure.

Backends:

- `"claude"` (the default roster's backend) shells out to the locally-installed
  **Claude Code CLI** (`claude -p`), reusing your existing `claude login` — no
  API key and no separate API billing. Install the CLI and log in once.
- `"claude-api"` uses the **Anthropic API** directly (`claude-opus-4-8`) and needs
  `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`). This path gets structured
  outputs (schema-guaranteed JSON); the CLI paths validate prompt-guided JSON.
- `"codex"` shells out to the **OpenAI Codex CLI** (`codex exec`), reusing your
  `codex login`, for genuine cross-vendor independence. It **is in the default
  roster** but is **detection-gated**: the tool probes for the `codex` CLI first
  and, if it isn't installed, records that agent as `skipped: codex CLI not found
  on PATH` (visible, not omitted) while the Claude-backed reviewers still run. If
  the CLI is present but auth/exec fails at run time, it's recorded as `failed`
  and the run still continues. Install and `codex login` to activate it.
- `"mock"` produces deterministic placeholder findings with no external call —
  handy for CI or a demo without any credentials.

Angles: `general` (broad review), `test-gap`, `correctness`, `security`,
`performance`, `repo-pattern` (divergence from the repo's own conventions), and
`product-intent` (does the change do what the PR says it does). The default
roster is the **`standard` preset**, ten agents covering all seven angles:
seven Claude-backed reviewers (`general`, `test-gap`, `correctness`,
`repo-pattern`, `security`, `performance`, `product-intent`) plus **three
Codex reviewers** (`general`, `correctness`, `security` — all detection-gated,
above), so the highest-value angles get cross-vendor agreement by default. Set
`agents.preset` to pick a different roster: `"fast"` (3 agents — the two
cross-vendor generals + correctness), `"standard"` (the 10-agent default),
`"deep"` (currently identical to `standard`, which absorbed its cross-vendor
duplicates; kept for compatibility and will grow again when more angles merit
duplication), or `"demo"` (a pinned snapshot of the previous 8-agent roster,
frozen so stage runs keep the roster they were rehearsed with).
`judge.backend` selects the model the Phase-9 ranker runs on (see the `judge`
config below).

## Requirements

- Node.js **>= 22**
- [pnpm](https://pnpm.io) (v10+)

## Install & build

```bash
pnpm install
pnpm build      # bundles to dist/ via tsup
```

## Usage

```bash
# During development (runs TypeScript directly via tsx):
pnpm dev review https://github.com/org/repo/pull/123

# After `pnpm build` the bin is dist/cli/index.js; `pnpm link --global` puts
# `pr-war-room` on your PATH:
pr-war-room review https://github.com/org/repo/pull/123

# Also run the detected/configured verification commands (install + test/lint/build):
pr-war-room review https://github.com/org/repo/pull/123 --verify

# After a review: generate a local fix patch for the fixable findings.
pr-war-room fix https://github.com/org/repo/pull/123

# Keep the fixes applied in the workspace checkout, and verify the patched code:
pr-war-room fix https://github.com/org/repo/pull/123 --apply --verify
```

Global flags: `-q`/`--quiet` suppresses non-error output; `--no-color` disables
colored output.

Every `review` run writes artifacts under `.ai-review/` in the current directory:

```text
.ai-review/
├── run_metadata.json               # the review run's record
├── github/
│   ├── pr_metadata.json            # ingested PR metadata
│   ├── changed_files.json
│   └── diff.patch
├── workspace/
│   ├── repo/                       # shallow checkout of the PR head
│   └── workspace_metadata.json     # detected project type / package manager / commands
├── verification/
│   ├── initial_verification.json   # command results (commands execute only with --verify)
│   └── logs/
├── context/
│   ├── review_packet.json          # the structured review packet
│   └── review_packet.md
├── raw/
│   ├── <agent>_review.md           # verbatim model output, per agent
│   ├── <agent>_findings.json       # that agent's validated findings, per agent
│   └── agent_runs.json             # which agents ran, failed, timed out, or were skipped
├── normalized/
│   └── all_findings.json           # every agent's findings, merged and normalized
├── deduped/
│   └── finding_clusters.json       # one cluster per underlying issue
├── skeptic/
│   └── skeptic_results.json        # each cluster's evidence-validation verdict
├── judge/
│   └── ranked_findings.json        # every cluster's classification + score, drops included
├── final_findings.json             # report-ready non-dropped subset, most-important-first
└── report.md                       # the concise, human-facing Markdown report
```

A `fix` run adds (never overwriting the review's `run_metadata.json`):

```text
.ai-review/
├── patch.diff                      # unified diff of all applied fixes
├── fix_report.md                   # what was fixed, what wasn't and why
├── fix_results.json                # machine-readable per-finding outcomes
├── fix_verification.json           # post-fix verification results
├── fix_metadata.json               # the fix run's own record
└── verification/fix-logs/          # post-fix verification logs
```

Verification is **opt-in**: detection always runs, but commands only execute with
`--verify` (or `verification.enabled: true`). This matters because running a PR's
scripts executes its code locally. Add `.ai-review/` to your ignore rules.

### Fix mode

`pr-war-room fix <pr-url>` reads the latest review run's `final_findings.json`
(so run `review` first, with the judge enabled) and attempts the findings that
need a code change and were ranked `blocker` or `should_fix_before_review` —
highest priority first, capped by `fix.maxFindings`. Instead of asking the model
for a diff (LLM-emitted diffs are brittle), the fix agent returns **exact
search/replace edits**; the tool applies them to the workspace checkout at
`.ai-review/workspace/repo` — pinned to the reviewed commit when possible — and
generates `patch.diff` with `git diff`, so the patch always applies cleanly. A
finding whose fix fails (model refusal, timeout, or edits that don't match the
file) is recorded in the report and skipped; it never aborts the run. Edits are
restricted to files the PR changed.

By default the workspace is reverted after the patch is written (**patch-only**);
`--apply` leaves the workspace checkout patched instead. Either way, take the
changes into your own tree with `git apply .ai-review/patch.diff` — the tool
**never touches your working tree, never commits, never pushes, and never
publishes comments**. `--verify` (or `verification.enabled: true`) re-runs the
detected/configured verification commands against the patched checkout and
records the outcome in `fix_verification.json`; with `fix.backend: "mock"` the
whole flow runs offline with a deterministic placeholder fixer.

## Not yet implemented & the proof gap

PRD phases 12–15 are future work. None of them run today:

- **Eval mode (Phase 12).** `pr-war-room eval --repo <path> --prs <n>` is
  registered but is a stub — it prints "not yet implemented" and exits.
  The `.ai-review/eval/` artifact paths are reserved; nothing writes them.
- **Team reviewer profile (Phase 13).** Not implemented. Only the
  `team_profile.md` / `team_profile.json` artifact paths are reserved.
- **GitHub publish mode (Phase 14).** Not implemented. The tool never posts
  review comments — or anything else — to GitHub; all output is local files.
- **GitHub Action / CI integration (Phase 15).** Not implemented; there is no
  action or workflow to install. The `ci` config keys (`ci.failOnBlocker`,
  `ci.publishSummary`) are accepted but **inert**, pre-declared so configs
  that set them keep working when Phase 15 lands.

**The proof gap:** the pipeline runs end-to-end, but the product's core claim
— that its findings match what a human reviewer would actually flag — has not
been measured. Measuring it is exactly what eval mode is for (replay
historical PRs and compare AI findings against the human review comments);
until it exists, judge the output by reading `report.md` on your own PRs.

## Configuration

Config is optional. Defaults are used unless a `.pr-war-room.json` file exists in
the current directory, in which case it is deep-merged over the defaults
(objects merge; arrays replace).

```json
{
  "agents": {
    "preset": "standard",
    "reviewers": [
      { "name": "claude_performance_reviewer", "enabled": false },
      { "name": "my_extra_reviewer", "backend": "codex", "angle": "security" }
    ],
    "concurrency": 4,
    "timeoutMs": 300000,
    "minUsableReviewers": 1
  },
  "verification": {
    "commands": [],
    "enabled": false,
    "installDeps": true,
    "timeoutMs": 600000
  },
  "review": {
    "maxFindings": 20,
    "includeNiceToHave": false
  },
  "context": {
    "maxPacketBytes": 524288,
    "nearbyContextLines": 20,
    "maxNearbyLinesPerFile": 400
  },
  "dedup": {
    "proximityLines": 10,
    "mergeThreshold": 0.6,
    "candidateThreshold": 0.4,
    "llm": { "enabled": false, "backend": "claude", "timeoutMs": 60000 }
  },
  "skeptic": {
    "enabled": true,
    "backend": "claude",
    "concurrency": 4,
    "timeoutMs": 60000
  },
  "judge": {
    "enabled": true,
    "backend": "claude",
    "concurrency": 4,
    "timeoutMs": 60000
  },
  "fix": {
    "backend": "claude",
    "timeoutMs": 120000,
    "maxFindings": 5
  }
}
```

The reviewer roster resolves from `agents.preset` and `agents.reviewers` in four
deterministic cases:

- **neither set** → the default `standard` roster (ten agents, all seven angles).
- **`preset` only** → that preset's roster.
- **`reviewers` only** → the array **replaces** the default roster exactly, as
  it always has — provide the full list you want (unchanged legacy behavior).
- **both** → the preset roster is the base and each `reviewers` entry merges
  **by name** (case-insensitively; the preset member keeps its canonical name
  casing, since the name is its artifact-filename stem): an entry naming a
  preset member overrides just the fields it sets (so
  `{ "name": "...", "enabled": false }` disables one agent without re-listing
  the rest), and an entry with a new name is **appended** and must be a full spec
  (`name` + `backend` + `angle` — enforced). Misspellings fail loudly, with
  the entry's own array index and the preset's member names: a partial entry
  matching no member, an appended entry that is disabled (always a typo'd
  disable — appending a disabled agent is a no-op), an unknown field key like
  `"enable"`, and a name listed twice are all rejected. The one silent case
  left is a misspelled name on an *enabled full spec* — that's a legitimate
  append, so check the summary board if you see one agent too many.

Each entry needs a filesystem-safe `name` (used for its `raw/<name>_*` artifacts
and finding ids, so names must be unique — compared case-insensitively), a
`backend`, and an `angle`; `enabled` and a per-agent `timeoutMs` override are
optional. `agents.concurrency` caps how many run at once (default `4` — the
10-agent standard roster runs in three waves; raise to `10` for a single wave
if your machine and rate limits absorb all 10 CLI subprocesses at once — 7
`claude`, plus 3 `codex` when Codex is installed) and `agents.timeoutMs` is the default per-agent timeout. To **force-enable / force-disable** a reviewer, set
`"enabled": true`/`false` on its entry — the default Codex reviewers are
enabled but only *run* when the `codex` CLI is detected, so setting
`"enabled": false` on each is how you turn Codex off explicitly; a disabled
agent is reported as `skipped: disabled by config`, not hidden. The ten-agent
default costs roughly 2.5× the model calls of the old four-agent roster;
`{"agents": {"preset": "fast"}}` is the one-line opt-down.

`agents.minUsableReviewers` (default `1`) is the success threshold: the review
succeeds only if at least this many reviewers that **ran** return **usable**
output (findings, or a valid empty result). A reviewer that refuses, times out,
or emits unparseable output is *not* usable; a `skipped` reviewer didn't run and
so doesn't count toward the threshold. A run where fewer than the threshold
produce usable output exits non-zero rather than reporting a misleading clean
review.

Stale `models.*` keys are rejected with an error pointing to their new home, so
an upgraded config fails loudly instead of silently switching backends:
`models.primaryReviewer` / `models.secondaryReviewer` moved to `agents.reviewers`
(Phase 6), and `models.judge` moved to `judge.backend` (Phase 9).

`review.maxFindings` caps how many findings `report.md` displays;
`review.includeNiceToHave` (default `false`) controls whether `nice_to_have`
findings appear in the report.

`context.maxPacketBytes` soft-caps the review packet (largest patches are trimmed
with a warning if exceeded); `context.nearbyContextLines` sets how much
surrounding code is included around each changed hunk;
`context.maxNearbyLinesPerFile` caps the total nearby-context lines per file
across all its hunks.

`verification.commands` is empty by default so detection picks the commands; set
it to override detection. `enabled` (or the `--verify` flag) turns execution on;
`installDeps` installs dependencies first; `timeoutMs` bounds each command.

`dedup` (Phase 7) controls how overlapping findings are clustered. The core is
deterministic and always on: two findings are merge candidates only when they
touch the **same file** within `proximityLines` lines, and their title+claim
text similarity decides the rest — `mergeThreshold` auto-merges, anything below
`candidateThreshold` is left separate. Similarity in the gray zone between the
two is decided by an optional LLM adjudicator, which is **off by default**
(`dedup.llm.enabled: false`) so runs stay deterministic and make no extra model
calls; enabling it reuses the same `backend` clients as the reviewers.

`skeptic` (Phase 8) controls evidence validation. It is **on by default**
(`skeptic.enabled: true`, `backend: "claude"`), the product's precision gate.
Deterministic checks always run and are split by consequence: only an
**objective hard failure** — the referenced file is not in the PR's changeset at
all — may drop a finding without the model. Weak anchoring (a line outside the
diff and its nearby-context window, or a partial/inverted line range) is a
**soft warning** that downgrades and annotates, never drops; the "near the diff"
window follows `context.nearbyContextLines` so it matches the code the reviewer
was shown. The LLM skeptic then tries to disprove each cluster; set
`backend: "mock"` to validate deterministically with no model call (offline).
The drop policy is **recall-first**: the model's raw verdict is kept separate
from the final decision, and the model can only drop a finding it rules
`unsupported` + `high`-risk — any other "drop" is softened to a kept "downgrade".
If the skeptic can't run (timeout / refusal / parse failure / construction
failure / unexpected error), the finding is kept and the failure is recorded —
never silently swallowed, and never aborts the run. `concurrency` bounds
parallel calls; `timeoutMs` bounds each.

`judge` (Phase 9) controls the LLM-as-a-judge ranker. It is **on by default**
(`judge.enabled: true`, `backend: "claude"`) and runs on every skeptic-supported
cluster, classifying each as `blocker`, `should_fix_before_review`,
`nice_to_have`, or `drop`. The skeptic already decided whether a finding is
*real*; the judge decides whether a human reviewer would *care*, so it may drop
low-value/stylistic findings — but the **ordering score is computed
deterministically** (from severity, skeptic support, independent-reviewer
agreement, confidence, and human-review likelihood), not taken from the model, so
the ranking is reproducible; the model's advisory self-score is kept in
`ranked_findings.json` for the audit trail. Dropping is **recall-guarded**: a
model `drop` on a well-supported, high-severity (or independently-reported)
finding is softened to a kept `nice_to_have`. Set `backend: "mock"` to rank
deterministically with no model call (offline / CI / demo); if the judge can't
run for a cluster it is classified deterministically and kept, never dropped.
`ranked_findings.json` holds every cluster (drops included, with reasons);
`final_findings.json` holds the non-dropped subset, most-important-first.

`fix` (Phase 11) controls fix mode. There is deliberately **no `enabled` key** —
running `pr-war-room fix` is explicit intent. `backend` picks the model the fix
agent runs on (same choices as the reviewers; `"mock"` is a deterministic
offline fixer); `timeoutMs` bounds each per-finding call (higher than the
skeptic/judge defaults — generating a patch reads a whole file); `maxFindings`
caps how many findings are attempted per run, taken from the top of the
already-priority-sorted `final_findings.json`. One model call is made per
finding, sequentially, so each fix sees the previous fixes' edits.

## Development

```bash
pnpm typecheck   # tsc --noEmit (strict)
pnpm test        # vitest
pnpm test:watch
```

### Note on imports (NodeNext ESM)

This project uses `"module": "NodeNext"`. Relative imports in source **must**
include the `.js` extension, even though the source files are `.ts`:

```ts
import { parsePrUrl } from "./parsePrUrl.js"; // correct
```
