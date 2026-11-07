# Logbook — how the owner reviews work

The owner looks at changes **only on http://localhost:7777, locally**. Not a Vite dev server, not another port, not a Vercel/preview deploy. Every session must leave its work visible there without being asked.

## Branch workflow (GitHub: varunfrancis/logbook)

`main` on GitHub is the source of truth. CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on every PR and every push to `main`.

- **Never edit files in the main checkout** `/Users/user/Work/logbook`. It only pulls `main` and serves it on 7777. Do all work in a worktree, on a branch named `feat/<short-topic>` (or `fix/<short-topic>`).
- Start from the latest main: `git fetch origin` then `git switch -c feat/<topic> origin/main`.
- One feature per branch: small PRs mean fewer conflicts.
- Never push directly to `main`; everything lands through a PR.

## Finishing any change (required, every time)

1. In your worktree: `npx tsc --noEmit` and `npm test`, then commit.
2. Catch up with main and resolve conflicts on your branch, keeping both features: `git fetch origin && git rebase origin/main` (re-run the checks if anything changed).
3. Push and open a PR: `git push -u origin HEAD`, then `gh pr create --fill --base main`.
4. Wait for CI: `gh pr checks --watch`. If it fails, fix on the branch and push again.
5. Merge once CI is green: `gh pr merge --squash --delete-branch`.
6. Make it live in the main checkout:
   - `cd /Users/user/Work/logbook && git pull --ff-only origin main`
   - `npm ci` if `package-lock.json` changed, then `npm run build` (writes `dist/`, which the daemon serves).
   - If anything under `daemon/` changed: `launchctl kickstart -k gui/$(id -u)/dev.logbook.daemon`
7. Confirm it's live: `curl -s localhost:7777 | grep -o 'index-[^"]*\.js'` matches the bundle `npm run build` just printed.

If `git pull --ff-only` refuses because the main checkout has local commits or edits, don't discard or force anything — tell the owner what's there.

## The 7777 daemon

- Runs under launchd as `dev.logbook.daemon` (`~/Library/LaunchAgents/dev.logbook.daemon.plist`): `node daemon/server.ts` from the main checkout, KeepAlive, logs in `~/.logbook/daemon.log`.
- Don't start a second copy with `npm start`/`npm run dev`; restart via `launchctl kickstart -k` instead. If it isn't loaded: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.logbook.daemon.plist`.
