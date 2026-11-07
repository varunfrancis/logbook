# Logbook

A local logbook for everything your Claude Code agents are doing, with two views:

- **City**: a low-poly isometric world. Each project is a building. Live agents are little builders on scaffolding (hammering = editing, carrying = running commands, reading blueprints = reading/searching, waving with a red "!" = needs you, sipping coffee = idle). Finished projects get a roof, a PR flag, and stars if they just shipped. GitHub repos you've never worked on locally are "For sale" lots.
- **Dashboard**: Needs you / Active / Closed in the last 24h, plus a project table.

Everything stays on your machine. Nothing is sent anywhere except GitHub API calls made with your own `gh` login.

## Setup

```sh
npm install
node bin/logbook.ts install   # builds the UI, adds Claude Code hooks, runs the daemon at login
open http://localhost:7777
```

`node bin/logbook.ts uninstall` removes the hooks and the login item. Your data in `~/.logbook` stays.

## How it knows what's happening

| Source | What it gives |
|---|---|
| `~/.claude/projects/**/*.jsonl` transcripts | History, titles (`ai-title`), prompts, tokens, last action, final message, commits, PR links, lines changed. Backfills everything on first run. |
| `~/.claude/sessions/<pid>.json` registry | Which sessions are alive right now and whether they're busy or idle. Works even without hooks. |
| Claude Code hooks → `POST /hook` | Real-time actions, permission prompts ("needs you"), clean session end. |
| `gh` CLI tokens (every signed-in account) | All your repos, merged with local projects by `origin` remote, plus PR state for active branches. |

Worktrees (`.claude/worktrees/*`) collapse into their parent repo, so parallel agents on one repo share one building.

Building height grows with lifetime tokens (input + output + cache writes + subagents) on a log scale.

## Development

```sh
npm run dev        # daemon with --watch + Vite on http://localhost:5177
npm test           # node:test unit tests
npm run typecheck
```

Environment: `LOGBOOK_PORT` (default 7777), `LOGBOOK_DATA_DIR` (default `~/.logbook`), `LOGBOOK_NO_NOTIFY=1` to silence macOS notifications, `LOGBOOK_DISABLE=1` to make the hook a no-op.

Requires Node 24+ (uses built-in `node:sqlite` and TypeScript type stripping).
