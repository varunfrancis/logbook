# Working on Swarmville

Swarmville (formerly Logbook; the GitHub repo `varunfrancis/swarmville` was `logbook`, and old links redirect) is a local app: a Node daemon (`daemon/`, built-in modules only, Node 24+) that reads Claude Code's files and hooks, plus a React/three.js UI (`web/`) built into `web/dist`, which the daemon serves on http://localhost:7777. It's macOS-only for now.

## Branch workflow

`main` is the source of truth. CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every PR and every push to `main`.

- Work on a branch named `feat/<short-topic>` or `fix/<short-topic>`, started from the latest `origin/main`. A git worktree under `.claude/worktrees/` keeps it separate from other work.
- One feature per branch: small PRs mean fewer conflicts.
- Never push directly to `main`. Everything lands through a PR with green CI (squash-merge).

## Before you open a PR

1. `npx tsc --noEmit` and `npm test` pass.
2. `npm run build` works if you touched `web/`.
3. Rebase on `origin/main`, keep both sides of any conflict, and re-run the checks.
4. User-facing changes: try them in the real app, not just tests (`npm run dev`, or build and restart your daemon).

## Running it while developing

- `npm run dev`: daemon with `--watch` plus Vite on http://localhost:5177.
- To try the installer without touching your real setup: `SWARMVILLE_DATA_DIR=/tmp/lb SWARMVILLE_PORT=7792 SWARMVILLE_NO_LOGIN_ITEM=1 SWARMVILLE_NO_VSCODE=1 CLAUDE_CONFIG_DIR=/tmp/claude-test bash install.sh` (see the comment at the top of `install.sh`).
- Swarmville's own small-model runs happen in `<data dir>/namer` and are never shown as projects. Clean up any test data folders you create.

## Releasing

Bump `version` in `package.json` through a PR, then tag `vX.Y.Z` on `main` and push the tag. `.github/workflows/release.yml` publishes `swarmville.tar.gz`, which `install.sh` downloads.

Maintainers may keep personal steps (where they review, how they deploy) in a gitignored `CLAUDE.local.md`.
