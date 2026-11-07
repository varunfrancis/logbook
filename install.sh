#!/bin/bash
# Swarmville installer: one command, no sudo, no Homebrew, no Node needed beforehand.
#   curl -fsSL https://raw.githubusercontent.com/varunfrancis/swarmville/main/install.sh | bash
# Running it again updates Swarmville and keeps your town.
#
# What it does:
#   1. Checks this is a Mac.
#   2. Uses Node 24+ if you have it, otherwise downloads a private copy into ~/.swarmville/runtime (checked against nodejs.org's checksums).
#   3. Downloads the latest Swarmville release into ~/.swarmville/app.
#   4. Connects it to Claude Code (hooks in ~/.claude/settings.json, backed up first), starts it at login, opens your town.
#   5. Adds a Swarmville app to Applications (and the Dock) that opens your town, restarting Swarmville if it's stuck.
#
# Swarmville used to be called Logbook and lived in ~/.logbook. An install from then is moved to ~/.swarmville, town
# and all, and ~/.logbook is left as a link to it so anything still using the old path keeps working.
#
# Options (environment variables, mostly for testing; the old LOGBOOK_* names still work):
#   SWARMVILLE_DATA_DIR      where Swarmville lives (default ~/.swarmville)
#   SWARMVILLE_PORT          default 7777; if another app has 7777, the installer picks the next free port (up to 7799) itself
#   SWARMVILLE_RELEASE_URL   a specific swarmville.tar.gz (URL or file path) instead of the latest release
#   SWARMVILLE_NO_LOGIN_ITEM=1  run in the background now, not at login
#   SWARMVILLE_NO_OPEN=1     don't open the browser
#   SWARMVILLE_NO_VSCODE=1   skip the VS Code helper
#   SWARMVILLE_NO_APP=1      don't add the Swarmville app to Applications
#   SWARMVILLE_NO_DOCK=1     add the app, but don't pin it to the Dock
#   SWARMVILLE_APP_DIR       where the app goes (default /Applications, or ~/Applications if that isn't writable)
#   SWARMVILLE_FORCE=1       install even if a developer copy is already set up as the login item
set -euo pipefail

for v in DATA_DIR PORT RELEASE_URL NO_LOGIN_ITEM NO_OPEN NO_VSCODE NO_APP NO_DOCK APP_DIR FORCE; do
  old="LOGBOOK_$v"; new="SWARMVILLE_$v"
  if [ -z "${!new:-}" ] && [ -n "${!old:-}" ]; then export "$new=${!old}"; fi
done

REPO="varunfrancis/swarmville"
DATA="${SWARMVILLE_DATA_DIR:-$HOME/.swarmville}"
LEGACY="$HOME/.logbook"
# An earlier install that moved off 7777 (because something else had it) keeps its port across updates.
ASKED_PORT="${SWARMVILLE_PORT:-}"
if [ -z "$ASKED_PORT" ]; then
  for w in "$DATA/bin/swarmville" "$LEGACY/bin/swarmville"; do
    [ -f "$w" ] || continue
    p="$(sed -n "s/^export SWARMVILLE_PORT='\([0-9]*\)'$/\1/p" "$w" | head -1)" || p=""
    if [ -n "$p" ]; then export SWARMVILLE_PORT="$p"; break; fi
  done
fi
PORT="${SWARMVILLE_PORT:-7777}"
RELEASE_URL="${SWARMVILLE_RELEASE_URL:-https://github.com/$REPO/releases/latest/download/swarmville.tar.gz}"
PLIST="$HOME/Library/LaunchAgents/dev.swarmville.daemon.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/dev.logbook.daemon.plist"

# Colors only in a real terminal; Claude Code and logs get plain text.
if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; N=$'\033[0m'; else G=''; R=''; N=''; fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
info() { printf '  → %s\n' "$1"; }
fail() { printf '\n  %s✗%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

echo
echo "  Installing Swarmville"
echo

# 1. A Mac
[ "$(uname -s)" = "Darwin" ] || fail "Swarmville works on macOS for now. This computer is $(uname -s)."
case "$(uname -m)" in
  arm64) ARCH=arm64; ok "Mac with Apple silicon" ;;
  x86_64) ARCH=x64; ok "Mac with an Intel chip" ;;
  *) fail "Unrecognized Mac chip: $(uname -m)" ;;
esac
command -v curl >/dev/null || fail "curl is missing, which is unusual on a Mac."

# A developer copy already set up as the login item stays in charge unless asked otherwise.
if [ -z "${SWARMVILLE_DATA_DIR:-}" ] && [ -z "${SWARMVILLE_NO_LOGIN_ITEM:-}" ] && [ -z "${SWARMVILLE_FORCE:-}" ]; then
  for p in "$PLIST" "$LEGACY_PLIST"; do
    if [ -f "$p" ] && ! grep -q -e "$DATA/app/" -e "$LEGACY/app/" "$p"; then
      fail "Swarmville is already set up from a developer copy ($(grep -o '/[^<]*daemon/server.ts' "$p" | head -1)). Update that copy with git, or rerun with SWARMVILLE_FORCE=1 to switch to the installed version."
    fi
  done
fi

# The port: free, already ours (an update), or taken by another app. If another app has it and no port was asked
# for, Swarmville moves to the next free one and says so; the Swarmville app and `swarmville` command follow it.
busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
who() { local pid; pid="$(lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1)"; [ -n "$pid" ] && basename "$(ps -p "$pid" -o comm= 2>/dev/null)" || true; }
running=""
if curl -fs -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then running=1
elif busy "$PORT"; then
  app="$(who "$PORT")"; app="${app:-another app}"
  [ -z "$ASKED_PORT" ] || fail "Port $PORT is being used by $app. Close $app, or pick another port, e.g. SWARMVILLE_PORT=$((PORT + 1))."
  moved=""
  for p in $(seq 7777 7799); do
    if ! busy "$p"; then
      info "Port $PORT is being used by $app, so Swarmville will use $p instead (your Swarmville icon opens it)."
      PORT="$p"; export SWARMVILLE_PORT="$p"; moved=1; break
    fi
  done
  [ -n "$moved" ] || fail "Ports 7777 to 7799 are all in use, starting with $app. Close $app and run the installer again."
fi

# The app is fetched first (unpacked in step 3), so a failed download leaves an existing install exactly as it was.
info "Downloading Swarmville…"
pkg="$(mktemp -d)"
if [ -f "$RELEASE_URL" ]; then cp "$RELEASE_URL" "$pkg/swarmville.tar.gz"
else curl -fsSL "$RELEASE_URL" -o "$pkg/swarmville.tar.gz" || fail "Downloading Swarmville failed. Check your internet connection and try again."; fi

# An install from before the rename (~/.logbook): stop it, then move it to its new home with a link left behind.
if [ -z "${SWARMVILLE_DATA_DIR:-}" ] && [ -d "$LEGACY" ] && [ ! -L "$LEGACY" ]; then
  if [ -d "$DATA" ] && [ -z "$(ls -A "$DATA")" ]; then rmdir "$DATA"; fi
  if [ -e "$DATA" ]; then
    info "Found both $LEGACY and $DATA; leaving $LEGACY as it is."
  else
    if [ -f "$LEGACY_PLIST" ]; then launchctl bootout "gui/$(id -u)/dev.logbook.daemon" >/dev/null 2>&1 || true; sleep 1; fi
    mv "$LEGACY" "$DATA" && ln -s "$DATA" "$LEGACY"
    if [ -e "$DATA/logbook.db" ] && [ ! -e "$DATA/swarmville.db" ]; then
      for ext in "" -wal -shm; do if [ -e "$DATA/logbook.db$ext" ]; then mv "$DATA/logbook.db$ext" "$DATA/swarmville.db$ext"; fi; done
    fi
    ok "Moved your town from $LEGACY to $DATA (Logbook is now Swarmville)"
  fi
fi

mkdir -p "$DATA"

# 2. Node 24 or newer
NODE=""
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -ge 24 ]; then NODE="$(command -v node)"; ok "Using Node $(node -v) already on this Mac"; fi
fi
if [ -z "$NODE" ]; then
  RUNTIME="$DATA/runtime"
  if [ -x "$RUNTIME/node/bin/node" ] && [ "$("$RUNTIME/node/bin/node" -p 'process.versions.node.split(".")[0]')" -ge 24 ]; then
    NODE="$RUNTIME/node/bin/node"; ok "Using Swarmville's private Node $("$NODE" -v)"
  else
    info "Downloading a private copy of Node 24 (only Swarmville uses it)…"
    base="https://nodejs.org/dist/latest-v24.x"
    sums="$(curl -fsSL "$base/SHASUMS256.txt")" || fail "Couldn't reach nodejs.org. Check your internet connection and try again."
    file="$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v24\.[0-9.]+-darwin-$ARCH\.tar\.gz$" | head -1)"
    [ -n "$file" ] || fail "Couldn't find Node 24 for this Mac on nodejs.org."
    want="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "$base/$file" -o "$tmp/node.tar.gz" || fail "Downloading Node failed. Try again in a minute."
    got="$(shasum -a 256 "$tmp/node.tar.gz" | awk '{print $1}')"
    [ "$got" = "$want" ] || fail "The Node download didn't match nodejs.org's checksum, so it wasn't used. Try again."
    mkdir -p "$tmp/node" && tar -xzf "$tmp/node.tar.gz" -C "$tmp/node" --strip-components 1
    rm -rf "$RUNTIME/node.new" && mkdir -p "$RUNTIME" && mv "$tmp/node" "$RUNTIME/node.new"
    rm -rf "$RUNTIME/node" && mv "$RUNTIME/node.new" "$RUNTIME/node"
    NODE="$RUNTIME/node/bin/node"
    ok "Downloaded a private copy of Node $("$NODE" -v)"
  fi
fi

# 3. Swarmville itself, swapped in whole so a broken download never leaves half an app
rm -rf "$DATA/app.new" && mkdir -p "$DATA/app.new"
tar -xzf "$pkg/swarmville.tar.gz" -C "$DATA/app.new" --strip-components 1 || fail "The Swarmville download was damaged. Try again."
rm -rf "$pkg"
[ -f "$DATA/app.new/daemon/server.ts" ] && [ -f "$DATA/app.new/bin/swarmville.ts" ] && [ -f "$DATA/app.new/web/dist/index.html" ] || fail "The Swarmville download is missing files. Try again."
rm -rf "$DATA/app.old"; [ -d "$DATA/app" ] && mv "$DATA/app" "$DATA/app.old"
mv "$DATA/app.new" "$DATA/app" && rm -rf "$DATA/app.old"
VERSION="$("$NODE" -p "require('$DATA/app/package.json').version")"
ok "Downloaded Swarmville $VERSION"

# A test install replaces the background copy it started last time.
if [ -n "$running" ] && [ -n "${SWARMVILLE_NO_LOGIN_ITEM:-}" ]; then
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true; sleep 1
fi

# The `swarmville` command (`logbook`, its name before the rename, still works)
mkdir -p "$DATA/bin"
{
  echo '#!/bin/sh'
  [ -n "${SWARMVILLE_DATA_DIR:-}" ] && echo "export SWARMVILLE_DATA_DIR='$DATA'"
  [ -n "${SWARMVILLE_PORT:-}" ] && echo "export SWARMVILLE_PORT='$PORT'"
  echo "exec '$NODE' --no-warnings '$DATA/app/bin/swarmville.ts' \"\$@\""
} > "$DATA/bin/swarmville"
chmod +x "$DATA/bin/swarmville"
rm -f "$DATA/bin/logbook" && ln -s swarmville "$DATA/bin/logbook"

# 4. Connect to Claude Code, start, open
flags=""
[ -n "${SWARMVILLE_NO_LOGIN_ITEM:-}" ] && flags="$flags --no-login-item"
[ -n "${SWARMVILLE_NO_OPEN:-}" ] && flags="$flags --no-open"
[ -n "${SWARMVILLE_NO_VSCODE:-}" ] && flags="$flags --no-vscode"
[ -n "${SWARMVILLE_NO_APP:-}" ] && flags="$flags --no-app"
[ -n "${SWARMVILLE_NO_DOCK:-}" ] && flags="$flags --no-dock"
echo
# shellcheck disable=SC2086
"$NODE" --no-warnings "$DATA/app/bin/swarmville.ts" install $flags || fail "Setup didn't finish. The details are above."

# Friendly names come from the small Claude model, through the user's own Claude Code.
echo
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  ok "Claude Code found: your buildings will get friendly names"
elif ls "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude >/dev/null 2>&1; then
  ok "Using the Claude desktop app for friendly building names"
else
  info "Optional: Swarmville can give your projects friendly names using Claude Code's command-line tool, which isn't on this Mac."
  info "To add it (Anthropic's official installer): curl -fsSL https://claude.ai/install.sh | bash"
fi

echo
ok "Swarmville $VERSION is running at http://localhost:$PORT"
if [ -d "${SWARMVILLE_APP_DIR:-/Applications}/Swarmville.app" ] || [ -d "$HOME/Applications/Swarmville.app" ]; then
  echo "    Next time, just open Swarmville from your Dock, Launchpad or Spotlight. It starts Swarmville again if it ever stops."
fi
echo "    Manage it with: $DATA/bin/swarmville status | update | uninstall"
echo
