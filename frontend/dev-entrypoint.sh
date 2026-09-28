#!/bin/sh
set -eu

DEPENDENCY_STAMP="node_modules/.speak-note-dependencies"
DEPENDENCY_CHECKSUM="$(sha256sum package.json package-lock.json | sha256sum | cut -d ' ' -f1)"
INSTALLED_CHECKSUM="$(cat "$DEPENDENCY_STAMP" 2>/dev/null || true)"

if [ "$DEPENDENCY_CHECKSUM" != "$INSTALLED_CHECKSUM" ] || [ ! -x node_modules/.bin/next ]; then
  echo "Frontend dependencies changed; running npm ci..."
  npm ci
  printf '%s\n' "$DEPENDENCY_CHECKSUM" > "$DEPENDENCY_STAMP"
fi

exec npm run dev -- --hostname 0.0.0.0 --webpack
