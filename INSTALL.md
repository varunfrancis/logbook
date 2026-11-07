# Installing Swarmville (instructions for Claude Code)

Swarmville was called Logbook until recently. If they already have it from then (a `~/.logbook` folder), the installer moves it to `~/.swarmville` and keeps their town, so just follow the steps.

The person who sent you this link wants Swarmville installed on this computer. Follow these steps. Explain things in plain, friendly language: they may not be technical.

## What Swarmville is (tell them this first)

Swarmville shows their Claude Code agents as little characters in a town in the browser: who is working, who needs them, what got shipped. It runs only on this Mac. It reads their Claude Code history (`~/.claude/projects`) and git on this computer, and nothing is uploaded. There's no account and it's free and open source (github.com/varunfrancis/logbook). To give projects friendly names, it asks the small Claude model through their own Claude Code login, which uses a tiny amount of their usage.

## Steps

1. **Check it's a Mac** (`uname -s` prints `Darwin`). If not, tell them Swarmville is Mac-only for now and stop.

2. **Tell them what you're about to do** in a short list, then run the installer:
   - download Swarmville (and, if needed, a private copy of Node, the engine it runs on, about 50 MB) into `~/.swarmville`
   - connect it to Claude Code so new sessions show up live (adds hooks to `~/.claude/settings.json`, with a backup saved next to it)
   - start it now and whenever the Mac starts
   - open their town in the browser

   ```sh
   curl -fsSL https://raw.githubusercontent.com/varunfrancis/logbook/main/install.sh | bash
   ```

   It takes about a minute and prints a ✓ line for each step.

3. **Check it's running:** `curl -s http://localhost:7777/api/health` should print `{"ok":true,...}`.

4. **If the installer said the Claude Code command-line tool is missing**, ask them (don't just do it): "Swarmville can give your projects friendly names like 'Support Bot' using Claude Code's command-line tool. Want me to install it? It's Anthropic's official installer." If they say yes, run `curl -fsSL https://claude.ai/install.sh | bash`. Swarmville works fine without it.

5. **Wrap up** in a few lines:
   - Their town is open at http://localhost:7777 (the browser should already show it). A short welcome tour introduces their agents. It's about two minutes and each step can be skipped.
   - It updates live as they work with Claude Code.
   - Later they can ask you to "update Swarmville" (`~/.swarmville/bin/swarmville update`) or "uninstall Swarmville" (`~/.swarmville/bin/swarmville uninstall --everything`).

## If something goes wrong

| The installer says | What to do |
|---|---|
| Something else is using port 7777 | Ask what's running there. Or install on another port: `curl -fsSL …/install.sh \| SWARMVILLE_PORT=7788 bash`, then open http://localhost:7788 |
| Could not parse `~/.claude/settings.json` | Their Claude Code settings file has a typo. Show them the error, fix the JSON with their OK, then rerun the installer |
| Couldn't reach nodejs.org / Downloading Swarmville failed | Check the internet connection and rerun. It's safe to run again |
| Already set up from a developer copy | They run Swarmville from source already. Leave it alone unless they ask to switch (`SWARMVILLE_FORCE=1`) |

If VS Code isn't installed, that's fine: Swarmville opens agents in Terminal instead.
