# Logbook

A local logbook for everything your Claude Code agents are doing, told as a little town.

- **Town**: a low-poly isometric world. Each project is a building with a plain-English name ("Support Bot", "Sales Training"). Projects with crew on site rise up and glow; others are *under construction* (worked on in the last 7 days), *just completed* (7–30 days), *complete*, or *for sale* (on GitHub, never worked on here). Agents are characters on the scaffolding. A rain cloud means someone is stuck, a small fire means checks just failed, fireworks mean work went live. Scrapped work gets a tombstone in the graveyard. Similar projects share a neighborhood ("Money & Investing", "Learning & Practice"), sorted by the small Claude model and re-sorted when a new project shows up. Unrelated neighborhoods are a park apart. Drag to pan, scroll to zoom, right-drag or shift-drag (or Q / E, or the ⟲ ⟳ buttons) to turn the town all the way around. Clicking a building flies to it and centers it beside its panel.
- **Crew**: who raised a hand (and what they need), who's building, who's on a coffee break, and who clocked out today, stamped from git as *Shipped / Sent for review / Saved, not sent / Left unfinished / Scrapped / Just a chat*. Warnings when an agent is stuck on the same problem or two agents are changing the same file.
- **Day**: one lane per agent through the day, showing building, hands raised (waiting on you) and coffee breaks, with saves, checks and reviews marked.
- **Agent profiles**: what you asked for, how it went, what the agent said vs. what actually happened, and the shift in numbers.
- **Share**: "waited on you" card, daily receipt, graveyard, monthly Wrapped, a 20-second time-lapse video of the day, and a skyline image for your GitHub README. Repo names, branches, files and prompts never appear in anything you share.

Everything runs on your machine. Logbook talks to GitHub with your own `gh` login, and asks the small Claude model (through your own Claude Code login) for one plain-English name per project.

## Crew

Every agent is a character with a stable look: one of 10 shapes, 12 colors and 6 personality accessories (bow tie, glasses, headphones, beanie, scarf, freckles). Their job follows the work: Builder (new features), Plumber (fixing bugs), Painter (how it looks), Librarian (docs), Inspector (checks), Scout (research). Faces show how they're doing: building, raised a hand, coffee break, stuck, shipped, clocked out. The same character appears as a 2D avatar in the dashboard and as a 3D figure in the town. An agent picking up the same worktree or branch later is the same character, with a career.

Effort is measured in **bricks** (1 brick ≈ 10,000 tokens). Costs are in the dashboard, the profiles and the receipt. Switch the header to **Technical** to see raw tokens, branches, paths and PR numbers.

## Setup

```sh
npm install
node bin/logbook.ts install   # builds the UI, adds Claude Code hooks, runs Logbook at login, installs the VS Code helper
open http://localhost:7777
```

First launch asks you to name your town.

- `node bin/logbook.ts vscode` reinstalls the VS Code helper. It lets **Go to {agent}** (or ↵ in the Crew view) open the exact terminal the agent runs in. Reload open VS Code windows after installing.
- Settings → *Skyline for your GitHub profile*: point it at a local clone of your profile README repo. **README skyline** in the Town view then saves `logbook-skyline.png` there, commits and pushes.
- `node bin/logbook.ts uninstall` removes the hooks, the login item and the VS Code helper. Your data in `~/.logbook` stays.

## How it knows what's happening

| Source | What it gives |
|---|---|
| `~/.claude/projects/**/*.jsonl` transcripts | History, titles, prompts, tokens, actions, files changed, checks (test runs) and their results, repeated errors, questions asked, final message, saves, PR links, lines changed. Backfills everything on first run. |
| `~/.claude/sessions/<pid>.json` registry | Which agents are alive right now, and busy or idle. Works even without hooks. |
| Claude Code hooks → `POST /hook` | Real-time actions, permission prompts (raised hands, and how long you kept them waiting), clean session end. |
| `git` in each worktree | Outcome stamps: merged, open PR, committed but not pushed, uncommitted changes, nothing kept. |
| `gh` CLI tokens (every signed-in account) | All your repos, merged with local projects by `origin` remote, plus PR state. |

An idle agent stops counting as "crew on site" after 2 hours without activity (`AWAY_AFTER_MS` in `daemon/config.ts`).

## Development

```sh
npm run dev        # daemon with --watch + Vite on http://localhost:5177
npm test           # node:test unit tests
npm run typecheck
```

Environment: `LOGBOOK_PORT` (default 7777), `LOGBOOK_DATA_DIR` (default `~/.logbook`), `LOGBOOK_NO_NOTIFY=1` silences macOS notifications, `LOGBOOK_NO_NAMING=1` skips the Claude naming calls, `LOGBOOK_DISABLE=1` makes the hook a no-op.

Requires Node 24+ (built-in `node:sqlite` and TypeScript type stripping).
