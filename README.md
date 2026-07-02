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

This repo is being built in phases (see `Full PRD.rtf`). **Phases 1–5** are
implemented: the CLI skeleton, configuration system, PR-URL parsing, the
`.ai-review/` artifact layout, **GitHub PR ingestion** (metadata, changed files,
and diff), the **local workspace** (a shallow checkout of the PR head with
project-type / package-manager / verification-command detection and optional
verification runs), the **review packet** — a structured `review_packet.json`
+ `review_packet.md` combining PR intent, diffs, nearby code context, detected
repo conventions, and verification results — and the **single reviewer baseline**:
one AI reviewer runs against the packet and its findings are validated against a
strict schema and written as normalized findings. Multi-agent fan-out,
deduplication, the skeptic and judge steps, and report generation arrive next.

GitHub access uses `GITHUB_TOKEN` if set, otherwise `GH_TOKEN`, otherwise
`GITHUB_PERSONAL_ACCESS_TOKEN` (the same token the GitHub MCP server uses, so if
you've set up GitHub MCP on `claude`/`codex` ingestion works with no extra
setup), otherwise the `gh` CLI (`gh auth token`). If none is available the tool
prints a setup message and exits. Ingestion stays a deterministic REST fetch —
we reuse the MCP's credential rather than driving MCP tools through the CLI.

The reviewer backend is chosen by `models.primaryReviewer`:

- `"claude"` (default) shells out to the locally-installed **Claude Code CLI**
  (`claude -p`), reusing your existing `claude login` — no API key and no
  separate API billing. Install the CLI and log in once (`claude login`).
- `"claude-api"` uses the **Anthropic API** directly (`claude-opus-4-8`) and needs
  `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`). This path gets structured
  outputs (schema-guaranteed JSON); the CLI path validates prompt-guided JSON.
- `"mock"` produces deterministic placeholder findings with no external call —
  handy for CI or a demo without any credentials.

(`"codex"` and multi-reviewer fan-out arrive in Phase 6.)

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

# After build (or when installed globally):
pr-war-room review https://github.com/org/repo/pull/123

# Also run the detected/configured verification commands (install + test/lint/build):
pr-war-room review https://github.com/org/repo/pull/123 --verify
```

Every run writes artifacts under `.ai-review/` in the current directory:
`run_metadata.json`; `github/pr_metadata.json`, `github/changed_files.json`, and
`github/diff.patch` from the ingested PR; `workspace/repo/` (a shallow checkout of
the PR head), `workspace/workspace_metadata.json`, and
`verification/initial_verification.json`; the review packet at
`context/review_packet.json` + `context/review_packet.md`; and the reviewer output —
`raw/<agent>_review.md` (verbatim model output), `raw/<agent>_findings.json` (that agent's
validated findings), and `normalized/all_findings.json` (normalized findings, the input to
later phases).

Verification is **opt-in**: detection always runs, but commands only execute with
`--verify` (or `verification.enabled: true`). This matters because running a PR's
scripts executes its code locally. Add `.ai-review/` to your ignore rules.

`fix` and `eval` are registered but not yet implemented.

## Configuration

Config is optional. Defaults are used unless a `.pr-war-room.json` file exists in
the current directory, in which case it is deep-merged over the defaults
(objects merge; arrays replace).

```json
{
  "models": {
    "primaryReviewer": "claude",
    "secondaryReviewer": "codex",
    "judge": "claude"
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
  }
}
```

`context.maxPacketBytes` soft-caps the review packet (largest patches are trimmed
with a warning if exceeded); `context.nearbyContextLines` sets how much
surrounding code is included around each changed hunk;
`context.maxNearbyLinesPerFile` caps the total nearby-context lines per file
across all its hunks.

`verification.commands` is empty by default so detection picks the commands; set
it to override detection. `enabled` (or the `--verify` flag) turns execution on;
`installDeps` installs dependencies first; `timeoutMs` bounds each command.

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
