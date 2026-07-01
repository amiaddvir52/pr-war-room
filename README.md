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

This repo is being built in phases (see `Full PRD.rtf`). **Phases 1–3** are
implemented: the CLI skeleton, configuration system, PR-URL parsing, the
`.ai-review/` artifact layout, **GitHub PR ingestion** (metadata, changed files,
and diff), and the **local workspace** — a shallow checkout of the PR head, with
project-type / package-manager / verification-command detection and optional
verification runs. The AI review agents arrive in later phases.

GitHub access uses `GITHUB_TOKEN` if set, otherwise `GH_TOKEN`, otherwise the
`gh` CLI (`gh auth token`). If none is available the tool prints a setup
message and exits.

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
`verification/initial_verification.json`.

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
  }
}
```

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
