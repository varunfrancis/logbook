<p align="center"><img src="site/brand/crew.svg" width="280" alt="Pip the foreman in a blue hard hat, with two crew members"></p>

# Swarmville

Everything your Claude Code agents are doing, told as a little town. (Formerly Logbook: the command, the `~/.logbook` folder and the repo keep that name.)

- **Town**: a low-poly isometric world. Each project is a building with a plain-English name ("Support Bot", "Sales Training"). Projects with crew on site rise up and glow; others are *under construction* (worked on in the last 7 days), *just completed* (7–30 days), *complete*, or *for sale* (on GitHub, never worked on here). Agents are characters on the scaffolding. A rain cloud means someone is stuck, a small fire means checks just failed, fireworks mean work went live. Scrapped work gets a tombstone in the graveyard. Agents on a coffee break leave their building for the café at the edge of town, where they sit at a table with a steaming mug until you're back (when the tables fill up, they queue at the counter). Similar projects share a neighborhood ("Money & Investing", "Learning & Practice"), sorted by the small Claude model and re-sorted when a new project shows up. Unrelated neighborhoods are a park apart. Drag to pan, scroll to zoom, right-drag or shift-drag (or Q / E, or the ⟲ ⟳ buttons) to turn the town all the way around. It settles on one of the four corner views, where the grid keeps its proportions. Clicking a building flies to it and centers it beside its panel.
- **Crew**: who raised a hand (and what they need), who's building, who's on a coffee break, and who clocked out today, stamped from git as *Shipped / Sent for review / Saved, not sent / Left unfinished / Scrapped / Just a chat*. Warnings when an agent is stuck on the same problem or two agents are changing the same file.
- **Day**: one lane per agent through the day, showing building, hands raised (waiting on you) and coffee breaks, with saves, checks and reviews marked.
- **Agent profiles**: what you asked for, how it went, what the agent said vs. what actually happened, and the shift in numbers.
- **Share**: "waited on you" card, daily receipt, graveyard, monthly Wrapped, a 20-second time-lapse video of the day, and a skyline image for your GitHub README. Repo names, branches, files and prompts never appear in anything you share.

Everything runs on your machine. Swarmville talks to GitHub with your own `gh` login, and asks the small Claude model (through your own Claude Code login) for one plain-English name per project.

## Crew

Every agent is a character with a stable look: one of 10 shapes, 12 colors and 6 personality accessories (bow tie, glasses, headphones, beanie, scarf, freckles). Their job follows the work: Builder (new features), Plumber (fixing bugs), Painter (how it looks), Librarian (docs), Inspector (checks), Scout (research). Faces show how they're doing: building, raised a hand, coffee break, stuck, shipped, clocked out. The town shows the exact same avatar artwork as the dashboard, standing in the 3D world and always facing you, on the side of the building you're looking at. An agent picking up the same worktree or branch later is the same character, with a career.

Effort is measured in **bricks** (1 brick ≈ 10,000 tokens). Costs are in the dashboard, the profiles and the receipt. Switch the header to **Technical** to see raw tokens, branches, paths and PR numbers.

## Install

Paste this into Claude Code (the Claude desktop app or the terminal):

> Install Swarmville for me: https://raw.githubusercontent.com/varunfrancis/logbook/main/INSTALL.md

Claude explains what it will do, asks before running anything, and opens your town. Or run it yourself in Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/varunfrancis/logbook/main/install.sh | bash
```

Mac only for now. No Node, Homebrew or password needed: the installer downloads a private copy of Node 24 into `~/.logbook/runtime` if you don't have one (checked against nodejs.org's checksums), puts Swarmville in `~/.logbook/app`, adds the Claude Code hooks (backing up `~/.claude/settings.json` first), starts it at login and opens http://localhost:7777. Running it again updates Swarmville and keeps your town. Afterwards: `~/.logbook/bin/logbook status | update | uninstall [--everything]`.

There are no API keys. Friendly names and agent intros use the small Claude model through your own Claude Code login (the `claude` command, or the Claude desktop app's built-in copy), and GitHub features use your own `gh` login.

### From source (developers)

```sh
npm install
node bin/logbook.ts install   # builds the UI, adds Claude Code hooks, runs Swarmville at login, installs the VS Code helper
```

Releases: bump `version` in `package.json`, merge, then tag `vX.Y.Z` and push the tag. `.github/workflows/release.yml` publishes `logbook.tar.gz`, which `install.sh` downloads. The landing page in `site/` deploys to GitHub Pages from `main`.

## First launch

Install opens your town in the browser. The first launch is a short welcome tour, about two minutes and skippable at every step:

1. **Setting up**: Swarmville reads the work you've already done with Claude Code and shows real counts as it goes. All your buildings get friendly names in one go.
2. **Name your town.**
3. **Pip, the foreman**, says hello. Pip is the guide and never works a shift.
4. **Roll call**: up to three agents (different projects first) introduce themselves: who they are, what they're on, one fact from their record. A plain line appears instantly; the small Claude model writes a livelier one in the background (one call for the roll call, cached per agent per day).
5. **Four signs**: raised hand, rain cloud, fireworks, coffee mug, each pointing at a real example in your town when there is one.
6. **Where to look**: Town, Crew, Day.
7. **Your turn**: pick a project and *Brainstorm with me*, *Plan with me* (opens Claude Code in plan mode, so nothing changes until you approve) or *Fix something*.
8. It opens in VS Code (or Terminal), with an option to have **agents say hi in the terminal** (off by default).
9. Your new agent **walks into town** and says hi.

After that, Pip explains the rest the first time it happens (first raised hand, rain cloud, fire, fireworks, tombstone, and bricks on the Day view). A skipped tour can be finished from the header for a week; Settings → *Replay the welcome* runs it again. Every agent's profile has **Work with {name}** with the same starting moves, led by what their job is good at.

New agents walk in from the street with a "Hi, I'm …" bubble whenever they start, and a note in the corner says who joined.

**Agents say hi in the terminal** (Settings, off by default): when a Claude Code session starts, the hook tells Claude its name and look in your town, so its first reply opens with "Hi, I'm Juno. You'll see me at Support Bot in Maple Harbor." The hook waits at most a second for this and only on session start.

- `node bin/logbook.ts vscode` reinstalls the VS Code helper. It lets **Go to {agent}** (or ↵ in the Crew view) open the exact terminal the agent runs in, and opens new jobs you start from Logbook. New VS Code windows pick it up; restart VS Code once for windows already open. Without it, Swarmville uses Terminal.
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
