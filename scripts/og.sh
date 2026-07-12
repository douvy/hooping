#!/bin/sh
# Captures the social unfurl card into app/. Needs `pnpm dev` running:
# the card is painted by the game's own canvas code at /?og (dev-only
# hook in components/Hoop.tsx), so the unfurl ages with the art.
#
# usage: sh scripts/og.sh [port]
set -e
PORT="${1:-3000}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --hide-scrollbars --window-size=1200,630 \
  --screenshot="app/opengraph-image.png" \
  --virtual-time-budget=8000 \
  "http://localhost:$PORT/?og" 2>/dev/null
cp app/opengraph-image.png app/twitter-image.png
echo "wrote app/opengraph-image.png + app/twitter-image.png"
