#!/bin/bash
# Rebuilds mac/Swarmville.icns from mac/icon.svg (needs Google Chrome; sips and iconutil come with macOS).
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --window-size=1024,1024 --screenshot="$tmp/icon.png" "file://$PWD/icon.svg" >/dev/null 2>&1
mkdir "$tmp/Swarmville.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$tmp/icon.png" --out "$tmp/Swarmville.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$tmp/icon.png" --out "$tmp/Swarmville.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$tmp/Swarmville.iconset" -o Swarmville.icns
cp "$tmp/icon.png" "${1:-/dev/null}" 2>/dev/null || true
echo "Wrote mac/Swarmville.icns"
