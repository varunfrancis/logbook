# Logbook — how the owner reviews work

The owner looks at changes **only on http://localhost:7777, locally**. Not a Vite dev server, not another port, not a Vercel/preview deploy, not a side branch. Every session must leave its work visible there without being asked.

## Finishing any change (required, every time)

1. Commit your work (on a worktree branch is fine as scratch space).
2. Merge it into `main` in the main checkout `/Users/user/Work/logbook`. Nothing may stay only on a side branch.
   - The main checkout often has other sessions' uncommitted edits. Never discard them: if a merge touches dirty files, `git stash` → `git merge` → `git stash pop`, and resolve conflicts by keeping both sides.
   - If branches conflict with each other, resolve them (keep both features) rather than leaving one unmerged.
3. In the main checkout: `npx tsc --noEmit`, `npm test`, then `npm run build` (writes `dist/`, which the daemon serves).
4. If anything under `daemon/` changed, restart the daemon: `launchctl kickstart -k gui/$(id -u)/dev.logbook.daemon`
5. Confirm it's live: `curl -s localhost:7777 | grep -o 'index-[^"]*\.js'` matches the bundle `npm run build` just printed.

## The 7777 daemon

- Runs under launchd as `dev.logbook.daemon` (`~/Library/LaunchAgents/dev.logbook.daemon.plist`): `node daemon/server.ts` from the main checkout, KeepAlive, logs in `~/.logbook/daemon.log`.
- Don't start a second copy with `npm start`/`npm run dev`; restart via `launchctl kickstart -k` instead. If it isn't loaded: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.logbook.daemon.plist`.
