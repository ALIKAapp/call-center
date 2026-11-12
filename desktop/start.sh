#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org and run this again."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First start: installing, this takes a minute..."
  npm install --no-audit --no-fund
fi
( sleep 2; (command -v open >/dev/null && open http://localhost:3000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000) ) >/dev/null 2>&1 &
node server.js
