#!/usr/bin/env bash
# plain-tree-upgrade-lane.sh — flair#1109 (a) CI spoke-ritual fixture
#
# Non-launchd, non-global-npm. Builds a packed extract (npm pack shape) plus
# an operator launcher and a systemd user unit, then runs
# `flair upgrade --check --tree` against that tree. Fails unless the command
# takes the in-place tarball-swap lane (fetch / swap / preserve / restart).
#
# Does not start Harper and does not hit the npm registry (fetch is stubbed).
# Pair of macos-launchd-upgrade-lane.sh for the systemd/plain-tree install
# shape. The product lane itself shipped in #1564; this is the CI fixture
# that was missing on main.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
  echo "FAIL: bun is required to run the plain-tree upgrade lane" >&2
  exit 1
fi

# os.homedir() is fixed at process start. Export HOME before bun so the
# user-unit scan and the fixture write the same directory.
if [[ -z "${FLAIR_PLAIN_TREE_LANE_HOME:-}" ]]; then
  FLAIR_PLAIN_TREE_LANE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/flair-plain-tree-lane-home-XXXXXX")"
  export FLAIR_PLAIN_TREE_LANE_HOME
  cleanup_home=1
else
  cleanup_home=0
fi
export HOME="$FLAIR_PLAIN_TREE_LANE_HOME"
mkdir -p "$HOME"

cleanup() {
  if [[ "$cleanup_home" -eq 1 ]]; then
    rm -rf "$FLAIR_PLAIN_TREE_LANE_HOME"
  fi
}
trap cleanup EXIT

bun "$ROOT/scripts/ci/plain-tree-upgrade-lane.ts"
