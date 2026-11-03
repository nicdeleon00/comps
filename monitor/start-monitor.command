#!/bin/bash
# Double-click on a Mac (or run in a terminal) to start the Comps drop monitor.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is needed: install the LTS version from https://nodejs.org"
  open https://nodejs.org 2>/dev/null
  read -r -p "Press Enter to close"
  exit 1
fi
node monitor.mjs "$@"
