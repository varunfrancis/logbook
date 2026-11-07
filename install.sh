#!/bin/bash
# Logbook installer: one command, no sudo, no Homebrew, no Node needed beforehand.
#   curl -fsSL https://raw.githubusercontent.com/varunfrancis/logbook/main/install.sh | bash
# Running it again updates Logbook and keeps your town.
#
# What it does:
#   1. Checks this is a Mac.
#   2. Uses Node 24+ if you have it, otherwise downloads a private copy into ~/.logbook/runtime (checked against nodejs.org's checksums).
#   3. Downloads the latest Logbook release into ~/.logbook/app.
#   4. Connects it to Claude Code (hooks in ~/.claude/settings.json, backed up first), starts it at login, opens your town.
#
# Options (environment variables, mostly for testing):
#   LOGBOOK_DATA_DIR      where Logbook lives (default ~/.logbook)
#   LOGBOOK_PORT          default 7777
#   LOGBOOK_RELEASE_URL   a specific logbook.tar.gz (URL or file path) instead of the latest release
#   LOGBOOK_NO_LOGIN_ITEM=1  run in the background now, not at login
#   LOGBOOK_NO_OPEN=1     don't open the browser
#   LOGBOOK_NO_VSCODE=1   skip the VS Code helper
#   LOGBOOK_FORCE=1       install even if a developer copy is already set up as the login item
set -euo pipefail

REPO="varunfrancis/logbook"
DATA="${LOGBOOK_DATA_DIR:-$HOME/.logbook}"
PORT="${LOGBOOK_PORT:-7777}"
RELEASE_URL="${LOGBOOK_RELEASE_URL:-https://github.com/$REPO/releases/latest/download/logbook.tar.gz}"
PLIST="$HOME/Library/LaunchAgents/dev.logbook.daemon.plist"

# Colors only in a real terminal; Claude Code and logs get plain text.
if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; N=$'\033[0m'; else G=''; R=''; N=''; fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
info() { printf '  → %s\n' "$1"; }
fail() { printf '\n  %s✗%s %s\n\n' "$R" "$N" "$1" >&2; exit 1; }

echo
echo "  Installing Logbook"
echo

# 1. A Mac
[ "$(uname -s)" = "Darwin" ] || fail "Logbook works on macOS for now. This computer is $(uname -s)."
case "$(uname -m)" in
  arm64) ARCH=arm64; ok "Mac with Apple silicon" ;;
  x86_64) ARCH=x64; ok "Mac with an Intel chip" ;;
  *) fail "Unrecognized Mac chip: $(uname -m)" ;;
esac
command -v curl >/dev/null || fail "curl is missing, which is unusual on a Mac."

# A developer copy already set up as the login item stays in charge unless asked otherwise.
if [ -z "${LOGBOOK_DATA_DIR:-}" ] && [ -z "${LOGBOOK_NO_LOGIN_ITEM:-}" ] && [ -z "${LOGBOOK_FORCE:-}" ] && [ -f "$PLIST" ] && ! grep -q "$DATA/app/" "$PLIST"; then
  fail "Logbook is already set up from a developer copy ($(grep -o '/[^<]*daemon/server.ts' "$PLIST" | head -1)). Update that copy with git, or rerun with LOGBOOK_FORCE=1 to switch to the installed version."
fi

# The port: free, or already ours (an update)
running=""
if curl -fs -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then running=1
elif lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Something else is using port $PORT. Close it, or install on another port: LOGBOOK_PORT=7788 (then open http://localhost:7788)."
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
    NODE="$RUNTIME/node/bin/node"; ok "Using Logbook's private Node $("$NODE" -v)"
  else
    info "Downloading a private copy of Node 24 (only Logbook uses it)…"
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

# 3. Logbook itself, swapped in whole so a failed download never leaves half an app
info "Downloading Logbook…"
pkg="$(mktemp -d)"
if [ -f "$RELEASE_URL" ]; then cp "$RELEASE_URL" "$pkg/logbook.tar.gz"
else curl -fsSL "$RELEASE_URL" -o "$pkg/logbook.tar.gz" || fail "Downloading Logbook failed. Check your internet connection and try again."; fi
rm -rf "$DATA/app.new" && mkdir -p "$DATA/app.new"
tar -xzf "$pkg/logbook.tar.gz" -C "$DATA/app.new" --strip-components 1 || fail "The Logbook download was damaged. Try again."
rm -rf "$pkg"
[ -f "$DATA/app.new/daemon/server.ts" ] && [ -f "$DATA/app.new/web/dist/index.html" ] || fail "The Logbook download is missing files. Try again."
rm -rf "$DATA/app.old"; [ -d "$DATA/app" ] && mv "$DATA/app" "$DATA/app.old"
mv "$DATA/app.new" "$DATA/app" && rm -rf "$DATA/app.old"
VERSION="$("$NODE" -p "require('$DATA/app/package.json').version")"
ok "Downloaded Logbook $VERSION"

# A test install replaces the background copy it started last time.
if [ -n "$running" ] && [ -n "${LOGBOOK_NO_LOGIN_ITEM:-}" ]; then
  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true; sleep 1
fi

# The `logbook` command
mkdir -p "$DATA/bin"
{
  echo '#!/bin/sh'
  [ -n "${LOGBOOK_DATA_DIR:-}" ] && echo "export LOGBOOK_DATA_DIR='$DATA'"
  [ -n "${LOGBOOK_PORT:-}" ] && echo "export LOGBOOK_PORT='$PORT'"
  echo "exec '$NODE' --no-warnings '$DATA/app/bin/logbook.ts' \"\$@\""
} > "$DATA/bin/logbook"
chmod +x "$DATA/bin/logbook"

# 4. Connect to Claude Code, start, open
flags=""
[ -n "${LOGBOOK_NO_LOGIN_ITEM:-}" ] && flags="$flags --no-login-item"
[ -n "${LOGBOOK_NO_OPEN:-}" ] && flags="$flags --no-open"
[ -n "${LOGBOOK_NO_VSCODE:-}" ] && flags="$flags --no-vscode"
echo
# shellcheck disable=SC2086
"$NODE" --no-warnings "$DATA/app/bin/logbook.ts" install $flags || fail "Setup didn't finish. The details are above."

# Friendly names come from the small Claude model, through the user's own Claude Code.
echo
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then
  ok "Claude Code found: your buildings will get friendly names"
elif ls "$HOME/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude >/dev/null 2>&1; then
  ok "Using the Claude desktop app for friendly building names"
else
  info "Optional: Logbook can give your projects friendly names using Claude Code's command-line tool, which isn't on this Mac."
  info "To add it (Anthropic's official installer): curl -fsSL https://claude.ai/install.sh | bash"
fi

echo
ok "Logbook $VERSION is running at http://localhost:$PORT"
echo "    Manage it with: $DATA/bin/logbook status | update | uninstall"
echo
