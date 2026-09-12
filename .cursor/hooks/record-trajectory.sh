#!/usr/bin/env bash
# Fail-open Cursor hook: record observable agent events into OpenLeaf papers.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export OPENLEAF_REPO_ROOT="$ROOT"
cd "$ROOT" || { echo '{}'; exit 0; }

INPUT="$(mktemp -t openleaf-traj.XXXXXX)" || { echo '{}'; exit 0; }
cleanup() { rm -f "$INPUT"; }
trap cleanup EXIT
cat > "$INPUT" || { echo '{}'; exit 0; }

run() { "$@" < "$INPUT"; }

if [[ -f "$ROOT/server/dist/services/cursorTrajectory/cli.js" ]]; then
  if run node "$ROOT/server/dist/services/cursorTrajectory/cli.js"; then
    exit 0
  fi
fi

if [[ -x "$ROOT/node_modules/.bin/tsx" ]]; then
  if run "$ROOT/node_modules/.bin/tsx" "$ROOT/server/src/services/cursorTrajectory/cli.ts"; then
    exit 0
  fi
fi

if [[ -x "$ROOT/server/node_modules/.bin/tsx" ]]; then
  if run "$ROOT/server/node_modules/.bin/tsx" "$ROOT/server/src/services/cursorTrajectory/cli.ts"; then
    exit 0
  fi
fi

echo '{}'
exit 0
